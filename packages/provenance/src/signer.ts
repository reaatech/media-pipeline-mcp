import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createSign,
  sign as cryptoSign,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProvenanceSigningFailedError } from '@reaatech/media-pipeline-mcp-core';
import type { ProvenanceConfig, ProvenanceManifest, SigningKeyConfig } from './types.js';

/**
 * Provenance signing (F17).
 *
 * Built-in implementation supports all four key sources:
 *   - 'pem-inline' / 'pem-file': Node's native crypto (ES256/ES384/PS256/Ed25519)
 *   - 'aws-kms': @aws-sdk/client-kms (optional peer dep, dynamic-imported)
 *   - 'gcp-kms': @google-cloud/kms (optional peer dep, dynamic-imported)
 *   - 'azure-key-vault': @azure/keyvault-keys + @azure/identity (optional peer deps)
 *
 * Output format depends on embedMode:
 *   - 'sidecar' (default): data: URI containing a signed JSON sidecar manifest
 *   - 'in-file': c2pa-node embedding into the artifact bytes (requires storage handle)
 *   - 'both': both
 *
 * For in-file embedding, the signer must be constructed with `storage` so it can
 * read artifact bytes and write the embedded result. Without storage, 'in-file'
 * silently falls back to 'sidecar' with a warning.
 *
 * History: a prior implementation embedded an HMAC-SHA256 secret in source and
 * called the result "C2PA-signed." That is *not* C2PA and produced fake signatures
 * downstream consumers might trust. It was removed. The current signer uses real
 * asymmetric crypto with caller-supplied or KMS-managed keys.
 */

/**
 * Minimal storage surface the signer needs for in-file embedding. Matches the
 * shape of @reaatech/media-pipeline-mcp-storage's ArtifactStore without creating
 * a cross-package dep (the signer should stay lean).
 */
export interface SignerStorage {
  get(id: string): Promise<{
    data: Buffer | unknown;
    meta: { id: string; mimeType: string; type: string; metadata?: Record<string, unknown> };
  }>;
  put(
    id: string,
    data: Buffer | unknown,
    meta: { id: string; type: string; mimeType: string; metadata?: Record<string, unknown> },
  ): Promise<string>;
}

export interface SignerOptions {
  /**
   * Optional storage handle. Required for embedMode='in-file' or 'both'. When
   * omitted, in-file requests degrade to sidecar with a console.warn.
   */
  storage?: SignerStorage;
}

export class ProvenanceSigner {
  private cachedPemKey?: { key: KeyObject; loadedAt: number };
  private storage?: SignerStorage;

  constructor(
    private config: ProvenanceConfig,
    opts?: SignerOptions,
  ) {
    this.storage = opts?.storage;
  }

