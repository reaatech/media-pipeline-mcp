import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FalProvider } from './fal-provider.js';

// Mock the fal client
vi.mock('@fal-ai/client', () => {
  return {
    fal: {
      config: vi.fn(),
      subscribe: vi.fn().mockResolvedValue({
        images: [{ url: 'https://example.com/image.png' }],
        video: null,
      }),
    },
  };
});

describe('FalProvider', () => {
  let provider: FalProvider;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://api.fal.ai/v1/balance') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            arrayBuffer: async () => new Uint8Array().buffer,
          };
        }

        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({
            'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png',
          }),
          arrayBuffer: async () => Buffer.from('mock-media'),
        };
      }),
    );

    provider = new FalProvider({
      apiKey: 'test-api-key',
      models: {
        imageGenerate: 'fal-ai/fast-flux-pro',
      },
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('fal');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.generate');
      expect(provider.supportedOperations).toContain('image.upscale');
      expect(provider.supportedOperations).toContain('image.remove_background');
      expect(provider.supportedOperations).toContain('video.generate');
      expect(provider.supportedOperations).toContain('video.image_to_video');
    });
  });

  describe('execute', () => {
    it('should execute image.generate operation', async () => {
      const input: ProviderInput = {
        operation: 'image.generate',
        config: {},
        params: {
          prompt: 'a beautiful sunset',
          aspect_ratio: '16:9',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBeDefined();
      expect(result.costUsd).toBe(0.008);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute image.upscale operation', async () => {
      const input: ProviderInput = {
        operation: 'image.upscale',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          scale: 4,
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.004);
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
      expect(result.costUsd).toBe(0.002);
    });

    it('should execute video.generate operation', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'video/mp4' }),
        arrayBuffer: async () => Buffer.from('mock-video'),
      } as unknown as Response);

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
      expect(result.costUsd).toBe(0.12);
    });

    it('should execute video.image_to_video operation', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'video/mp4' }),
        arrayBuffer: async () => Buffer.from('mock-video'),
      } as unknown as Response);

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
      expect(result.costUsd).toBe(0.1);
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

  describe('image size parsing', () => {
    it('should parse aspect ratios correctly', () => {
      // Test via execute with different aspect ratios
      const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
      for (const ratio of ratios) {
        expect(() =>
          provider.execute({
            operation: 'image.generate',
            config: {},
            params: { prompt: 'test', aspect_ratio: ratio },
          }),
        ).not.toThrow();
      }
    });
  });
});
