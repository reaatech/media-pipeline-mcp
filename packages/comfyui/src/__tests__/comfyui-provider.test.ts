import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyUIConfig } from '../comfyui-provider.js';
import { ComfyUIProvider } from '../comfyui-provider.js';

const mockInput = { operation: '', params: {}, config: {} };

type ComfyUIProviderForTest = {
  baseUrl: string;
  pollIntervalMs: number;
  retentionMs: number;
  downloadOutputs: boolean;
  pollForCompletion(promptId: string): Promise<Record<string, unknown>>;
  mimeTypeFromFilename(filename: string): string;
  setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void;
};

describe('ComfyUIProvider', () => {
  let provider: ComfyUIProvider;

  beforeEach(() => {
    provider = new ComfyUIProvider();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('comfyui');
    });

    it('should have static id', () => {
      expect(ComfyUIProvider.id).toBe('comfyui');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.generate');
      expect(provider.supportedOperations).toContain('image.edit');
      expect(provider.supportedOperations).toContain('video.generate');
    });

    it('should set default config values', () => {
      expect((provider as unknown as ComfyUIProviderForTest).baseUrl).toBe('http://localhost:8188');
      expect((provider as unknown as ComfyUIProviderForTest).pollIntervalMs).toBe(1000);
      expect((provider as unknown as ComfyUIProviderForTest).retentionMs).toBe(600_000);
      expect((provider as unknown as ComfyUIProviderForTest).downloadOutputs).toBe(true);
    });

    it('should accept custom config', () => {
      const config: ComfyUIConfig = {
        baseUrl: 'http://custom:8188',
        pollIntervalMs: 500,
        retentionMs: 300_000,
        downloadOutputs: false,
      };
      const custom = new ComfyUIProvider(config);
      expect((custom as unknown as ComfyUIProviderForTest).baseUrl).toBe('http://custom:8188');
      expect((custom as unknown as ComfyUIProviderForTest).pollIntervalMs).toBe(500);
      expect((custom as unknown as ComfyUIProviderForTest).retentionMs).toBe(300_000);
      expect((custom as unknown as ComfyUIProviderForTest).downloadOutputs).toBe(false);
    });
  });

  describe('workflow management', () => {
    it('should list built-in workflows', () => {
      const workflows = provider.listWorkflows();
      expect(workflows).toContain('sdxl-text2img');
      expect(workflows).toContain('sdxl-img2img');
      expect(workflows).toContain('flux-text2img');
      expect(workflows).toContain('svd-img2vid');
    });

    it('should register custom workflows', () => {
      provider.registerWorkflow('custom', {
        name: 'Custom Workflow',
        apiFormat: {},
        inputs: { test: { path: '1.inputs.value', type: 'string', required: true } },
        outputs: { '1': 'image' },
      });

      const workflow = provider.getWorkflow('custom');
      expect(workflow).toBeDefined();
      expect(workflow!.name).toBe('Custom Workflow');
    });
  });

  describe('estimateCost', () => {
    it('should return zero cost', async () => {
      const cost = await provider.estimateCost(mockInput);
      expect(cost.costUsd).toBe(0);
      expect(cost.currency).toBe('USD');
    });
  });

  describe('healthCheck', () => {
    it('should return health status when comfyui is reachable', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      } as Response);

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeDefined();
    });

    it('should return unhealthy on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should return unhealthy on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      } as Response);

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('HTTP 503: Service Unavailable');
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      global.fetch = vi.fn();
    });

    it('should throw for unsupported operations', async () => {
      await expect(
        provider.execute({
          operation: 'unsupported.operation',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });

    it('should execute image.generate workflow', async () => {
      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ prompt_id: 'test-prompt-123', number: 1, node_errors: {} }),
      });

      fetchMock
        .mockResolvedValueOnce({
          status: 404,
          ok: false,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            'test-prompt-123': {
              prompt: {},
              outputs: {
                '9': {
                  images: [{ filename: 'ComfyUI_00001.png', subfolder: '', type: 'output' }],
                },
              },
              status: { completed: true },
            },
          }),
        });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
        headers: new Map([['content-type', 'image/png']]),
      });

      const result = await provider.execute({
        operation: 'image.generate',
        params: {
          prompt: 'A beautiful sunset over mountains',
          dimensions: '1024x1024',
          steps: 30,
          seed: 42,
        },
        config: {},
      });

      expect(result.mimeType).toBe('image/png');
      expect(result.metadata.filename).toBe('ComfyUI_00001.png');
      expect(result.costUsd).toBe(0);
    });

    it('should throw on missing required input', async () => {
      await expect(
        provider.execute({
          operation: 'image.generate',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Missing required input');
    });

    it('should throw when sdxl-img2img is missing its required image input', async () => {
      // Built-in workflow now exists; assert the param-validation error instead.
      await expect(
        provider.execute({
          operation: 'image.edit',
          params: { prompt: 'test' },
          config: {},
        }),
      ).rejects.toThrow('Missing required input: image');
    });

    it('should throw when svd-img2vid is missing its required image input', async () => {
      // video.generate now routes to the built-in svd-img2vid workflow.
      await expect(
        provider.execute({
          operation: 'video.generate',
          params: { prompt: 'test' },
          config: {},
        }),
      ).rejects.toThrow('Missing required input: image');
    });

    it('should throw when an unknown `workflow:<slug>` is requested', async () => {
      await expect(
        provider.execute({
          operation: 'image.generate',
          params: { prompt: 'x', model: 'workflow:nope' },
          config: {},
        }),
      ).rejects.toThrow('Workflow not found: nope');
    });
  });
});

