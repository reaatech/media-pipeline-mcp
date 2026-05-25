import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenAIConfig } from './openai-provider.js';
import { createOpenAIProvider, OpenAIProvider } from './openai-provider.js';

const mockConfig: OpenAIConfig = {
  apiKey: 'test-api-key',
};

function mockImageFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ url: 'https://example.com/image.png', revised_prompt: 'revised' }],
      }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Response);
}

function mockChatFetch() {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'description text' } }],
    }),
  } as Response);
}

function mockAudioFetch() {
  return vi.fn().mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as Response);
}

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider(mockConfig);
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('openai');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.generate');
      expect(provider.supportedOperations).toContain('image.describe');
      expect(provider.supportedOperations).toContain('audio.tts');
      expect(provider.supportedOperations).toContain('audio.stt');
    });

    it('should use custom organization and project', () => {
      const custom = new OpenAIProvider({
        apiKey: 'key',
        organization: 'org-1',
        project: 'proj-1',
      });
      expect(custom['organization']).toBe('org-1');
      expect(custom['project']).toBe('proj-1');
    });
  });

  describe('cacheConfig', () => {
    const { cacheConfig } = OpenAIProvider;

    it('should have deterministic params', () => {
      expect(cacheConfig.deterministicParams).toContain('prompt');
      expect(cacheConfig.deterministicParams).toContain('model');
      expect(cacheConfig.deterministicParams).toContain('text');
    });

    it('should have nonDeterministicParams', () => {
      expect(cacheConfig.nonDeterministicParams).toContain('n');
      expect(cacheConfig.nonDeterministicParams).toContain('dimensions');
    });

    describe('normalize', () => {
      const normalize = cacheConfig.normalize;

      it('should trim and collapse whitespace in prompt', () => {
        expect(normalize({ prompt: '  hello   world ' }).prompt).toBe('hello world');
      });

      it('should trim and collapse whitespace in text', () => {
        expect(normalize({ text: '  foo   bar ' }).text).toBe('foo bar');
      });

      it('should map dimensions to size when provided', () => {
        const result = normalize({ prompt: 'test', dimensions: '1536x1024' });
        expect(result.size).toBe('1536x1024');
      });

      it('should preserve size when dimensions absent', () => {
        const result = normalize({ prompt: 'test', size: '1024x1024' });
        expect(result.size).toBe('1024x1024');
      });

      it('should map style_preset to style when provided', () => {
        const result = normalize({ prompt: 'test', style_preset: 'natural' });
        expect(result.style).toBe('natural');
      });

      it('should preserve style when style_preset absent', () => {
        const result = normalize({ prompt: 'test', style: 'vivid' });
        expect(result.style).toBe('vivid');
      });

      it('should handle empty inputs', () => {
        expect(normalize({})).toEqual({});
      });
    });
  });

  describe('healthCheck', () => {
    it('should return healthy on success', async () => {
      global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeDefined();
    });

    it('should return unhealthy on API error', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, statusText: 'Server Error' } as Response),
      );

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toContain('500');
    });

    it('should return unhealthy on network error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('connect error')));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('connect error');
    });
  });

  describe('execute', () => {
    it('should throw for unsupported operations', async () => {
      await expect(
        provider.execute({ operation: 'unsupported.operation', params: {}, config: {} }),
      ).rejects.toThrow('Unsupported operation');
    });

    describe('image.generate', () => {
      it('should generate successfully', async () => {
        global.fetch = mockImageFetch();

        const result = await provider.execute({
          operation: 'image.generate',
          params: { prompt: 'test' },
          config: {},
        });

        expect(result.mimeType).toBe('image/png');
        expect(result.metadata.revised_prompt).toBe('revised');
        expect(result.costUsd).toBe(0.04);
      });

      it('should honor dimensions, style_preset, num_outputs', async () => {
        const fetchMock = mockImageFetch();
        global.fetch = fetchMock;

        await provider.execute({
          operation: 'image.generate',
          params: {
            prompt: 'test',
            dimensions: '1536x1024',
            style_preset: 'natural',
            num_outputs: 2,
          },
          config: {},
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          'https://api.openai.com/v1/images/generations',
          expect.objectContaining({
            body: JSON.stringify({
              model: 'dall-e-3',
              prompt: 'test',
              n: 2,
              size: '1536x1024',
              quality: 'standard',
              style: 'natural',
            }),
          }),
        );
      });

      it('should throw on empty data', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [] }),
        } as Response);

        await expect(
          provider.execute({ operation: 'image.generate', params: { prompt: 'test' }, config: {} }),
        ).rejects.toThrow('No image generated');
      });

      it('should throw on API error', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          text: async () => 'Rate limit',
        } as Response);

        await expect(
          provider.execute({ operation: 'image.generate', params: { prompt: 'test' }, config: {} }),
        ).rejects.toThrow('OpenAI error: Rate limit');
      });
    });

    describe('image.describe', () => {
      it('should describe image successfully', async () => {
        global.fetch = mockChatFetch();

        const result = await provider.execute({
          operation: 'image.describe',
          params: {
            artifact_data: Buffer.from('img'),
            mime_type: 'image/jpeg',
            detail_level: 'brief',
          },
          config: {},
        });

        expect(result.mimeType).toBe('text/plain');
        expect(result.metadata.detail).toBe('brief');
      });

      it('should default to detailed level', async () => {
        global.fetch = mockChatFetch();

        const result = await provider.execute({
          operation: 'image.describe',
          params: { artifact_data: Buffer.from('img') },
          config: {},
        });

        expect(result.metadata.detail).toBe('detailed');
      });

      it('should throw on API error', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          text: async () => 'Bad request',
        } as Response);

        await expect(
          provider.execute({
            operation: 'image.describe',
            params: { artifact_data: Buffer.from('img') },
            config: {},
          }),
        ).rejects.toThrow('OpenAI error: Bad request');
      });
    });

    describe('audio.tts', () => {
      it('should generate speech', async () => {
        global.fetch = mockAudioFetch();

        const result = await provider.execute({
          operation: 'audio.tts',
          params: { text: 'hello', voice: 'alloy', speed: 1.5 },
          config: {},
        });

        expect(result.mimeType).toBe('audio/mpeg');
        expect(result.metadata.voice).toBe('alloy');
        expect(result.metadata.speed).toBe(1.5);
      });

      it('should handle output_format alias', async () => {
        global.fetch = mockAudioFetch();

        const result = await provider.execute({
          operation: 'audio.tts',
          params: { text: 'hello', output_format: 'wav' },
          config: {},
        });

        expect(result.mimeType).toBe('audio/wav');
        expect(result.metadata.format).toBe('wav');
      });

      it('should throw on API error', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          text: async () => 'Unauthorized',
        } as Response);

        await expect(
          provider.execute({
            operation: 'audio.tts',
            params: { text: 'hello' },
            config: {},
          }),
        ).rejects.toThrow('OpenAI error: Unauthorized');
      });
    });

    describe('audio.stt', () => {
      it('should transcribe audio', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            text: 'hello world',
            segments: [{ start: 0, end: 1, text: 'hello world' }],
          }),
        } as Response);

        const result = await provider.execute({
          operation: 'audio.stt',
          params: { audio_data: Buffer.from('audio'), language: 'en' },
          config: {},
        });

        expect(result.mimeType).toBe('application/json');
        expect(result.metadata.language).toBe('en');
      });

      it('should throw on API error', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce({
          ok: false,
          text: async () => 'Invalid audio',
        } as Response);

        await expect(
          provider.execute({
            operation: 'audio.stt',
            params: { audio_data: Buffer.from('audio') },
            config: {},
          }),
        ).rejects.toThrow('OpenAI error: Invalid audio');
      });
    });
  });

  describe('estimateCost', () => {
    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should estimate image.generate cost - standard', async () => {
      const result = await provider.estimateCost({
        operation: 'image.generate',
        params: { quality: 'standard', dimensions: '1024x1024' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should estimate image.generate cost - hd large', async () => {
      const result = await provider.estimateCost({
        operation: 'image.generate',
        params: { quality: 'hd', dimensions: '1792x1024' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should estimate audio.tts cost', async () => {
      const result = await provider.estimateCost({
        operation: 'audio.tts',
        params: { text: 'hello world', model: 'tts-1' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should estimate audio.stt cost', async () => {
      const result = await provider.estimateCost({
        operation: 'audio.stt',
        params: { audio_data: Buffer.alloc(960 * 1024), model: 'whisper-1' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should default to token-based pricing for unknown image.describe', async () => {
      const result = await provider.estimateCost({
        operation: 'image.describe',
        params: {},
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });
  });

  describe('createOpenAIProvider', () => {
    it('should create provider instance', () => {
      const instance = createOpenAIProvider(mockConfig);
      expect(instance).toBeInstanceOf(OpenAIProvider);
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.OpenAIProvider).toBeDefined();
    expect(mod.createOpenAIProvider).toBeDefined();
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
