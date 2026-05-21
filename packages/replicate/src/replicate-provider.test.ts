import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplicateProvider } from './replicate-provider.js';

const mockRun = vi.fn();

vi.mock('replicate', () => {
  return {
    default: class MockReplicate {
      run = mockRun;
      fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    },
  };
});

describe('ReplicateProvider', () => {
  let provider: ReplicateProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockReset();
    provider = new ReplicateProvider({
      apiKey: 'test-api-key',
      models: { upscale: 'test-model-hash' },
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

  describe('cacheConfig', () => {
    const { cacheConfig } = ReplicateProvider;

    it('should define deterministic params', () => {
      expect(cacheConfig.deterministicParams).toContain('prompt');
      expect(cacheConfig.deterministicParams).toContain('seed');
    });

    it('should define nonDeterministicParams', () => {
      expect(cacheConfig.nonDeterministicParams).toContain('webhook');
      expect(cacheConfig.nonDeterministicParams).toContain('webhook_url');
    });

    describe('normalize', () => {
      const normalize = cacheConfig.normalize;

      it('should trim and collapse whitespace for string values', () => {
        const result = normalize({ prompt: '  hello   world ', seed: 42 });
        expect(result.prompt).toBe('hello world');
        expect(result.seed).toBe(42);
      });

      it('should skip webhook and webhook_url', () => {
        const result = normalize({
          prompt: 'test',
          webhook: 'https://hook.example.com',
          webhook_url: 'https://hook.example.com',
        });
        expect(result.prompt).toBe('test');
        expect(result.webhook).toBeUndefined();
        expect(result.webhook_url).toBeUndefined();
      });

      it('should handle empty inputs', () => {
        expect(normalize({})).toEqual({});
      });
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      mockRun.mockResolvedValue(Buffer.from('mock-image-data'));
    });

    it('should execute image.upscale operation', async () => {
      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test-image'), scale: 4 },
      });

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBeDefined();
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should execute image.remove_background', async () => {
      const result = await provider.execute({
        operation: 'image.remove_background',
        config: {},
        params: { image_data: Buffer.from('test') },
      });

      expect(result.costUsd).toBe(0.003);
    });

    it('should execute image.inpaint with mask_data', async () => {
      mockRun.mockResolvedValue(Buffer.from('inpainted'));

      const result = await provider.execute({
        operation: 'image.inpaint',
        config: {},
        params: {
          image_data: Buffer.from('test'),
          mask_data: Buffer.from('mask'),
          prompt: 'fix it',
          negative_prompt: 'no',
        },
      });

      expect(result.data).toBeDefined();
    });

    it('should execute image.inpaint without mask_data', async () => {
      const result = await provider.execute({
        operation: 'image.inpaint',
        config: {},
        params: { image_data: Buffer.from('test'), prompt: 'fix it' },
      });

      expect(result.data).toBeDefined();
    });

    it('should execute audio.isolate', async () => {
      const result = await provider.execute({
        operation: 'audio.isolate',
        config: {},
        params: { audio_data: Buffer.from('test-audio'), target: 'vocals' },
      });

      expect(result.costUsd).toBe(0.01);
    });

    it('should execute video.generate', async () => {
      const result = await provider.execute({
        operation: 'video.generate',
        config: {},
        params: { prompt: 'a sunset', duration: 5, aspect_ratio: '16:9' },
      });

      expect(result.costUsd).toBe(0.1);
    });

    it('should execute video.image_to_video', async () => {
      const result = await provider.execute({
        operation: 'video.image_to_video',
        config: {},
        params: { image_data: Buffer.from('test'), motion_prompt: 'zoom', duration: 5 },
      });

      expect(result.costUsd).toBe(0.08);
    });

    it('should handle string URL output by fetching it', async () => {
      mockRun.mockResolvedValue('https://storage.example.com/output.png');
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/png']]),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response);

      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test'), scale: 2 },
      });

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('image/png');
    });

    it('should handle non-URL string output', async () => {
      mockRun.mockResolvedValue('plain text output');

      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test') },
      });

      expect(result.mimeType).toBe('text/plain');
    });

    it('should handle Uint8Array output', async () => {
      mockRun.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test') },
      });

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/octet-stream');
    });

    it('should handle object output as JSON', async () => {
      mockRun.mockResolvedValue({ url: 'https://output.example.com' });

      const result = await provider.execute({
        operation: 'image.upscale',
        config: {},
        params: { image_data: Buffer.from('test') },
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
      mockRun.mockRejectedValue(new Error('API failure'));

      await expect(
        provider.execute({
          operation: 'image.upscale',
          config: {},
          params: { image_data: Buffer.from('test') },
        }),
      ).rejects.toThrow('Replicate provider error');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy when API responds ok', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy when API fails', async () => {
      const mockClient = (
        provider as unknown as { client: { fetch: (...args: unknown[]) => Promise<unknown> } }
      ).client;
      mockClient.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('401');
    });

    it('should return unhealthy on network error', async () => {
      const mockClient = (
        provider as unknown as { client: { fetch: (...args: unknown[]) => Promise<unknown> } }
      ).client;
      mockClient.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Network error');
    });
  });

  describe('estimateCost', () => {
    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should estimate for known operations', async () => {
      const r1 = await provider.estimateCost({
        operation: 'image.upscale',
        params: {},
        config: {},
      });
      expect(r1.costUsd).toBeGreaterThan(0);
    });
  });

  describe('isNonRetryableError', () => {
    it('should detect authentication failure', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('authentication failed'),
        ),
      ).toBe(true);
    });

    it('should detect invalid api key', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid api key'),
        ),
      ).toBe(true);
    });

    it('should detect permission denied', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('permission denied'),
        ),
      ).toBe(true);
    });

    it('should detect model not found', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('model not found'),
        ),
      ).toBe(true);
    });

    it('should allow retry for transient errors', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('timeout'),
        ),
      ).toBe(false);
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.ReplicateProvider).toBeDefined();
    expect(mod.defineReplicateProvider).toBeDefined();
  });
});
