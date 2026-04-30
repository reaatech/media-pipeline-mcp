import type { ArtifactType } from '@reaatech/media-pipeline-mcp';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';

export interface ProviderInput {
  operation: string;
  params: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface ProviderOutput {
  data: Buffer | ReadableStream;
  mimeType: string;
  metadata: Record<string, unknown>;
  costUsd?: number;
  durationMs?: number;
}

export interface ProviderHealth {
  healthy: boolean;
  latency?: number;
  error?: string;
}

export abstract class MediaProvider {
  abstract readonly name: string;
  abstract readonly supportedOperations: string[];

  protected storage?: ArtifactStore;
  protected retryConfig = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
  };

  setStorage(storage: ArtifactStore): void {
    this.storage = storage;
  }

  abstract healthCheck(): Promise<ProviderHealth>;

  abstract execute(input: ProviderInput): Promise<ProviderOutput>;

  async executeWithRetry(input: ProviderInput): Promise<ProviderOutput> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryConfig.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(
            this.retryConfig.baseDelay * 2 ** (attempt - 1),
            this.retryConfig.maxDelay,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        return await this.execute(input);
      } catch (error) {
        lastError = error as Error;

        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  protected isNonRetryableError(error: unknown): boolean {
    // Authentication errors, validation errors, etc.
    const message = (error as Error).message.toLowerCase();
    return (
      message.includes('authentication') ||
      message.includes('unauthorized') ||
      message.includes('validation') ||
      message.includes('invalid api key')
    );
  }

  protected generateArtifactId(): string {
    return `artifact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  async storeArtifact(
    data: Buffer | ReadableStream,
    type: ArtifactType,
    mimeType: string,
    metadata: Record<string, unknown>,
    sourceStep?: string,
  ): Promise<string> {
    if (!this.storage) {
      throw new Error('Storage not configured for provider');
    }

    const id = this.generateArtifactId();
    const uri = await this.storage.put(id, data, {
      id,
      type,
      mimeType,
      metadata,
      sourceStep,
    });

    return uri;
  }
}

export function defineProvider<T extends MediaProvider>(
  providerClass: new (...args: unknown[]) => T,
): new (
  ...args: unknown[]
) => T {
  return providerClass;
}
