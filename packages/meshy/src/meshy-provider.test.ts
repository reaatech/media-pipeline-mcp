import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshyProvider } from './meshy-provider.js';

/**
 * Meshy provider tests.
 *
 * The provider now hits Meshy's v2 REST API (POST text-to-3d / image-to-3d, poll
 * status, download model). Tests stub fetch with three-call sequences for each
 * execute test: create → poll-completed → download.
 *
 * Health check mocks a 200 from `/users/me`. apiKey-missing path short-circuits and
 * doesn't need a mock.
 */

function mockSuccessfulSequence(fetchSpy: ReturnType<typeof vi.spyOn>, formats: string[]): void {
  const modelUrls: Record<string, string> = {};
  for (const f of formats) modelUrls[f] = `https://meshy.example/${f}.bin`;
  fetchSpy
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'task-1',
          status: 'SUCCEEDED',
          model_urls: modelUrls,
        }),
        { status: 200 },
      ) as Response,
    )
    .mockResolvedValueOnce(
      new Response(Buffer.from([0x67, 0x6c, 0x54, 0x46]), { status: 200 }) as Response,
    );
}

describe('MeshyProvider', () => {
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
      const provider = new MeshyProvider();
      expect(provider.name).toBe('meshy');
    });

    it('should support mesh.generate operation', () => {
      const provider = new MeshyProvider();
      expect(provider.supportedOperations).toContain('mesh.generate');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy=true when apiKey is configured and probe succeeds', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }) as Response);
      const provider = new MeshyProvider({ apiKey: 'test-key' });
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('should return healthy=false when apiKey is not configured', async () => {
      const provider = new MeshyProvider({});
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('MESHY_API_KEY not configured');
    });
  });

  describe('estimateCost', () => {
    it('should return cost estimate with positive costUsd', async () => {
      const provider = new MeshyProvider({ apiKey: 'test-key' });
      const cost = await provider.estimateCost({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'test' },
      });
      expect(cost.costUsd).toBeGreaterThan(0);
      expect(cost.currency).toBe('USD');
    });

    it('should price refine (textured) higher than preview', async () => {
      const provider = new MeshyProvider({ apiKey: 'test-key' });
      const previewCost = await provider.estimateCost({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'test' },
      });
      const refineCost = await provider.estimateCost({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'test', texture: { enabled: true } },
      });
      expect(refineCost.costUsd).toBeGreaterThan(previewCost.costUsd);
    });
  });

  describe('execute', () => {
    it('should execute mesh.generate with prompt and default format (glb)', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb']);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const input: ProviderInput = {
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A 3D model of a chair' },
      };
      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('model/gltf-binary');
      expect(result.metadata.format).toBe('glb');
      expect(result.metadata.prompt).toBe('A 3D model of a chair');
    });

    it('should execute mesh.generate with fbx format', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb', 'fbx']);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A chair', format: 'fbx' },
      });
      expect(result.metadata.format).toBe('fbx');
    });

    it('should execute mesh.generate with obj format', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb', 'obj']);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A chair', format: 'obj' },
      });
      expect(result.metadata.format).toBe('obj');
    });

    it('should execute mesh.generate with usdz format', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb', 'usdz']);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A chair', format: 'usdz' },
      });
      expect(result.metadata.format).toBe('usdz');
    });

    it('should fall back to glb when requested format is not in model_urls (ply not produced by Meshy)', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb']); // no ply
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'A chair', format: 'ply' },
      });
      expect(result.metadata.format).toBe('glb');
      expect(result.metadata.requestedFormat).toBe('ply');
    });

    it('should accept sourceArtifactId for image-to-3d input', async () => {
      mockSuccessfulSequence(fetchSpy, ['glb']);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: { prompt: 'Recreate this in 3D', sourceArtifactId: 'image-123' },
      });
      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('model/gltf-binary');
      expect(result.metadata.sourceArtifactId).toBe('image-123');
    });
  });

  describe('config handling', () => {
    it('should accept apiKey and baseUrl from config', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }) as Response);
      const provider = new MeshyProvider({
        apiKey: 'custom-key',
        baseUrl: 'https://custom.meshy.ai',
      });
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('custom.meshy.ai'),
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    it('should throw when apiKey is not configured', async () => {
      const provider = new MeshyProvider({});
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('MESHY_API_KEY not configured');
    });

    it('should throw when Meshy create fails', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }) as Response,
      );
      const provider = new MeshyProvider({ apiKey: 'test-key' });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Meshy create failed: 400');
    });

    it('should throw when Meshy returns no task id', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }) as Response);
      const provider = new MeshyProvider({ apiKey: 'test-key' });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('no task id');
    });

    it('should throw when Meshy poll fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }) as Response);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Meshy poll failed: 500');
    });

    it('should throw when task fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'task-1',
              status: 'FAILED',
              task_error: { message: 'content policy violation' },
            }),
            { status: 200 },
          ) as Response,
        );
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('content policy violation');
    });

    it('should throw when no model URL available', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'task-1',
              status: 'SUCCEEDED',
              model_urls: {},
            }),
            { status: 200 },
          ) as Response,
        );
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('no model URL');
    });

    it('should throw when model download fails', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'task-1',
              status: 'SUCCEEDED',
              model_urls: { glb: 'https://example.com/m.glb' },
            }),
            { status: 200 },
          ) as Response,
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }) as Response);
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      await expect(
        provider.execute({
          operation: 'mesh.generate',
          config: {},
          params: { prompt: 'test' },
        }),
      ).rejects.toThrow('Failed to download mesh');
    });

    it('should handle texture resolution parameter', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: 'task-1' }), { status: 200 }) as Response,
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'task-1',
              status: 'SUCCEEDED',
              model_urls: { glb: 'https://example.com/m.glb' },
            }),
            { status: 200 },
          ) as Response,
        )
        .mockResolvedValueOnce(
          new Response(Buffer.from([0x67, 0x6c, 0x54, 0x46]), { status: 200 }) as Response,
        );
      const provider = new MeshyProvider({ apiKey: 'test-key', pollIntervalMs: 1 });
      const result = await provider.execute({
        operation: 'mesh.generate',
        config: {},
        params: {
          prompt: 'test',
          texture: { enabled: true, resolution: 2048 },
        },
      });
      expect(result.data).toBeDefined();
    });

    it('health check returns unhealthy on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network timeout'));
      const provider = new MeshyProvider({ apiKey: 'test-key' });
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
    const p = new MeshyProvider({ apiKey: 'k' });
    expect(p.supportsStreaming?.has('mesh.generate')).toBe(true);
    expect(p.supportsWebhooks).toBe(true);
  });

  it('declares F2 cacheConfig with prompt and format in deterministicParams', () => {
    expect(MeshyProvider.cacheConfig.deterministicParams).toContain('prompt');
    expect(MeshyProvider.cacheConfig.deterministicParams).toContain('format');
    expect(MeshyProvider.cacheConfig.nonDeterministicParams).toContain('webhook_url');
  });

  it('normalize() drops webhook_url and trims strings', () => {
    const out = MeshyProvider.cacheConfig.normalize({
      prompt: '  a  prompt  ',
      format: 'glb',
      webhook_url: 'https://example.com/cb',
    });
    expect(out.prompt).toBe('a prompt');
    expect(out.format).toBe('glb');
    expect('webhook_url' in out).toBe(false);
  });
});