  async sign(
    artifactId: string,
    manifest: ProvenanceManifest,
  ): Promise<{ signedArtifactId: string; manifestUri: string }> {
    if (!this.config.enabled) {
      return { signedArtifactId: artifactId, manifestUri: '' };
    }

    // Consumer-supplied signer wins — they may implement their own c2pa-node, KMS,
    // or HSM flow. The built-in implementation below is a sensible default.
    if (this.config.customSigner) {
      return this.config.customSigner({ artifactId, manifest, config: this.config });
    }

    const canonical = canonicalizeManifest(manifest);
    const canonicalBytes = Buffer.from(canonical, 'utf8');
    const algorithm = this.config.signingKey.algorithm;
    const digest = createHash(hashForAlgorithm(algorithm)).update(canonicalBytes).digest();

    let signature: Buffer;
    try {
      signature = await this.signDigest(this.config.signingKey, canonicalBytes, digest);
    } catch (err) {
      if (err instanceof ProvenanceSigningFailedError) throw err;
      throw new ProvenanceSigningFailedError(
        `Signing failed with key source '${this.config.signingKey.source.kind}' / algorithm '${algorithm}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const embedMode = this.config.embedMode ?? 'sidecar';
    const wantsInFile = embedMode === 'in-file' || embedMode === 'both';
    const wantsSidecar = embedMode === 'sidecar' || embedMode === 'both';

    let signedArtifactId = artifactId;
    let inFileEmbedded = false;

    if (wantsInFile) {
      if (!this.storage) {
        console.warn(
          `ProvenanceSigner: embedMode='${embedMode}' requested but no storage handle was provided. Falling back to sidecar-only. Pass { storage } to the constructor to enable in-file embedding.`,
        );
      } else {
        try {
          const result = await this.embedInFile(artifactId, manifest, signature, algorithm);
          signedArtifactId = result.signedArtifactId;
          inFileEmbedded = true;
        } catch (err) {
          if (embedMode === 'in-file') {
            // Strict in-file mode: surface the error rather than silently
            // dropping to sidecar (which would mislead callers about what was
            // actually produced).
            throw new ProvenanceSigningFailedError(
              `In-file embedding failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          // 'both' mode: log and continue with sidecar-only.
          console.warn(
            `ProvenanceSigner: in-file embedding failed in 'both' mode; sidecar still produced. ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    if (!wantsSidecar && inFileEmbedded) {
      // Pure in-file mode succeeded: return a c2pa:// URI pointing at the new artifact.
      return { signedArtifactId, manifestUri: `c2pa://${signedArtifactId}` };
    }

    const sidecar = {
      version: 1,
      type: 'application/c2pa-sidecar+json',
      algorithm,
      manifest,
      canonicalManifestSha256: createHash('sha256').update(canonicalBytes).digest('hex'),
      signature: signature.toString('base64'),
      signedAt: new Date().toISOString(),
      embedMode,
      embedded: inFileEmbedded,
    };
    const sidecarJson = JSON.stringify(sidecar);
    const manifestUri = `data:application/c2pa-sidecar+json;base64,${Buffer.from(sidecarJson, 'utf8').toString('base64')}`;

    return { signedArtifactId, manifestUri };
  }

  // ─── Signing strategies ──────────────────────────────────────────────────

  private async signDigest(
    cfg: SigningKeyConfig,
    canonical: Buffer,
    digest: Buffer,
  ): Promise<Buffer> {
    switch (cfg.source.kind) {
      case 'pem-inline':
      case 'pem-file':
        return signWithPem(await this.resolvePemKey(cfg), canonical, cfg.algorithm);
      case 'aws-kms':
        return signWithAwsKms(cfg.source, digest, cfg.algorithm);
      case 'gcp-kms':
        return signWithGcpKms(cfg.source, digest, cfg.algorithm);
      case 'azure-key-vault':
        return signWithAzureKeyVault(cfg.source, digest, cfg.algorithm);
    }
  }

  private async resolvePemKey(cfg: SigningKeyConfig): Promise<KeyObject> {
    const ttl = cfg.cacheTtlMs ?? 5 * 60 * 1000;
    if (this.cachedPemKey && Date.now() - this.cachedPemKey.loadedAt < ttl) {
      return this.cachedPemKey.key;
    }

    let pem: string;
    if (cfg.source.kind === 'pem-inline') {
      pem = cfg.source.privateKey;
    } else if (cfg.source.kind === 'pem-file') {
      try {
        pem = await readFile(cfg.source.path, 'utf8');
      } catch (err) {
        throw new ProvenanceSigningFailedError(
          `Failed to read PEM private key from ${cfg.source.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      throw new Error(
        `resolvePemKey called with non-PEM source: ${(cfg.source as { kind: string }).kind}`,
      );
    }

    let key: KeyObject;
    try {
      key = createPrivateKey(pem);
    } catch (err) {
      throw new ProvenanceSigningFailedError(
        `Failed to parse PEM private key: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.cachedPemKey = { key, loadedAt: Date.now() };
    return key;
  }

  // ─── In-file embedding (c2pa-node) ───────────────────────────────────────

  private async embedInFile(
    artifactId: string,
    manifest: ProvenanceManifest,
    signature: Buffer,
    algorithm: SigningKeyConfig['algorithm'],
  ): Promise<{ signedArtifactId: string }> {
    if (!this.storage) {
      throw new Error('embedInFile called without storage handle');
    }

    // Dynamic import: c2pa-node is a heavy native binding (~50MB binaries per
    // platform). Only deployments that actually want in-file embedding pay the
    // install cost. String-variable indirection keeps TS from resolving at
    // compile time so the provenance package builds without c2pa-node installed.
    const moduleName: string = 'c2pa-node';
    let c2paMod: { createC2pa: (opts?: unknown) => unknown };
    try {
      c2paMod = (await import(moduleName)) as { createC2pa: (opts?: unknown) => unknown };
    } catch {
      throw new Error(
        "embedMode='in-file' requires the 'c2pa-node' peer dependency. Install with: pnpm add c2pa-node",
      );
    }

    // Load the source artifact bytes.
    const original = await this.storage.get(artifactId);
    const sourceBuf = original.data as Buffer;
    if (!Buffer.isBuffer(sourceBuf)) {
      throw new Error(
        `Storage returned non-Buffer data for artifact ${artifactId}; in-file embedding requires Buffer`,
      );
    }

    // c2pa-node's signing API expects a signer callback. We've already produced the
    // signature over the canonical manifest above, but c2pa-node prefers to control
    // the canonicalization itself. We give it a Signer object that signs whatever
    // bytes it asks us to (typically the COSE payload).
    const c2pa = (
      c2paMod.createC2pa as (opts?: unknown) => {
        sign: (opts: {
          asset: { buffer: Buffer; mimeType: string };
          manifest: unknown;
        }) => Promise<{ signedAsset: { buffer: Buffer; mimeType: string }; manifest: unknown }>;
      }
    )({
      // The c2pa-node Signer interface — we delegate back into our own
      // signDigest() so the same key material is used everywhere.
      signer: {
        type: 'local',
        certificates:
          this.config.signingKey.source.kind === 'pem-inline'
            ? [(this.config.signingKey.source as { certificate?: string }).certificate ?? '']
            : [],
        alg: c2paAlgFor(algorithm),
        async sign(payload: Buffer): Promise<Buffer> {
          // Re-sign the c2pa payload with the same key. We can't reuse the
          // pre-computed `signature` because c2pa hashes its own canonical form.
          // For PEM keys this is a synchronous local crypto call; for KMS it
          // round-trips to the cloud.
          const dgst = createHash(hashForAlgorithm(algorithm)).update(payload).digest();
          // Call back into the outer signer via closure on `this` below.
          return await self.signDigest(self.config.signingKey, payload, dgst);
        },
      },
    });

    // Closure indirection so the c2pa-node sign callback can reach back into us.
    const self = this;
    void self; // silence linter

    const result = await c2pa.sign({
      asset: { buffer: sourceBuf, mimeType: original.meta.mimeType },
      manifest: {
        title: manifest.title,
        format: manifest.format,
        claim_generator: manifest.claimGenerator,
        assertions: manifest.assertions.map((a) => ({ label: a.kind, data: a })),
        ingredients: manifest.ingredients ?? [],
      },
    });

    // Persist the embedded artifact under a new ID.
    const signedId = `${artifactId}-c2pa`;
    await this.storage.put(signedId, result.signedAsset.buffer, {
      id: signedId,
      type: original.meta.type,
      mimeType: result.signedAsset.mimeType,
      metadata: {
        ...(original.meta.metadata ?? {}),
        c2pa: { signedFrom: artifactId, algorithm, signedAt: new Date().toISOString() },
      },
    });

    // signature param is unused here — c2pa-node produced its own — but the call
    // signature is kept for symmetry with the sidecar path. Suppress the warning.
    void signature;

    return { signedArtifactId: signedId };
  }
}

// ─── PEM signing ────────────────────────────────────────────────────────────

function signWithPem(
  key: KeyObject,
  data: Buffer,
  algorithm: SigningKeyConfig['algorithm'],
): Buffer {
  switch (algorithm) {
    case 'es256':
      return createSign('sha256').update(data).sign({ key, dsaEncoding: 'ieee-p1363' });
    case 'es384':
      return createSign('sha384').update(data).sign({ key, dsaEncoding: 'ieee-p1363' });
    case 'ps256':
      return createSign('sha256')
        .update(data)
        .sign({ key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 });
    case 'ed25519':
      return Buffer.from(cryptoSign(null, data, key));
  }
}

// ─── AWS KMS ────────────────────────────────────────────────────────────────

async function signWithAwsKms(
  source: { kind: 'aws-kms'; keyId: string; certPath: string; region?: string },
  digest: Buffer,
  algorithm: SigningKeyConfig['algorithm'],
): Promise<Buffer> {
  // String-indirected dynamic import keeps the AWS SDK out of the build graph
  // for deployments that don't use KMS.
  const moduleName: string = '@aws-sdk/client-kms';
  let kms: {
    KMSClient: new (opts: { region?: string }) => {
      send: (cmd: unknown) => Promise<{ Signature?: Uint8Array }>;
    };
    SignCommand: new (opts: {
      KeyId: string;
      Message: Uint8Array;
      MessageType: 'DIGEST';
      SigningAlgorithm: string;
    }) => unknown;
  };
  try {
    kms = (await import(moduleName)) as never;
  } catch {
    throw new ProvenanceSigningFailedError(
      "Key source 'aws-kms' requires the '@aws-sdk/client-kms' peer dependency. Install with: pnpm add @aws-sdk/client-kms",
    );
  }

  const client = new kms.KMSClient({ region: source.region });
  const command = new kms.SignCommand({
    KeyId: source.keyId,
    Message: new Uint8Array(digest),
    MessageType: 'DIGEST',
    SigningAlgorithm: awsKmsAlgorithm(algorithm),
  });
  const response = await client.send(command);
  if (!response.Signature) {
    throw new ProvenanceSigningFailedError(
      `AWS KMS Sign returned no Signature for keyId ${source.keyId}`,
    );
  }
  return Buffer.from(response.Signature);
}

function awsKmsAlgorithm(algorithm: SigningKeyConfig['algorithm']): string {
  switch (algorithm) {
    case 'es256':
      return 'ECDSA_SHA_256';
    case 'es384':
      return 'ECDSA_SHA_384';
    case 'ps256':
      return 'RSASSA_PSS_SHA_256';
    case 'ed25519':
      // AWS KMS does not currently support Ed25519. Surface this clearly so the
      // user can pick a different algorithm rather than getting a cryptic
      // ValidationException from the AWS side.
      throw new ProvenanceSigningFailedError(
        'AWS KMS does not support Ed25519 signing. Use es256/es384/ps256, or switch to a PEM key source for Ed25519.',
      );
  }
}

// ─── GCP KMS ────────────────────────────────────────────────────────────────

async function signWithGcpKms(
  source: { kind: 'gcp-kms'; keyName: string; certPath: string },
  digest: Buffer,
  algorithm: SigningKeyConfig['algorithm'],
): Promise<Buffer> {
  const moduleName: string = '@google-cloud/kms';
  let kms: {
    KeyManagementServiceClient: new () => {
      asymmetricSign: (req: {
        name: string;
        digest: Record<string, Uint8Array>;
      }) => Promise<[{ signature?: Uint8Array }]>;
    };
  };
  try {
    kms = (await import(moduleName)) as never;
  } catch {
    throw new ProvenanceSigningFailedError(
      "Key source 'gcp-kms' requires the '@google-cloud/kms' peer dependency. Install with: pnpm add @google-cloud/kms",
    );
  }

  const client = new kms.KeyManagementServiceClient();
  const digestField = gcpDigestField(algorithm);
  const [response] = await client.asymmetricSign({
    name: source.keyName,
    digest: { [digestField]: new Uint8Array(digest) },
  });
  if (!response.signature) {
    throw new ProvenanceSigningFailedError(
      `GCP KMS asymmetricSign returned no signature for keyName ${source.keyName}`,
    );
  }
  return Buffer.from(response.signature);
}

function gcpDigestField(algorithm: SigningKeyConfig['algorithm']): string {
  switch (algorithm) {
    case 'es256':
    case 'ps256':
      return 'sha256';
    case 'es384':
      return 'sha384';
    case 'ed25519':
      // GCP KMS Ed25519 keys take raw data, not a digest field. We surface the
      // mismatch rather than silently double-hashing.
      throw new ProvenanceSigningFailedError(
        'GCP KMS Ed25519 keys require raw-message signing, not pre-hashed digests. ' +
          'The built-in signer pre-hashes by design; use a PEM key source for Ed25519 with GCP KMS, ' +
          'or wire customSigner.',
      );
  }
}

// ─── Azure Key Vault ────────────────────────────────────────────────────────

async function signWithAzureKeyVault(
  source: { kind: 'azure-key-vault'; vaultUrl: string; keyName: string; certPath: string },
  digest: Buffer,
  algorithm: SigningKeyConfig['algorithm'],
): Promise<Buffer> {
  // Azure SDK is split into two packages: keyvault-keys (the client) and
  // identity (credential providers). Both are required.
  const keysMod: string = '@azure/keyvault-keys';
  const idMod: string = '@azure/identity';
  let keyvault: {
    KeyClient: new (
      vaultUrl: string,
      credential: unknown,
    ) => {
      getKey: (name: string) => Promise<{ id?: string }>;
    };
    CryptographyClient: new (
      keyId: string,
      credential: unknown,
    ) => {
      sign: (alg: string, data: Uint8Array) => Promise<{ result: Uint8Array }>;
    };
  };
  let identity: { DefaultAzureCredential: new () => unknown };
  try {
    keyvault = (await import(keysMod)) as never;
    identity = (await import(idMod)) as never;
  } catch {
    throw new ProvenanceSigningFailedError(
      "Key source 'azure-key-vault' requires '@azure/keyvault-keys' and '@azure/identity' peer dependencies. " +
        'Install with: pnpm add @azure/keyvault-keys @azure/identity',
    );
  }

  const credential = new identity.DefaultAzureCredential();
  const client = new keyvault.KeyClient(source.vaultUrl, credential);
  const keyHandle = await client.getKey(source.keyName);
  if (!keyHandle.id) {
    throw new ProvenanceSigningFailedError(`Azure Key Vault key ${source.keyName} returned no id`);
  }

  const crypto = new keyvault.CryptographyClient(keyHandle.id, credential);
  const sig = await crypto.sign(azureKvAlgorithm(algorithm), new Uint8Array(digest));
  return Buffer.from(sig.result);
}

function azureKvAlgorithm(algorithm: SigningKeyConfig['algorithm']): string {
  switch (algorithm) {
    case 'es256':
      return 'ES256';
    case 'es384':
      return 'ES384';
    case 'ps256':
      return 'PS256';
    case 'ed25519':
      // Azure Key Vault supports EdDSA on Managed HSM only and the algorithm
      // name is 'EdDSA'. Standard Key Vault does not. Surface the limitation
      // explicitly so users can pick the right vault tier.
      throw new ProvenanceSigningFailedError(
        "Azure Key Vault standard tier does not support Ed25519. Use Managed HSM (algorithm 'EdDSA'), or pick ES256/ES384/PS256.",
      );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function canonicalizeManifest(manifest: ProvenanceManifest): string {
  return JSON.stringify(manifest, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
}

function hashForAlgorithm(algorithm: SigningKeyConfig['algorithm']): string {
  switch (algorithm) {
    case 'es256':
    case 'ps256':
      return 'sha256';
    case 'es384':
      return 'sha384';
    case 'ed25519':
      // Ed25519 doesn't pre-hash, but we still compute SHA-256 for the sidecar
      // canonicalManifestSha256 field. The actual signing path ignores the
      // digest and signs raw bytes.
      return 'sha256';
  }
}

function c2paAlgFor(algorithm: SigningKeyConfig['algorithm']): string {
  // c2pa-node's algorithm names mirror the COSE algorithm registry.
  switch (algorithm) {
    case 'es256':
      return 'es256';
    case 'es384':
      return 'es384';
    case 'ps256':
      return 'ps256';
    case 'ed25519':
      return 'ed25519';
  }
}
