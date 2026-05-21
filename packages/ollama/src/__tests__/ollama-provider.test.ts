import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../ollama-provider.js';
import type { OllamaConfig } from '../ollama-provider.js';

type OllamaProviderForTest = {
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
};

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  const mockProviderInput = { operation: '', params: {}, config: {} };

  beforeEach(() => {
    provider = new OllamaProvider();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('ollama');
    });

    it('should have static id', () => {
      expect(OllamaProvider.id).toBe('ollama');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('text.complete');
      expect(provider.supportedOperations).toContain('embedding.generate');
      expect(provider.supportedOperations).toContain('image.describe');
    });

    it('should set default config values', () => {
      expect((provider as unknown as OllamaProviderForTest).baseUrl).toBe('http://localhost:11434');
      expect((provider as unknown as OllamaProviderForTest).defaultModel).toBe('llama3.2');
      expect((provider as unknown as OllamaProviderForTest).timeoutMs).toBe(120_000);
    });

    it('should accept custom config', () => {
      const config: OllamaConfig = {
        baseUrl: 'http://custom:11434',
        defaultModel: 'mistral',
        timeoutMs: 30_000,
        autoPull: true,
        headers: { 'X-Custom': 'value' },
      };
      const custom = new OllamaProvider(config);
      expect((custom as unknown as OllamaProviderForTest).baseUrl).toBe('http://custom:11434');
      expect((custom as unknown as OllamaProviderForTest).defaultModel).toBe('mistral');
      expect((custom as unknown as OllamaProviderForTest).timeoutMs).toBe(30_000);
    });
  });

  describe('estimateCost', () => {
    it('should return zero cost', async () => {
      const cost = await provider.estimateCost(mockProviderInput);
      expect(cost.costUsd).toBe(0);
      expect(cost.currency).toBe('USD');
    });
  });

  describe('healthCheck', () => {
    it('should return health status when ollama is reachable', async () => {
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

    it('should execute text.complete', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          response: 'Hello! How can I help you?',
          done: true,
          total_duration: 1000000,
          eval_duration: 500000,
        }),
      });

      const result = await provider.execute({
        operation: 'text.complete',
        params: { prompt: 'Say hello' },
        config: {},
      });

      expect(result.mimeType).toBe('text/plain');
      expect(result.data.toString()).toBe('Hello! How can I help you?');
      expect(result.metadata.model).toBe('llama3.2');
      expect(result.costUsd).toBe(0);
    });

    it('should execute embedding.generate', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        }),
      });

      const result = await provider.execute({
        operation: 'embedding.generate',
        params: { input: 'test text' },
        config: {},
      });

      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.dimensions).toBe(5);
      expect(result.costUsd).toBe(0);
    });

    it('should execute image.describe', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: 'llama3.2-vision',
          response: 'An image of a cat sitting on a couch.',
          done: true,
          total_duration: 2000000,
        }),
      });

      const result = await provider.execute({
        operation: 'image.describe',
        params: {
          artifact_data: Buffer.from('fake-image-bytes'),
          prompt: 'What is in this image?',
        },
        config: {},
      });

      expect(result.mimeType).toBe('text/plain');
      expect(result.data.toString()).toBe('An image of a cat sitting on a couch.');
      expect(result.metadata.model).toBe('llama3.2-vision');
    });

    it('should propagate ollama errors', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        text: async () => 'model not found',
      });

      await expect(
        provider.execute({
          operation: 'text.complete',
          params: { prompt: 'test' },
          config: {},
        }),
      ).rejects.toThrow('Ollama error: model not found');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('OllamaProvider — F10 autoPull', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('pulls the model before first use when autoPull=true and model is absent', async () => {
    const provider = new OllamaProvider({ autoPull: true });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      // 1) /api/tags response — model absent
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
      // 2) /api/pull response — success
      .mockResolvedValueOnce({ ok: true, text: async () => 'pulled' })
      // 3) /api/generate response — completion
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'llama3.2', response: 'ok', done: true }),
      });

    await provider.execute({
      operation: 'text.complete',
      params: { prompt: 'hi', model: 'llama3.2' },
      config: {},
    });

    // Validate the pull URL was hit.
    const pullCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/pull'));
    expect(pullCall).toBeDefined();
    expect(JSON.parse(String((pullCall![1] as { body: string }).body))).toMatchObject({
      name: 'llama3.2',
    });
  });

  it('skips the pull when the model is already present', async () => {
    const provider = new OllamaProvider({ autoPull: true });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'llama3.2' }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ model: 'llama3.2', response: 'ok', done: true }),
      });

    await provider.execute({
      operation: 'text.complete',
      params: { prompt: 'hi', model: 'llama3.2' },
      config: {},
    });

    const pullCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/pull'));
    expect(pullCalls).toHaveLength(0);
  });

  it('does not pull when autoPull is false (default)', async () => {
    const provider = new OllamaProvider();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ model: 'llama3.2', response: 'ok', done: true }),
    });

    await provider.execute({
      operation: 'text.complete',
      params: { prompt: 'hi' },
      config: {},
    });

    // Should not hit /api/tags either when autoPull is off.
    const tagsCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/tags'));
    expect(tagsCalls).toHaveLength(0);
  });

  it('throws when /api/pull fails', async () => {
    const provider = new OllamaProvider({ autoPull: true });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' });

    await expect(
      provider.execute({
        operation: 'text.complete',
        params: { prompt: 'hi', model: 'llama3.2' },
        config: {},
      }),
    ).rejects.toThrow(/autoPull failed/);
  });
});

describe('§0.6 capability flags + F2 cacheConfig', () => {
  it('declares supportsWebhooks=false per F10 plan', () => {
    const p = new OllamaProvider();
    expect(p.supportsWebhooks).toBe(false);
  });

  it('keeps supportsStreaming set for text.complete and embedding.generate', () => {
    const p = new OllamaProvider();
    expect(p.supportsStreaming?.has('text.complete')).toBe(true);
    expect(p.supportsStreaming?.has('embedding.generate')).toBe(true);
  });

  it('declares a cacheConfig with prompt/model/seed in deterministicParams', () => {
    expect(OllamaProvider.cacheConfig.deterministicParams).toContain('prompt');
    expect(OllamaProvider.cacheConfig.deterministicParams).toContain('model');
    expect(OllamaProvider.cacheConfig.deterministicParams).toContain('seed');
    expect(OllamaProvider.cacheConfig.nonDeterministicParams).toContain('stream');
  });

  it('normalize() trims whitespace and drops `stream`', () => {
    const out = OllamaProvider.cacheConfig.normalize({
      prompt: '  hello   world  ',
      model: 'llama3.2',
      stream: true,
    });
    expect(out.prompt).toBe('hello world');
    expect(out.model).toBe('llama3.2');
    expect('stream' in out).toBe(false);
  });
});
