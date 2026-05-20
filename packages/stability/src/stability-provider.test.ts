import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StabilityProvider } from './stability-provider.js';
import type { StabilityConfig } from './stability-provider.js';

const mockConfig: StabilityConfig = {
  apiKey: 'test-api-key',
};

describe('StabilityProvider', () => {
  let provider: StabilityProvider;

  beforeEach(() => {
    provider = new StabilityProvider(mockConfig);
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('stability-ai');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.generate');
    });
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        } as Response),
      );

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should throw for unsupported operations', async () => {
      await expect(
        provider.execute({
          operation: 'unsupported.operation',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });
  });

  describe('createStabilityProvider', () => {
    it('should create provider instance', async () => {
      const { createStabilityProvider } = await import('./stability-provider.js');
      const instance = createStabilityProvider(mockConfig);
      expect(instance.name).toBe('stability-ai');
    });
  });
});
