# @reaatech/media-pipeline-mcp-provenance

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-provenance)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provenance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

C2PA content provenance signing for AI-generated media. Embeds tamper-evident manifests naming the model, pipeline DAG, and operator. Supports sidecar JSON manifests and in-file C2PA embedding via c2pa-node, with signing keys from PEM files, AWS KMS, GCP KMS, or Azure Key Vault.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-provenance
```

```bash
pnpm add @reaatech/media-pipeline-mcp-provenance
```

Cloud key sources and in-file embedding require optional peer dependencies:

```bash
# AWS KMS signing
pnpm add @aws-sdk/client-kms

# GCP KMS signing
pnpm add @google-cloud/kms

# Azure Key Vault signing
pnpm add @azure/keyvault-keys @azure/identity

# In-file C2PA embedding
pnpm add c2pa-node
```

## Feature Overview

- C2PA-compliant manifest generation with assertions, ingredients, and pipeline references
- Four signing key sources: PEM file/inline, AWS KMS, GCP KMS, Azure Key Vault
- Multiple signature algorithms: ES256, ES384, PS256, Ed25519
- Two embedding modes: sidecar (data URI JSON) and in-file (c2pa-node JUMBF embedding)
- Custom signer extension point for full control over signing and embedding
- PEM key caching with configurable TTL
- Dynamic imports for optional peer dependencies — no vendor lock-in at install time

## Quick Start

```typescript
import { ProvenanceSigner } from '@reaatech/media-pipeline-mcp-provenance';
import type { ProvenanceManifest } from '@reaatech/media-pipeline-mcp-provenance';

const signer = new ProvenanceSigner({
  enabled: true,
  signingKey: {
    source: {
      kind: 'pem-inline',
      privateKey: process.env.PROVENANCE_PRIVATE_KEY!,
      certificate: process.env.PROVENANCE_CERTIFICATE!,
    },
    algorithm: 'es256',
    cacheTtlMs: 300_000,
  },
  embedMode: 'sidecar', // 'sidecar' | 'in-file' | 'both'
  signGenerativeOnly: true,
});

const manifest: ProvenanceManifest = {
  title: 'Product Photo - White Sneaker',
  format: 'image/png',
  claimGenerator: 'media-pipeline-mcp/0.3.0',
  assertions: [
    {
      kind: 'c2pa.model',
      providerId: 'stability',
      modelId: 'stable-diffusion-3',
      modelVersion: '3.0',
    },
    {
      kind: 'c2pa.actions',
      actions: [
        { action: 'c2pa.created', when: new Date().toISOString(), softwareAgent: 'media-pipeline-mcp/0.3.0' },
        { action: 'c2pa.edited', when: new Date().toISOString(), parameters: { upscale: '4x' } },
      ],
    },
    {
      kind: 'c2pa.ai.training',
      allowed: false,
      rationale: 'Consumer-generated content',
    },
  ],
  ingredients: [
    { artifactId: 'artifact-42', relationship: 'inputTo' },
  ],
  pipelineDefHash: 'sha256-def123',
  runId: 'run-42',
  generatedAt: new Date().toISOString(),
};

const { signedArtifactId, manifestUri } = await signer.sign('artifact-99', manifest);
// manifestUri → 'data:application/c2pa-sidecar+json;base64,eyJ2ZXJzaW9uIjoxLC...'
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `ProvenanceManifest` | Top-level manifest: title, format, claim generator, assertions, ingredients, pipeline hash, run ID, timestamp |
| `ProvenanceAssertion` | Discriminated union: `c2pa.actions` (action list), `c2pa.ai.training` (allowed + rationale), `c2pa.model` (provider/model/version), `custom` (arbitrary label + data) |
| `ProvenanceAction` | C2PA action: `c2pa.created`, `c2pa.edited`, `c2pa.placed`, or `c2pa.transcoded` with timestamp, software agent, parameters |
| `ProvenanceIngredient` | Input artifact reference: artifact ID, relationship type (`componentOf`, `parentOf`, `inputTo`), optional manifest URI |
| `KeySource` | Discriminated union of key sources: `pem-file`, `pem-inline`, `aws-kms`, `gcp-kms`, `azure-key-vault` |
| `SigningKeyConfig` | Key configuration: source, algorithm (`es256`/`es384`/`ps256`/`ed25519`), cache TTL |
| `ProvenanceConfig` | Full signer configuration: enabled flag, signing key, generative-only mode, embed mode, custom signer function |
| `CustomSignerFn` | Extension point: `(input) => Promise<{ signedArtifactId, manifestUri }>` |

