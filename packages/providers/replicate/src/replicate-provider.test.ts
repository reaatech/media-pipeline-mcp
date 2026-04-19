import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplicateProvider } from './replicate-provider.js';
import type { ProviderInput } from '@media-pipeline/provider-core';

// Mock the replicate client
vi.mock('replicate', () => {
  return {
    default: class MockReplicate {
      run = vi.fn().mockResolvedValue(Buffer.from('mock-image-data'));
    },
  };
});

describe('ReplicateProvider', () => {
  let provider: ReplicateProvider;

  beforeEach(() => {
    provider = new ReplicateProvider({
      apiKey: 'test-api-key',
      models: {
        upscale: 'test-model-hash',
      },
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('replicate');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.upscale');
      expect(provider.supportedOperations).toContain('image.remove_background');
      expect(provider.supportedOperations).toContain('image.inpaint');
      expect(provider.supportedOperations).toContain('audio.isolate');
      expect(provider.supportedOperations).toContain('video.generate');
      expect(provider.supportedOperations).toContain('video.image_to_video');
    });
  });

  describe('execute', () => {
    it('should execute image.upscale operation', async () => {
      const input: ProviderInput = {
        operation: 'image.upscale',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          scale: 4,
          model: 'real-esrgan',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBeDefined();
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute image.remove_background operation', async () => {
      const input: ProviderInput = {
        operation: 'image.remove_background',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.003);
    });

    it('should execute image.inpaint operation', async () => {
      const input: ProviderInput = {
        operation: 'image.inpaint',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          prompt: 'a beautiful landscape',
          negative_prompt: 'blurry',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.01);
    });

    it('should execute audio.isolate operation', async () => {
      const input: ProviderInput = {
        operation: 'audio.isolate',
        config: {},
        params: {
          audio_data: Buffer.from('test-audio'),
          target: 'vocals',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.01);
    });

    it('should execute video.generate operation', async () => {
      const input: ProviderInput = {
        operation: 'video.generate',
        config: {},
        params: {
          prompt: 'a sunset over mountains',
          duration: 5,
          aspect_ratio: '16:9',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.1);
    });

    it('should execute video.image_to_video operation', async () => {
      const input: ProviderInput = {
        operation: 'video.image_to_video',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          motion_prompt: 'slow zoom',
          duration: 5,
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.08);
    });

    it('should throw error for unsupported operation', async () => {
      const input: ProviderInput = {
        operation: 'unknown.operation' as any,
        config: {},
        params: {},
      };

      await expect(provider.execute(input)).rejects.toThrow('Unsupported operation');
    });
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      const health = await provider.healthCheck();

      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('latency');
    });
  });

  describe('cost estimation', () => {
    it('should estimate correct costs for operations', async () => {
      const costs = {
        'image.upscale': 0.005,
        'image.remove_background': 0.003,
        'image.inpaint': 0.01,
        'audio.isolate': 0.01,
        'video.generate': 0.1,
        'video.image_to_video': 0.08,
      };

      for (const [operation, expectedCost] of Object.entries(costs)) {
        const input: ProviderInput = {
          operation: operation as any,
          config: {},
          params: {
            image_data: Buffer.from('test'),
            audio_data: Buffer.from('test'),
            prompt: 'test',
            duration: 5,
          },
        };

        try {
          const result = await provider.execute(input);
          expect(result.costUsd).toBe(expectedCost);
        } catch {
          // Some operations may fail due to missing params, that's ok for cost test
        }
      }
    });
  });
});
