import type { Artifact, Provider } from '@reaatech/media-pipeline-mcp';

export class ProviderAdapter implements Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  private executeFn: (
    operation: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<{
    data: Buffer | ReadableStream;
    mimeType: string;
    metadata: Record<string, unknown>;
    costUsd?: number;
    durationMs?: number;
  }>;
  private healthCheckFn: () => Promise<{ healthy: boolean; latency?: number; error?: string }>;

  constructor(config: {
    name: string;
    supportedOperations: string[];
    execute: (
      operation: string,
      inputs: Record<string, unknown>,
      config: Record<string, unknown>,
    ) => Promise<{
      data: Buffer | ReadableStream;
      mimeType: string;
      metadata: Record<string, unknown>;
      costUsd?: number;
      durationMs?: number;
    }>;
    healthCheck: () => Promise<{ healthy: boolean; latency?: number; error?: string }>;
  }) {
    this.name = config.name;
    this.supportedOperations = config.supportedOperations;
    this.executeFn = config.execute;
    this.healthCheckFn = config.healthCheck;
  }

  async execute(
    operation: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<{
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    cost_usd?: number;
    duration_ms?: number;
  }> {
    const result = await this.executeFn(operation, inputs, config);

    const artifactType = this.inferArtifactType(operation, result.mimeType, result.metadata);
    const uri = `provider://${this.name}/${operation}/${Date.now()}`;

    return {
      data: result.data as Buffer | NodeJS.ReadableStream,
      artifact: {
        type: artifactType,
        uri,
        mimeType: result.mimeType,
        metadata: result.metadata || {},
      },
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    };
  }

  async healthCheck(): Promise<boolean> {
    const health = await this.healthCheckFn();
    return health.healthy;
  }

  private inferArtifactType(
    operation: string,
    mimeType: string,
    metadata: Record<string, unknown>,
  ): Artifact['type'] {
    const explicitType = metadata.type;
    if (
      explicitType === 'image' ||
      explicitType === 'video' ||
      explicitType === 'audio' ||
      explicitType === 'text' ||
      explicitType === 'document'
    ) {
      return explicitType;
    }

    if (mimeType.startsWith('image/')) {
      return 'image';
    }

    if (mimeType.startsWith('audio/')) {
      return 'audio';
    }

    if (mimeType.startsWith('video/')) {
      return 'video';
    }

    if (
      mimeType === 'application/pdf' ||
      operation.startsWith('document.') ||
      mimeType === 'application/vnd.openxmlformats-officedocument'
    ) {
      return 'document';
    }

    return 'text';
  }
}
