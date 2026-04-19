import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Provider } from '@media-pipeline/core';
import { ProviderRegistry } from './provider-registry.js';

const createMockProvider = (name: string, operations: string[], healthy = true): Provider => ({
  name,
  supportedOperations: operations,
  execute: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(healthy),
});

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register', () => {
    it('should register a provider', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      const found = registry.getProvider('image.generate');
      expect(found).toBe(provider);
    });

    it('should store provider by name', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      const byName = registry.getProviderByName('test-provider');
      expect(byName).toBe(provider);
    });

    it('should initialize health status as unhealthy', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      const status = registry.getHealthStatus();
      expect(status).toHaveLength(1);
      expect(status[0].healthy).toBe(false);
    });
  });

  describe('getProvider', () => {
    it('should return provider for operation', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      const found = registry.getProvider('image.generate');
      expect(found).toBe(provider);
    });

    it('should return undefined for unknown operation', () => {
      const found = registry.getProvider('unknown.operation');
      expect(found).toBeUndefined();
    });
  });

  describe('getProviderByName', () => {
    it('should return provider by name', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      const found = registry.getProviderByName('test-provider');
      expect(found).toBe(provider);
    });

    it('should return undefined for unknown name', () => {
      const found = registry.getProviderByName('unknown');
      expect(found).toBeUndefined();
    });
  });

  describe('getAllProviders', () => {
    it('should return all registered providers', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['audio.tts']);
      registry.register(provider1);
      registry.register(provider2);

      const all = registry.getAllProviders();
      expect(all).toHaveLength(2);
    });
  });

  describe('checkHealth', () => {
    it('should return healthy status when provider is healthy', async () => {
      const provider = createMockProvider('test-provider', ['image.generate'], true);
      registry.register(provider);

      const status = await registry.checkHealth('test-provider');

      expect(status.name).toBe('test-provider');
      expect(status.healthy).toBe(true);
      expect(status.operations).toEqual(['image.generate']);
    });

    it('should throw error for unknown provider', async () => {
      await expect(registry.checkHealth('unknown')).rejects.toThrow('Provider not found');
    });

    it('should catch and report health check errors', async () => {
      const errorProvider = createMockProvider('error-provider', ['image.generate']);
      errorProvider.healthCheck = vi.fn().mockRejectedValue(new Error('Connection failed'));
      registry.register(errorProvider);

      const status = await registry.checkHealth('error-provider');

      expect(status.name).toBe('error-provider');
      expect(status.healthy).toBe(false);
      expect(status.error).toBe('Connection failed');
    });
  });

  describe('checkAllHealth', () => {
    it('should check health of all providers', async () => {
      const provider1 = createMockProvider('provider1', ['image.generate'], true);
      const provider2 = createMockProvider('provider2', ['audio.tts'], false);
      registry.register(provider1);
      registry.register(provider2);

      const results = await registry.checkAllHealth();

      expect(results).toHaveLength(2);
    });

    it('should handle mixed success and failure', async () => {
      const healthyProvider = createMockProvider('healthy', ['image.generate'], true);
      const unhealthyProvider = createMockProvider('unhealthy', ['audio.tts'], false);
      registry.register(healthyProvider);
      registry.register(unhealthyProvider);

      const results = await registry.checkAllHealth();

      expect(results).toHaveLength(2);
    });
  });

  describe('isAvailable', () => {
    it('should return true for available operation', () => {
      const provider = createMockProvider('test-provider', ['image.generate']);
      registry.register(provider);

      expect(registry.isAvailable('image.generate')).toBe(true);
    });

    it('should return false for unavailable operation', () => {
      expect(registry.isAvailable('unknown.operation')).toBe(false);
    });
  });

  describe('getEstimatedCost', () => {
    it('should return default cost estimate', () => {
      const cost = registry.getEstimatedCost('image.generate', {});
      expect(cost).toBe(0.01);
    });
  });

  describe('getEstimatedDuration', () => {
    it('should return default duration estimate', () => {
      const duration = registry.getEstimatedDuration('image.generate', {});
      expect(duration).toBe(5000);
    });
  });

  describe('getHealthStatus', () => {
    it('should return empty array when no providers registered', () => {
      const status = registry.getHealthStatus();
      expect(status).toEqual([]);
    });

    it('should return health status for all providers', () => {
      const provider1 = createMockProvider('provider1', ['image.generate']);
      const provider2 = createMockProvider('provider2', ['audio.tts']);
      registry.register(provider1);
      registry.register(provider2);

      const status = registry.getHealthStatus();
      expect(status).toHaveLength(2);
    });
  });
});
