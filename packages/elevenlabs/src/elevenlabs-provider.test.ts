import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsProvider } from './elevenlabs-provider.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ElevenLabsProvider', () => {
  let provider: ElevenLabsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    provider = new ElevenLabsProvider({
      apiKey: 'test-api-key',
      voices: { default: 'Rachel', 'test-voice': 'Josh' },
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('elevenlabs');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('audio.tts');
      expect(provider.supportedOperations).toHaveLength(1);
    });
  });

  describe('cacheConfig', () => {
    const { cacheConfig } = ElevenLabsProvider;

    it('should define deterministic params', () => {
      expect(cacheConfig.deterministicParams).toContain('text');
      expect(cacheConfig.deterministicParams).toContain('voice');
      expect(cacheConfig.deterministicParams).toContain('model');
    });

    it('should define empty nonDeterministicParams', () => {
      expect(cacheConfig.nonDeterministicParams).toEqual([]);
    });

    describe('normalize', () => {
      const normalize = cacheConfig.normalize;

      it('should trim and collapse whitespace in text', () => {
        const result = normalize({ text: '  hello   world ' });
        expect(result.text).toBe('hello world');
      });

      it('should preserve voice, voice_id, model, voice_settings', () => {
        const result = normalize({
          text: 'hi',
          voice: 'Rachel',
          voice_id: 'abc',
          model: 'm1',
          voice_settings: { stability: 0.5 },
        });
        expect(result.voice).toBe('Rachel');
        expect(result.voice_id).toBe('abc');
        expect(result.model).toBe('m1');
        expect(result.voice_settings).toEqual({ stability: 0.5 });
      });

      it('should handle empty inputs', () => {
        expect(normalize({})).toEqual({});
      });
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      });
    });

    it('should execute audio.tts operation', async () => {
      const result = await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world',
          voice: 'Rachel',
          speed: 1.0,
          response_format: 'mp3',
          model: 'eleven_monolingual_v1',
        },
      });

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('audio/mpeg');
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use default voice when not specified', async () => {
      const result = await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: { text: 'Hello world' },
      });

      expect(result.data).toBeDefined();
    });

    it('should handle different audio formats', async () => {
      const formats = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
      for (const format of formats) {
        const result = await provider.execute({
          operation: 'audio.tts',
          config: {},
          params: { text: 'Hello world', response_format: format },
        });
        expect(result.mimeType).not.toBe('application/octet-stream');
      }
    });

    it('should wrap speed with SSML when not 1.0', async () => {
      await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: { text: 'Hello', speed: 1.5 },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.text).toContain('<speak');
      expect(callBody.text).toContain('rate="150%"');
    });

    it('should not wrap with SSML when speed is 1.0', async () => {
      await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: { text: 'Hello', speed: 1.0 },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.text).not.toContain('<speak');
    });

    it('should throw error for unsupported operation', async () => {
      await expect(
        provider.execute({
          operation: 'unknown.operation' as unknown as string,
          config: {},
          params: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });

    it('should throw error when text is missing', async () => {
      await expect(
        provider.execute({ operation: 'audio.tts', config: {}, params: {} }),
      ).rejects.toThrow('Text is required');
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      });

      await expect(
        provider.execute({ operation: 'audio.tts', config: {}, params: { text: 'Hello world' } }),
      ).rejects.toThrow('ElevenLabs API error');
    });
  });

  describe('healthCheck', () => {
    it('should return health status when healthy', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy on API error', async () => {
      mockFetch.mockResolvedValue({ ok: false, statusText: 'Unauthorized' });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('should return unhealthy on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('Network error');
    });
  });

  describe('voice resolution', () => {
    it('should return default voice when no name given', () => {
      expect((provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice()).toBe(
        'Rachel',
      );
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(undefined),
      ).toBe('Rachel');
    });

    it('should resolve from config voices', () => {
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(
          'test-voice',
        ),
      ).toBe('Josh');
    });

    it('should resolve voice ID by prefix', () => {
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice('voice_abc'),
      ).toBe('voice_abc');
    });

    it('should resolve voice ID by length 20', () => {
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(
          '12345678901234567890',
        ),
      ).toBe('12345678901234567890');
    });

    it('should resolve named default voices', () => {
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(
          'british-male',
        ),
      ).toBe('Daniel');
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(
          'female-narrator',
        ),
      ).toBe('Rachel');
    });

    it('should fallback to default for unknown voice', () => {
      expect(
        (provider as unknown as { resolveVoice(voice?: string): string }).resolveVoice(
          'unknown-voice',
        ),
      ).toBe('Rachel');
    });
  });

  describe('getMimeType', () => {
    it('should return correct mime types', () => {
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('mp3'),
      ).toBe('audio/mpeg');
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('wav'),
      ).toBe('audio/wav');
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('ogg'),
      ).toBe('audio/ogg');
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('flac'),
      ).toBe('audio/flac');
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('aac'),
      ).toBe('audio/aac');
    });

    it('should default to audio/mpeg for unknown format', () => {
      expect(
        (provider as unknown as { getMimeType(format: string): string }).getMimeType('unknown'),
      ).toBe('audio/mpeg');
    });
  });

  describe('estimateDuration', () => {
    it('should estimate duration based on character count', () => {
      expect(
        (provider as unknown as { estimateDuration(text: string): number }).estimateDuration(
          'Hello world',
        ),
      ).toBe(1);
      expect(
        (provider as unknown as { estimateDuration(text: string): number }).estimateDuration(
          'x'.repeat(100),
        ),
      ).toBe(8);
    });
  });

  describe('cost estimation', () => {
    it('should estimate cost based on character count', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      });

      const result = await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: { text: 'Hello world' },
      });

      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should fallback to default model pricing', async () => {
      const result = await provider.estimateCost({
        operation: 'audio.tts',
        params: { text: 'test', model: 'unknown-model' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });
  });

  describe('duration estimation', () => {
    it('should include duration in metadata', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      });

      const result = await provider.execute({
        operation: 'audio.tts',
        config: {},
        params: { text: 'Hello world, this is a test.' },
      });

      expect(result.metadata.duration).toBeDefined();
      expect(typeof result.metadata.duration).toBe('number');
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
          new Error('insufficient credits'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('voice not found'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid voice id'),
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
    expect(mod.ElevenLabsProvider).toBeDefined();
    expect(mod.defineElevenLabsProvider).toBeDefined();
  });
});