describe('runWorkflow - POST /prompt error', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('should throw on non-ok prompt response', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'Invalid prompt',
    });

    const p = new ComfyUIProvider();
    await expect(
      p.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('ComfyUI error: Invalid prompt');
  });
});

describe('runWorkflow - dimensions edge cases', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('should skip invalid dimensions string', async () => {
    const p = new ComfyUIProvider();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'test-prompt-456', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        'test-prompt-456': {
          prompt: {},
          outputs: { '9': { images: [{ filename: 'test.png', subfolder: '', type: 'output' }] } },
          status: { completed: true },
        },
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    const result = await p.execute({
      operation: 'image.generate',
      params: { prompt: 'test', dimensions: 'invalid' },
      config: {},
    });
    expect(result.mimeType).toBe('image/png');
  });

  it('should handle dimensions with valid width/height', async () => {
    const p = new ComfyUIProvider();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'test-prompt-789', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        'test-prompt-789': {
          prompt: {},
          outputs: { '9': { images: [{ filename: 'test.png', subfolder: '', type: 'output' }] } },
          status: { completed: true },
        },
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    const result = await p.execute({
      operation: 'image.generate',
      params: { prompt: 'test', dimensions: '512x512' },
      config: {},
    });
    expect(result.mimeType).toBe('image/png');
  });
});

describe('runWorkflow - download failure and no outputs', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('should throw when image download fails', async () => {
    const p = new ComfyUIProvider();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'test-prompt-dl', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        'test-prompt-dl': {
          prompt: {},
          outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
          status: { completed: true },
        },
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      statusText: 'Not Found',
    });

    await expect(
      p.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('Failed to download output image: Not Found');
  });

  it('should throw when downloadOutputs is false and no outputs', async () => {
    const noDownloadProvider = new ComfyUIProvider({ downloadOutputs: false });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'test-prompt-nodl', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        'test-prompt-nodl': {
          prompt: {},
          outputs: { '9': { images: [] } },
          status: { completed: true },
        },
      }),
    });

    await expect(
      noDownloadProvider.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('No output images produced by workflow');
  });
});

describe('pollForCompletion - error paths', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('should handle non-ok non-404 by continuing polling', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'poll-500', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 500, ok: false });

    const p = new ComfyUIProvider({ pollIntervalMs: 1, retentionMs: 10 });

    await expect(
      p.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('did not complete within retention period');
  });

  it('should handle non-ok 404 by continuing polling', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'poll-404', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false });

    const fastProvider = new ComfyUIProvider({ pollIntervalMs: 1, retentionMs: 10 });

    await expect(
      fastProvider.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('did not complete within retention period');
  });

  it('should timeout when workflow error status is returned', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        'poll-error': {
          prompt: {},
          outputs: {},
          status: { completed: false, status_str: 'error' },
        },
      }),
    });
    fetchMock.mockResolvedValue({ status: 404, ok: false });

    const p = new ComfyUIProvider({ pollIntervalMs: 1, retentionMs: 10 });
    await expect(
      (p as unknown as ComfyUIProviderForTest).pollForCompletion('poll-error'),
    ).rejects.toThrow('did not complete within retention period');
  });

  it('should handle fetch rejection during polling', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'poll-reject', number: 1, node_errors: {} }),
    });
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const fastProvider = new ComfyUIProvider({ pollIntervalMs: 1, retentionMs: 10 });

    await expect(
      fastProvider.execute({
        operation: 'image.generate',
        params: { prompt: 'test' },
        config: {},
      }),
    ).rejects.toThrow('did not complete within retention period');
  });
});

describe('mimeTypeFromFilename', () => {
  it('should return image/png for .png', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.png')).toBe(
      'image/png',
    );
  });

  it('should return image/jpeg for .jpg and .jpeg', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.jpg')).toBe(
      'image/jpeg',
    );
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.jpeg')).toBe(
      'image/jpeg',
    );
  });

  it('should return image/webp for .webp', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.webp')).toBe(
      'image/webp',
    );
  });

  it('should return video/mp4 for .mp4', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.mp4')).toBe(
      'video/mp4',
    );
  });

  it('should return video/webm for .webm', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.webm')).toBe(
      'video/webm',
    );
  });

  it('should return application/octet-stream for unknown extension', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test.unknown')).toBe(
      'application/octet-stream',
    );
  });

  it('should return application/octet-stream when no extension', () => {
    const p = new ComfyUIProvider();
    expect((p as unknown as ComfyUIProviderForTest).mimeTypeFromFilename('test')).toBe(
      'application/octet-stream',
    );
  });
});

