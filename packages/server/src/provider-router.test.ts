import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRouter, createProviderRouter } from './provider-router.js';
import type { Provider } from '@media-pipeline/core';
import type { ProviderHealthStatus } from './provider-registry.js';

// Mock provider
const createMockProvider = (name: string, operations: string[]): Provider => ({
  name,
  supportedOperations: operations,
  healthCheck: vi.fn().mockResolvedValue(true),
  execute: vi
    .fn()
    .mockResolvedValue({ data: Buffer.from('test'), mimeType: 'image/png', costUsd: 0.01 }),
});

describe('ProviderRouter', () => {
  let router: ProviderRouter;

  beforeEach(() => {
    router = createProviderRouter();
  });

  describe('registration', () => {
    it('should register a provider', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider);

      expect(router.getProviderByName('test-provider')).toBe(provider);
    });

    it('should register multiple providers', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.upscale']);
      router.register(provider1);
      router.register(provider2);

      expect(router.getAllProviders()).toHaveLength(2);
    });

    it('should register provider with health status', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      const healthStatus: ProviderHealthStatus = {
        name: 'test-provider',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      };
      router.register(provider, healthStatus);

      expect(router.isHealthy('test-provider')).toBe(true);
    });
  });

  describe('health status', () => {
    it('should update health status', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider);

      const newStatus: ProviderHealthStatus = {
        name: 'test-provider',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      };
      router.updateHealthStatus('test-provider', newStatus);

      expect(router.isHealthy('test-provider')).toBe(true);
    });

    it('should return unhealthy for unknown provider', () => {
      expect(router.isHealthy('unknown')).toBe(false);
    });

    it('should get health status for provider', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      const healthStatus: ProviderHealthStatus = {
        name: 'test-provider',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      };
      router.register(provider, healthStatus);

      const status = router.getHealthStatus('test-provider');
      expect(status).toBeDefined();
      expect(status?.healthy).toBe(true);
    });
  });

  describe('operation routing', () => {
    it('should find provider for operation', () => {
      const provider = createMockProvider('test-provider', ['image.generate', 'image.upscale']);
      router.register(provider, {
        name: 'test-provider',
        operations: ['image.generate', 'image.upscale'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      const found = router.getProviderForOperation('image.generate');
      expect(found).toBe(provider);
    });

    it('should return undefined for unsupported operation', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider, {
        name: 'test-provider',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      const found = router.getProviderForOperation('audio.tts');
      expect(found).toBeUndefined();
    });

    it('should get all providers for operation', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.generate']);
      router.register(provider1, {
        name: 'provider1',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(provider2, {
        name: 'provider2',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      const providers = router.getProvidersForOperation('image.generate');
      expect(providers).toHaveLength(2);
    });

    it('should prefer healthy providers', () => {
      const healthyProvider = createMockProvider('healthy', ['image.generate']);
      const unhealthyProvider = createMockProvider('unhealthy', ['image.generate']);
      router.register(healthyProvider, {
        name: 'healthy',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(unhealthyProvider, {
        name: 'unhealthy',
        operations: ['image.generate'],
        healthy: false,
        lastChecked: new Date().toISOString(),
      });

      const found = router.getProviderForOperation('image.generate');
      expect(found).toBe(healthyProvider);
    });

    it('should exclude specified providers', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.generate']);
      router.register(provider1, {
        name: 'provider1',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(provider2, {
        name: 'provider2',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      const found = router.getProviderForOperation('image.generate', ['provider1']);
      expect(found).toBe(provider2);
    });
  });

  describe('routing configuration', () => {
    it('should respect routing config for primary provider', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.generate']);
      router.register(provider1, {
        name: 'provider1',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(provider2, {
        name: 'provider2',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      router.setRoutingConfig('image.generate', {
        operation: 'image.generate',
        primary: 'provider2',
        fallbacks: ['provider1'],
      });

      const found = router.getProviderForOperation('image.generate');
      expect(found).toBe(provider2);
    });

    it('should use fallback when primary is unhealthy', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.generate']);
      router.register(provider1, {
        name: 'provider1',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(provider2, {
        name: 'provider2',
        operations: ['image.generate'],
        healthy: false,
        lastChecked: new Date().toISOString(),
      });

      router.setRoutingConfig('image.generate', {
        operation: 'image.generate',
        primary: 'provider2',
        fallbacks: ['provider1'],
      });

      const found = router.getProviderForOperation('image.generate');
      expect(found).toBe(provider1);
    });

    it('should get fallback chain', () => {
      router.setRoutingConfig('image.generate', {
        operation: 'image.generate',
        primary: 'primary',
        fallbacks: ['fallback1', 'fallback2'],
      });

      const chain = router.getFallbackChain('image.generate');
      expect(chain).toEqual(['primary', 'fallback1', 'fallback2']);
    });
  });

  describe('executeWithFallback', () => {
    it('should execute with first available provider', async () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider, {
        name: 'test-provider',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      const executor = vi.fn().mockResolvedValue('result');
      const result = await router.executeWithFallback('image.generate', executor);

      expect(result.result).toBe('result');
      expect(result.provider).toBe('test-provider');
      expect(result.attempts).toEqual(['test-provider']);
    });

    it('should try fallback on failure', async () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['image.generate']);
      router.register(provider1, {
        name: 'provider1',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });
      router.register(provider2, {
        name: 'provider2',
        operations: ['image.generate'],
        healthy: true,
        lastChecked: new Date().toISOString(),
      });

      let _callCount = 0;
      const executor = vi.fn().mockImplementation((p: Provider) => {
        _callCount++;
        if (p.name === 'provider1') {
          throw new Error('Provider1 failed');
        }
        return Promise.resolve('success');
      });

      const result = await router.executeWithFallback('image.generate', executor);

      expect(result.result).toBe('success');
      expect(result.provider).toBe('provider2');
      expect(result.attempts).toEqual(['provider1', 'provider2']);
    });

    it('should throw when no providers available', async () => {
      const executor = vi.fn().mockResolvedValue('result');

      await expect(router.executeWithFallback('unknown.operation', executor)).rejects.toThrow(
        'No provider available'
      );
    });
  });

  describe('provider removal', () => {
    it('should remove provider', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider);
      router.removeProvider('test-provider');

      expect(router.getProviderByName('test-provider')).toBeUndefined();
    });

    it('should remove from operation mappings', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      router.register(provider);
      router.removeProvider('test-provider');

      const providers = router.getProvidersForOperation('image.generate');
      expect(providers).toHaveLength(0);
    });
  });

  describe('supported operations', () => {
    it('should list all supported operations', () => {
      const provider1 = createMockProvider('provider1', ['image.generate', 'image.upscale']);
      const provider2 = createMockProvider('provider2', ['audio.tts']);
      router.register(provider1);
      router.register(provider2);

      const operations = router.getSupportedOperations();
      expect(operations).toContain('image.generate');
      expect(operations).toContain('image.upscale');
      expect(operations).toContain('audio.tts');
    });
  });
});
