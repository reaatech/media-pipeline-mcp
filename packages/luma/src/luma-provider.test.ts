import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LumaProvider } from './luma-provider.js';

/**
 * Luma provider tests.
 *
 * The provider now makes real HTTP calls to the Luma Dream Machine API. Tests mock
 * `global.fetch` to validate the request/response contract without hitting the network.
 * Health check and metadata tests don't need the mock since they short-circuit on the
 * apiKey check or never make a request.
 */

describe('LumaProvider', () => {
  let fetchSpy!: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(
      global as unknown as { fetch: typeof fetch },
      'fetch',
    ) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      const provider = new LumaProvider();
      expect(provider.name).toBe('luma');
    });

    it('should support mesh.generate operation', () => {
      const provider = new LumaProvider();
      expect(provider.supportedOperations).toContain('mesh.generate');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy=true when apiKey is configured and probe succeeds', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }) as Response,
      );
      const provider = new LumaProvider({ apiKey: 'test-key' });
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('should return healthy=false when apiKey is not configured', async () => {
      const provider = new LumaProvider({});
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('LUMA_API_KEY not configured');
    });
  });

  describe('estimateCost', () => {
    it('should return cost estimate with positive costUsd', async () => {
      const provider = new LumaProvider({ apiKey: 'test-key' });
      const cost = await provider.estimateCost({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'test' },
      });
      expect(cost.costUsd).toBeGreaterThan(0);
      expect(cost.currency).toBe('USD');
    });
  });

  describe('execute', () => {
    it('should execute mesh.generate via Dream Machine API and return mesh artifact', async () => {
      // Sequence: POST /generations → 200 (queued), GET /generations/:id → 200 (completed),
      // then GET <model_url> → 200 (binary glb).
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'gen-1', state: 'queued' }), {
            status: 200,
          }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'gen-1',
              state: 'completed',
              assets: { mesh: { glb: 'https://luma.example/mesh-1.glb' } },
            }),
            { status: 200 },
          ) as Response,
        )
        .mockResolvedValueOnce(
          new Response(Buffer.from([0x67, 0x6c, 0x54, 0x46]), { status: 200 }) as Response,
        );

      const provider = new LumaProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const input: ProviderInput = {
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A 3D model of a table' },
      };
      const result = await provider.execute(input);
      expect(result.mimeType).toBe('model/gltf-binary');
      expect(result.metadata.format).toBe('glb');
      expect(result.metadata.prompt).toBe('A 3D model of a table');
      expect(result.costUsd).toBe(0.3);
    });
  });

  describe('config handling', () => {
    it('should accept apiKey and baseUrl from config', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }) as Response,
      );
      const provider = new LumaProvider({
        apiKey: 'custom-key',
        baseUrl: 'https://custom.luma.ai',
      });
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      // Verify the custom baseUrl is honored.
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('custom.luma.ai'),
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    it('should throw when Luma API returns non-ok on create', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }) as Response,
      );
      const provider = new LumaProvider({ apiKey: 'test-key' });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Luma create failed: 429');
    });

    it('should throw when Luma poll returns non-ok', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'gen-1', state: 'queued' }), {
            status: 200,
          }) as Response,
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }) as Response);
      const provider = new LumaProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Luma poll failed: 500');
    });

    it('should throw when generation fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'gen-1', state: 'queued' }), {
            status: 200,
          }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'gen-1',
              state: 'failed',
              failure_reason: 'content rejected',
            }),
            { status: 200 },
          ) as Response,
        );
      const provider = new LumaProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('content rejected');
    });

    it('should throw when Luma succeeds but no mesh URL', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'gen-1', state: 'queued' }), {
            status: 200,
          }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'gen-1',
              state: 'completed',
              assets: { mesh: null },
            }),
            { status: 200 },
          ) as Response,
        );
      const provider = new LumaProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('no mesh URL');
    });

    it('should throw when model download fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'gen-1', state: 'queued' }), {
            status: 200,
          }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'gen-1',
              state: 'completed',
              assets: { mesh: { glb: 'https://example.com/model.glb' } },
            }),
            { status: 200 },
          ) as Response,
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }) as Response);
      const provider = new LumaProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Failed to download Luma mesh');
    });

    it('health check returns unhealthy on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network timeout'));
      const provider = new LumaProvider({ apiKey: 'test-key' });
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Network timeout');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('F21 §0.6 capability flags + F2 cacheConfig', () => {
  it('declares supportsStreaming + supportsWebhooks per §0.6', () => {
    const p = new LumaProvider({ apiKey: 'k' });
    expect(p.supportsStreaming?.has('mesh.generate')).toBe(true);
    expect(p.supportsWebhooks).toBe(true);
  });

  it('declares F2 cacheConfig with prompt and format in deterministicParams', () => {
    expect(LumaProvider.cacheConfig.deterministicParams).toContain('prompt');
    expect(LumaProvider.cacheConfig.deterministicParams).toContain('format');
    expect(LumaProvider.cacheConfig.nonDeterministicParams).toContain('webhook_url');
  });

  it('normalize() drops webhook_url and trims strings', () => {
    const out = LumaProvider.cacheConfig.normalize({
      prompt: '  a  prompt  ',
      format: 'glb',
      webhook_url: 'https://example.com/cb',
    });
    expect(out.prompt).toBe('a prompt');
    expect(out.format).toBe('glb');
    expect('webhook_url' in out).toBe(false);
  });
});
