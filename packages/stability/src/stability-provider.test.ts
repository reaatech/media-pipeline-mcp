import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StabilityProvider, createStabilityProvider } from './stability-provider.js';
import type { StabilityConfig } from './stability-provider.js';

const mockConfig: StabilityConfig = {
  apiKey: 'test-api-key',
};

describe('StabilityProvider', () => {
  let provider: StabilityProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StabilityProvider(mockConfig);
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('stability-ai');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.generate');
    });

    it('should use default model when not specified', () => {
      expect(provider['model']).toBe('sd3');
    });

    it('should use custom model when specified', () => {
      const customProvider = new StabilityProvider({ apiKey: 'key', model: 'sdxl' });
      expect(customProvider['model']).toBe('sdxl');
    });

    it('should use custom baseUrl when specified', () => {
      const customProvider = new StabilityProvider({
        apiKey: 'key',
        baseUrl: 'https://custom.url',
      });
      expect(customProvider['baseUrl']).toBe('https://custom.url');
    });
  });

  describe('cacheConfig', () => {
    it('should define deterministic params', () => {
      expect(StabilityProvider.cacheConfig.deterministicParams).toContain('prompt');
      expect(StabilityProvider.cacheConfig.deterministicParams).toContain('model');
      expect(StabilityProvider.cacheConfig.deterministicParams).toContain('seed');
      expect(StabilityProvider.cacheConfig.deterministicParams).toContain('sampler');
    });

    it('should define nonDeterministicParams as empty array', () => {
      expect(StabilityProvider.cacheConfig.nonDeterministicParams).toEqual([]);
    });

    describe('normalize', () => {
      const normalize = StabilityProvider.cacheConfig.normalize;

      it('should trim and collapse whitespace in prompt', () => {
        const result = normalize({ prompt: '  hello   world  ' });
        expect(result.prompt).toBe('hello world');
      });

      it('should preserve model, steps, cfg_scale, width, height, seed', () => {
        const result = normalize({
          prompt: 'test',
          model: 'sd3',
          steps: 30,
          cfg_scale: 7,
          width: 1024,
          height: 768,
          seed: 42,
        });
        expect(result.model).toBe('sd3');
        expect(result.steps).toBe(30);
        expect(result.cfg_scale).toBe(7);
        expect(result.width).toBe(1024);
        expect(result.height).toBe(768);
        expect(result.seed).toBe(42);
      });

      it('should skip sampler when it is "auto"', () => {
        const result = normalize({ prompt: 'test', sampler: 'auto' });
        expect(result.sampler).toBeUndefined();
      });

      it('should include sampler when it is not "auto"', () => {
        const result = normalize({ prompt: 'test', sampler: 'K_EULER' });
        expect(result.sampler).toBe('K_EULER');
      });

      it('should pass through undefined checks gracefully', () => {
        const result = normalize({});
        expect(result).toEqual({});
      });
    });
  });

  describe('healthCheck', () => {
    it('should return healthy when API responds ok', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        } as Response),
      );

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when API responds with error', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        } as Response),
      );

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should return unhealthy on network error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('estimateCost', () => {
    it('should return zero cost for unknown operation', async () => {
      const result = await provider.estimateCost({
        operation: 'unknown.op',
        params: {},
        config: {},
      });
      expect(result.costUsd).toBe(0);
    });

    it('should calculate cost for image.generate', async () => {
      const result = await provider.estimateCost({
        operation: 'image.generate',
        params: { model: 'sd3', steps: 30 },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.currency).toBe('USD');
    });

    it('should use default pricing when model not found', async () => {
      const result = await provider.estimateCost({
        operation: 'image.generate',
        params: { model: 'unknown-model', steps: 20 },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
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

    it('should throw for image.inpaint (not implemented)', async () => {
      await expect(
        provider.execute({
          operation: 'image.inpaint',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Inpainting not yet implemented');
    });

    it('should throw for image.upscale (not implemented)', async () => {
      await expect(
        provider.execute({
          operation: 'image.upscale',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Upscaling not yet implemented');
    });

    it('should throw for image.remove_background (not implemented)', async () => {
      await expect(
        provider.execute({
          operation: 'image.remove_background',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Background removal not yet implemented');
    });

    describe('image.generate', () => {
      beforeEach(() => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        } as Response);
      });

      it('should generate image with basic params', async () => {
        const result = await provider.execute({
          operation: 'image.generate',
          params: { prompt: 'test prompt' },
          config: {},
        });

        expect(result.data).toBeDefined();
        expect(result.mimeType).toBe('image/png');
        expect(result.costUsd).toBe(0.007);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('should pass all optional parameters', async () => {
        const fetchMock = vi.mocked(global.fetch as unknown as typeof globalThis.fetch);
        await provider.execute({
          operation: 'image.generate',
          params: {
            prompt: 'test',
            negative_prompt: 'bad stuff',
            width: 1024,
            height: 768,
            seed: 42,
            steps: 50,
            cfg_scale: 7.5,
          },
          config: {},
        });

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://api.stability.ai/v2beta/stable-image/generate/sd3');
        const init = call[1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key');
        expect(init.body instanceof FormData).toBe(true);
      });

      it('should throw on API error', async () => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          text: async () => 'Bad request',
        } as Response);

        await expect(
          provider.execute({
            operation: 'image.generate',
            params: { prompt: 'test' },
            config: {},
          }),
        ).rejects.toThrow('Stability AI error: Bad request');
      });
    });
  });

  describe('createStabilityProvider', () => {
    it('should create provider instance', () => {
      const instance = createStabilityProvider(mockConfig);
      expect(instance).toBeInstanceOf(StabilityProvider);
      expect(instance.name).toBe('stability-ai');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.StabilityProvider).toBeDefined();
    expect(mod.createStabilityProvider).toBeDefined();
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
