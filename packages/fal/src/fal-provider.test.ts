import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FalProvider } from './fal-provider.js';

const mockSubscribe = vi.hoisted(() => vi.fn());
let mockFetch = vi.fn();

vi.mock('@fal-ai/client', () => {
  return {
    fal: {
      config: vi.fn(),
      subscribe: mockSubscribe,
    },
  };
});

describe('FalProvider', () => {
  let provider: FalProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribe.mockReset();

    mockFetch = vi.fn(async (url: string) => {
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
        headers: new Headers({ 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png' }),
        arrayBuffer: async () => Buffer.from('mock-media'),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    provider = new FalProvider({
      apiKey: 'test-api-key',
      models: { imageGenerate: 'fal-ai/fast-flux-pro' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    beforeEach(() => {
      mockSubscribe.mockResolvedValue({
        images: [{ url: 'https://example.com/image.png' }],
        video: null,
      });
    });

    it('should execute image.generate', async () => {
      const result = await provider.execute({
        operation: 'image.generate',
        config: {},
        params: { prompt: 'a sunset', aspect_ratio: '16:9' },
      });

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.008);
    });

    it('should execute image.generate with default aspect ratio', async () => {
      mockSubscribe.mockResolvedValue({
        images: [{ url: 'https://example.com/image.png' }],
        video: null,
      });

      const result = await provider.execute({
        operation: 'image.generate',
        config: {},
        params: { prompt: 'a sunset' },
      });

      expect(result.data).toBeDefined();
    });

    it('should execute image.upscale', async () => {
      mockSubscribe.mockResolvedValue({
        images: [{ url: 'https://example.com/upscaled.png' }],
        video: null,
      });

      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test'), scale: 4 },
      });

      expect(result.costUsd).toBe(0.004);
    });

    it('should execute image.remove_background', async () => {
      mockSubscribe.mockResolvedValue({
        images: [{ url: 'https://example.com/nobg.png' }],
        video: null,
      });

      const result = await provider.execute({
        operation: 'image.remove_background',
        config: {},
        params: { image_data: Buffer.from('test') },
      });

      expect(result.costUsd).toBe(0.002);
    });

    it('should execute video.generate', async () => {
      mockSubscribe.mockResolvedValue({
        images: null,
        video: { url: 'https://example.com/video.mp4' },
      });

      const result = await provider.execute({
        operation: 'video.generate',
        config: {},
        params: { prompt: 'a sunset', duration: 5, aspect_ratio: '16:9' },
      });

      expect(result.data).toBeDefined();
      expect(result.costUsd).toBe(0.12);
    });

    it('should execute video.image_to_video', async () => {
      mockSubscribe.mockResolvedValue({
        images: null,
        video: { url: 'https://example.com/video.mp4' },
      });

      const result = await provider.execute({
        operation: 'video.image_to_video',
        config: {},
        params: { image_data: Buffer.from('test'), motion_prompt: 'zoom', duration: 5 },
      });

      expect(result.costUsd).toBe(0.1);
    });

    it('should handle non-image/video output as JSON', async () => {
      mockSubscribe.mockResolvedValue({ output: 'some data' });

      const result = await provider.execute({
        operation: 'image.generate',
        config: {},
        params: { prompt: 'test' },
      });

      expect(result.mimeType).toBe('application/json');
    });

    it('should throw for unsupported operation', async () => {
      await expect(
        provider.execute({
          operation: 'unknown.operation' as unknown as string,
          config: {},
          params: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });

    it('should wrap provider errors', async () => {
      mockSubscribe.mockRejectedValue(new Error('API failure'));

      await expect(
        provider.execute({
          operation: 'image.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('fal.ai provider error');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy on success', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy on API error', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('401');
    });

    it('should return unhealthy on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Network error');
    });
  });

  describe('parseImageSize', () => {
    it('should return defaults for undefined aspect ratio', () => {
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize(),
      ).toEqual({ width: 1024, height: 1024 });
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize(undefined),
      ).toEqual({ width: 1024, height: 1024 });
    });

    it('should parse common aspect ratios', () => {
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('1:1'),
      ).toEqual({ width: 1024, height: 1024 });
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('16:9'),
      ).toEqual({ width: 1920, height: 1080 });
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('9:16'),
      ).toEqual({ width: 1080, height: 1920 });
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('4:3'),
      ).toEqual({ width: 1024, height: 768 });
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('3:4'),
      ).toEqual({ width: 768, height: 1024 });
    });

    it('should return defaults for unknown aspect ratio', () => {
      expect(
        (
          provider as unknown as {
            parseImageSize(aspectRatio?: string): { width: number; height: number };
          }
        ).parseImageSize('21:9'),
      ).toEqual({ width: 1024, height: 1024 });
    });
  });

  describe('isNonRetryableError', () => {
    it('should detect non-retryable errors', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('authentication failed'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid api key'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('permission denied'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('model not found'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('insufficient credits'),
        ),
      ).toBe(true);
    });

    it('should allow retry for transient error', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('timeout'),
        ),
      ).toBe(false);
    });
  });

  describe('estimateCost', () => {
    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should estimate cost for known operation', async () => {
      const result = await provider.estimateCost({
        operation: 'video.generate',
        params: {},
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });
  });

  describe('defineFalProvider', () => {
    it('should create provider', async () => {
      const { defineFalProvider } = await import('./fal-provider.js');
      const p = defineFalProvider({ apiKey: 'key' });
      expect(p.name).toBe('fal');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.FalProvider).toBeDefined();
    expect(mod.defineFalProvider).toBeDefined();
  });
});

describe('FalProvider.cacheConfig (F2)', () => {
  it('declares deterministic + non-deterministic params per the plan F2 table', () => {
    expect(FalProvider.cacheConfig.deterministicParams).toContain('prompt');
    expect(FalProvider.cacheConfig.deterministicParams).toContain('model');
    expect(FalProvider.cacheConfig.deterministicParams).toContain('seed');
    // request_id is provider-side and must NOT contribute to the cache key.
    expect(FalProvider.cacheConfig.nonDeterministicParams).toContain('request_id');
    // webhook_url similarly is async-routing-only, not content-affecting.
    expect(FalProvider.cacheConfig.nonDeterministicParams).toContain('webhook_url');
  });

  it('normalize() drops non-deterministic params and trims prompt whitespace', () => {
    const out = FalProvider.cacheConfig.normalize({
      prompt: '  hello   world  ',
      model: 'flux-pro-1.1',
      seed: 42,
      request_id: 'should-not-appear',
      webhook_url: 'https://nope.example/cb',
    });
    expect(out).toEqual({ prompt: 'hello world', model: 'flux-pro-1.1', seed: 42 });
  });
});
