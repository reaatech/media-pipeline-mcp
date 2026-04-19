import type { Provider } from '@media-pipeline/core';
import type { ProviderHealthStatus } from './provider-registry.js';

export interface RoutingConfig {
  operation: string;
  primary: string;
  fallbacks: string[];
}

export interface ProviderRouterConfig {
  routing?: RoutingConfig[];
}

export class ProviderRouter {
  private providers: Map<string, Provider> = new Map();
  private operationProviders: Map<string, Provider[]> = new Map();
  private routingConfig: Map<string, RoutingConfig> = new Map();
  private healthStatus: Map<string, ProviderHealthStatus> = new Map();

  constructor(config?: ProviderRouterConfig) {
    if (config?.routing) {
      for (const route of config.routing) {
        this.routingConfig.set(route.operation, route);
      }
    }
  }

  register(provider: Provider, healthStatus?: ProviderHealthStatus): void {
    this.providers.set(provider.name, provider);

    // Add provider to operation mappings
    for (const operation of provider.supportedOperations) {
      if (!this.operationProviders.has(operation)) {
        this.operationProviders.set(operation, []);
      }
      this.operationProviders.get(operation)!.push(provider);
    }

    // Store health status if provided
    if (healthStatus) {
      this.healthStatus.set(provider.name, healthStatus);
    } else {
      this.healthStatus.set(provider.name, {
        name: provider.name,
        operations: provider.supportedOperations,
        healthy: false,
        lastChecked: new Date().toISOString(),
      });
    }
  }

  updateHealthStatus(name: string, status: ProviderHealthStatus): void {
    this.healthStatus.set(name, status);
  }

  getProviderForOperation(operation: string, excludeProviders?: string[]): Provider | undefined {
    // Check if there's a specific routing config for this operation
    const route = this.routingConfig.get(operation);

    if (route) {
      // Try primary provider first
      if (!excludeProviders?.includes(route.primary)) {
        const primary = this.providers.get(route.primary);
        if (
          primary &&
          this.isHealthy(route.primary) &&
          primary.supportedOperations.includes(operation)
        ) {
          return primary;
        }
      }

      // Try fallbacks in order
      for (const fallback of route.fallbacks) {
        if (!excludeProviders?.includes(fallback)) {
          const provider = this.providers.get(fallback);
          if (
            provider &&
            this.isHealthy(fallback) &&
            provider.supportedOperations.includes(operation)
          ) {
            return provider;
          }
        }
      }
    }

    // No specific routing, use any available healthy provider
    const providers = this.operationProviders.get(operation);
    if (!providers) {
      return undefined;
    }

    // Prefer healthy providers
    for (const provider of providers) {
      if (!excludeProviders?.includes(provider.name) && this.isHealthy(provider.name)) {
        return provider;
      }
    }

    // If no healthy providers, try unhealthy ones (might be transient issue)
    for (const provider of providers) {
      if (!excludeProviders?.includes(provider.name)) {
        return provider;
      }
    }

    return undefined;
  }

  getProvidersForOperation(operation: string): Provider[] {
    return this.operationProviders.get(operation) || [];
  }

  getProviderByName(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  getAllProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  isHealthy(providerName: string): boolean {
    const status = this.healthStatus.get(providerName);
    return status?.healthy || false;
  }

  getHealthStatus(providerName: string): ProviderHealthStatus | undefined {
    return this.healthStatus.get(providerName);
  }

  getAllHealthStatus(): ProviderHealthStatus[] {
    return Array.from(this.healthStatus.values());
  }

  getSupportedOperations(): string[] {
    return Array.from(this.operationProviders.keys());
  }

  getRoutingConfig(operation: string): RoutingConfig | undefined {
    return this.routingConfig.get(operation);
  }

  setRoutingConfig(operation: string, config: RoutingConfig): void {
    this.routingConfig.set(operation, config);
  }

  removeProvider(name: string): void {
    this.providers.delete(name);
    this.healthStatus.delete(name);

    // Remove from operation mappings
    for (const [, providers] of this.operationProviders) {
      const index = providers.findIndex((p) => p.name === name);
      if (index !== -1) {
        providers.splice(index, 1);
      }
    }
  }

  getFallbackChain(operation: string): string[] {
    const route = this.routingConfig.get(operation);
    if (route) {
      return [route.primary, ...route.fallbacks];
    }

    // Default: return all providers that support this operation
    const providers = this.getProvidersForOperation(operation);
    return providers.map((p) => p.name);
  }

  async executeWithFallback<T>(
    operation: string,
    executor: (provider: Provider) => Promise<T>,
    initialExclude?: string[]
  ): Promise<{ result: T; provider: string; attempts: string[] }> {
    const attempts: string[] = [];
    const exclude = new Set(initialExclude || []);

    while (true) {
      const provider = this.getProviderForOperation(operation, Array.from(exclude));

      if (!provider) {
        if (attempts.length === 0) {
          throw new Error(`No provider available for operation: ${operation}`);
        }
        throw new Error(
          `All providers failed for operation: ${operation}. Attempts: ${attempts.join(', ')}`
        );
      }

      attempts.push(provider.name);

      try {
        const result = await executor(provider);
        return { result, provider: provider.name, attempts };
      } catch (error) {
        console.warn(`Provider ${provider.name} failed for ${operation}:`, error);
        exclude.add(provider.name);

        // Continue to next provider
        continue;
      }
    }
  }
}

export function createProviderRouter(config?: ProviderRouterConfig): ProviderRouter {
  return new ProviderRouter(config);
}