describe('setNestedValue', () => {
  it('should create nested objects', () => {
    const p = new ComfyUIProvider();
    const obj: Record<string, unknown> = {};
    (p as unknown as ComfyUIProviderForTest).setNestedValue(obj, 'a.b.c', 'value');
    expect((obj as Record<string, Record<string, { c: string }>>).a.b.c).toBe('value');
  });

  it('should convert width/height from string to number', () => {
    const p = new ComfyUIProvider();
    const obj: Record<string, unknown> = {};
    (p as unknown as ComfyUIProviderForTest).setNestedValue(obj, 'outputs.width', '1024');
    expect(obj.outputs).toEqual({ width: 1024 });
  });
});

describe('createComfyUIProvider', () => {
  it('should create a provider with custom config', async () => {
    const mod = await import('../comfyui-provider.js');
    const instance = mod.createComfyUIProvider({ baseUrl: 'http://test:8188' });
    expect(instance.name).toBe('comfyui');
    expect((instance as unknown as ComfyUIProviderForTest).baseUrl).toBe('http://test:8188');
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('F10 typed errors + §0.6 capabilities', () => {
  it('throws WorkflowNotFoundError (typed, code WORKFLOW_NOT_FOUND) for unknown workflow', async () => {
    const { WorkflowNotFoundError } = await import('@reaatech/media-pipeline-mcp-core');
    const p = new ComfyUIProvider();
    try {
      await p.execute({
        operation: 'image.generate',
        params: { prompt: 'x', model: 'workflow:nope' },
        config: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowNotFoundError);
      expect((err as { code?: string }).code).toBe('WORKFLOW_NOT_FOUND');
      expect((err as Error).message).toContain('nope');
    }
  });

  it('throws WorkflowExpiredError (typed, code WORKFLOW_EXPIRED) when polling exceeds retention', async () => {
    const { WorkflowExpiredError } = await import('@reaatech/media-pipeline-mcp-core');
    global.fetch = vi.fn();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ prompt_id: 'expire-test', number: 1, node_errors: {} }),
    });
    fetchMock.mockResolvedValue({ status: 404, ok: false });

    const p = new ComfyUIProvider({ pollIntervalMs: 1, retentionMs: 5 });
    try {
      await p.execute({ operation: 'image.generate', params: { prompt: 'x' }, config: {} });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowExpiredError);
      expect((err as { code?: string }).code).toBe('WORKFLOW_EXPIRED');
    }
  });

  it('throws InvalidInputError (typed, code INVALID_INPUT) for missing required input', async () => {
    const { InvalidInputError } = await import('@reaatech/media-pipeline-mcp-core');
    const p = new ComfyUIProvider();
    try {
      await p.execute({ operation: 'image.edit', params: { prompt: 'test' }, config: {} });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as { code?: string }).code).toBe('INVALID_INPUT');
      expect((err as Error).message).toContain('Missing required input: image');
    }
  });

  it('declares §0.6 capability flags per plan', () => {
    const p = new ComfyUIProvider();
    expect(p.supportsWebhooks).toBe(false);
    expect(p.supportsStreaming?.has('image.generate')).toBe(true);
    expect(p.supportsStreaming?.has('video.generate')).toBe(true);
  });

  it('declares F2 cacheConfig with prompt/seed in deterministicParams', () => {
    expect(ComfyUIProvider.cacheConfig.deterministicParams).toContain('prompt');
    expect(ComfyUIProvider.cacheConfig.deterministicParams).toContain('seed');
    expect(ComfyUIProvider.cacheConfig.deterministicParams).toContain('cfg');
    // Normalize collapses whitespace, returns a plain object
    const out = ComfyUIProvider.cacheConfig.normalize({ prompt: '  hello   world  ', seed: 42 });
    expect(out.prompt).toBe('hello world');
    expect(out.seed).toBe(42);
  });
});

describe('F10 workflowsDir loader', () => {
  it('loads custom workflows from a directory on first execute', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'comfy-wf-'));
    try {
      const wf = {
        name: 'my-flow',
        apiFormat: { '1': { class_type: 'Node', inputs: { value: 'x' } } },
        inputs: {
          value: {
            path: '1.inputs.value',
            type: 'string',
            required: false,
            default: 'default-val',
          },
        },
        outputs: { '1': 'image' as const },
      };
      await writeFile(join(dir, 'my-flow.json'), JSON.stringify(wf), 'utf8');

      const p = new ComfyUIProvider({ workflowsDir: dir });
      // Trigger lazy load.
      await p.loadWorkflowsFromDir();
      const loaded = p.getWorkflow('custom/my-flow');
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('my-flow');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
