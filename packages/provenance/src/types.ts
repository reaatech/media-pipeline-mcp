export interface ProvenanceManifest {
  title: string;
  format: string;
  claimGenerator: string;
  assertions: ProvenanceAssertion[];
  ingredients?: ProvenanceIngredient[];
  pipelineDefHash: string;
  runId: string;
  generatedAt: string;
}

export type ProvenanceAssertion =
  | { kind: 'c2pa.actions'; actions: ProvenanceAction[] }
  | { kind: 'c2pa.ai.training'; allowed: boolean; rationale?: string }
  | { kind: 'c2pa.model'; providerId: string; modelId: string; modelVersion?: string }
  | { kind: 'custom'; label: string; data: Record<string, unknown> };

export interface ProvenanceAction {
  action: 'c2pa.created' | 'c2pa.edited' | 'c2pa.placed' | 'c2pa.transcoded';
  when: string;
  softwareAgent?: string;
  parameters?: Record<string, unknown>;
}

export interface ProvenanceIngredient {
  artifactId: string;
  title?: string;
  relationship: 'componentOf' | 'parentOf' | 'inputTo';
  manifestRef?: string;
}

export type KeySource =
  | { kind: 'pem-file'; path: string; certPath: string }
  | { kind: 'pem-inline'; privateKey: string; certificate: string }
  | { kind: 'aws-kms'; keyId: string; certPath: string; region?: string }
  | { kind: 'gcp-kms'; keyName: string; certPath: string }
  | { kind: 'azure-key-vault'; vaultUrl: string; keyName: string; certPath: string };

export interface SigningKeyConfig {
  source: KeySource;
  algorithm: 'es256' | 'es384' | 'ps256' | 'ed25519';
  cacheTtlMs?: number;
}

export interface ProvenanceConfig {
  enabled: boolean;
  signingKey: SigningKeyConfig;
  signGenerativeOnly?: boolean;
  embedMode?: 'in-file' | 'sidecar' | 'both';
  /**
   * Optional consumer-supplied signer that fully owns the sign + embed pipeline.
   * When provided, ProvenanceSigner delegates to it instead of running the built-in
   * Node-crypto sidecar signer. This is the extension point for:
   *   - c2pa-node native embedding (in-file JUMBF/uuid/LIST per format)
   *   - AWS KMS / GCP KMS / Azure Key Vault key sources
   *   - Certificate chain provisioning, OCSP stapling, timestamping
   *
   * The built-in signer covers PEM key sources + sidecar JSON only — see the
   * signer's class doc for the limitations.
   */
  customSigner?: CustomSignerFn;
}

export type CustomSignerFn = (input: {
  artifactId: string;
  manifest: ProvenanceManifest;
  config: ProvenanceConfig;
}) => Promise<{ signedArtifactId: string; manifestUri: string }>;
