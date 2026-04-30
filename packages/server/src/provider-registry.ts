import type { Provider } from '@reaatech/media-pipeline-mcp';

export interface ProviderHealthStatus {
  name: string;
  operations: string[];
  healthy: boolean;
  lastChecked: string;
  error?: string;
}

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();
  private operationMap: Map<string, Provider> = new Map();
  private healthStatus: Map<string, ProviderHealthStatus> = new Map();

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);

    for (const operation of provider.supportedOperations) {
      // First provider for an operation wins (could be enhanced with priority)
      if (!this.operationMap.has(operation)) {
        this.operationMap.set(operation, provider);
      }
    }

    // Initialize health status
    this.healthStatus.set(provider.name, {
      name: provider.name,
      operations: provider.supportedOperations,
      healthy: false,
      lastChecked: new Date().toISOString(),
    });
  }

  getProvider(operation: string): Provider | undefined {
    return this.operationMap.get(operation);
  }

  getProviderByName(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  getAllProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  getHealthStatus(): ProviderHealthStatus[] {
    return Array.from(this.healthStatus.values());
  }

  async checkHealth(providerName: string): Promise<ProviderHealthStatus> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider not found: ${providerName}`);
    }

    try {
      const healthy = await provider.healthCheck();
      const status: ProviderHealthStatus = {
        name: provider.name,
        operations: provider.supportedOperations,
        healthy,
        lastChecked: new Date().toISOString(),
      };

      this.healthStatus.set(providerName, status);
      return status;
    } catch (error) {
      const status: ProviderHealthStatus = {
        name: provider.name,
        operations: provider.supportedOperations,
        healthy: false,
        lastChecked: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      this.healthStatus.set(providerName, status);
      return status;
    }
  }

  async checkAllHealth(): Promise<ProviderHealthStatus[]> {
    const results = await Promise.allSettled(
      Array.from(this.providers.keys()).map((name) => this.checkHealth(name)),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<ProviderHealthStatus> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  isAvailable(operation: string): boolean {
    return this.operationMap.has(operation);
  }

  getEstimatedCost(_operation: string, _config: Record<string, unknown>): number {
    // Default estimate - providers can override
    return 0.01;
  }

  getEstimatedDuration(_operation: string, _config: Record<string, unknown>): number {
    // Default estimate - providers can override
    return 5000;
  }
}