### Classes

| Class | Description |
|-------|-------------|
| `ProvenanceSigner` | Main signer class. Delegates to the configured key source and embedding mode. Constructed with `ProvenanceConfig` and optional `SignerOptions`. |

**`ProvenanceSigner` methods:**

| Method | Description |
|--------|-------------|
| `sign(artifactId, manifest)` | Sign a manifest for the given artifact. Returns `{ signedArtifactId, manifestUri }`. Disabled config returns the original ID with empty URI. |

**`SignerOptions`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storage` | `SignerStorage` | _(none)_ | Required for `embedMode='in-file'` or `'both'`. Must implement `get(id)` and `put(id, data, meta)`. |

### Key Sources

| Source | Config Fields | Algorithm Support |
|--------|--------------|-------------------|
| `pem-file` | `path`, `certPath` | ES256, ES384, PS256, Ed25519 |
| `pem-inline` | `privateKey`, `certificate` | ES256, ES384, PS256, Ed25519 |
| `aws-kms` | `keyId`, `certPath`, `region?` | ES256, ES384, PS256 |
| `gcp-kms` | `keyName`, `certPath` | ES256, ES384, PS256 |
| `azure-key-vault` | `vaultUrl`, `keyName`, `certPath` | ES256, ES384, PS256 |

### Embed Modes

| Mode | Behavior |
|------|----------|
| `sidecar` | Produces a `data:` URI containing a signed JSON sidecar manifest with SHA-256 canonical hash and base64-encoded signature |
| `in-file` | Embeds the C2PA manifest directly into the artifact bytes via c2pa-node (requires `c2pa-node` peer dep and `storage` in `SignerOptions`) |
| `both` | Produces both in-file embedding and sidecar; if in-file fails, sidecar is still available |

## Usage Patterns

### AWS KMS Signing

```typescript
const signer = new ProvenanceSigner({
  enabled: true,
  signingKey: {
    source: {
      kind: 'aws-kms',
      keyId: 'arn:aws:kms:us-east-1:123456789012:key/abc123-def456',
      certPath: './certs/signing-cert.pem',
      region: 'us-east-1',
    },
    algorithm: 'ps256',
  },
  embedMode: 'sidecar',
});
```

### GCP KMS Signing

```typescript
const signer = new ProvenanceSigner({
  enabled: true,
  signingKey: {
    source: {
      kind: 'gcp-kms',
      keyName: 'projects/my-project/locations/global/keyRings/provenance/cryptoKeys/signing-key',
      certPath: './certs/signing-cert.pem',
    },
    algorithm: 'es256',
  },
});
```

### Azure Key Vault Signing

```typescript
const signer = new ProvenanceSigner({
  enabled: true,
  signingKey: {
    source: {
      kind: 'azure-key-vault',
      vaultUrl: 'https://my-vault.vault.azure.net',
      keyName: 'provenance-signing',
      certPath: './certs/signing-cert.pem',
    },
    algorithm: 'es384',
  },
});
```

### Custom Signer (Full Control)

```typescript
const signer = new ProvenanceSigner({
  enabled: true,
  signingKey: { source: { kind: 'pem-inline', privateKey: '', certificate: '' }, algorithm: 'es256' },
  customSigner: async ({ artifactId, manifest, config }) => {
    // Full control over signing and embedding — use HSM, custom c2pa-node config, etc.
    const result = await myCustomSigningService.sign({ artifactId, manifest });
    return { signedArtifactId: result.id, manifestUri: result.uri };
  },
});
```

## Related Packages

- [@reaatech/media-pipeline-mcp-core](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — `ProvenanceSigningFailedError` and shared types
- [@reaatech/media-pipeline-mcp](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Full MCP server with provenance signing integration

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
