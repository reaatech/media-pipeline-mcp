import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramProvider } from './deepgram-provider.js';

const mockTranscribeFile = vi.hoisted(() => vi.fn());
const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('@deepgram/sdk', () => {
  return {
    DeepgramClient: vi.fn(() => ({
      listen: {
        v1: {
          media: {
            transcribeFile: mockTranscribeFile,
          },
        },
      },
    })),
  };
});

function makeMockTranscribeResponse(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {},
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: 'Hello world, this is a test.',
              confidence: 0.95,
              words: [
                { word: 'Hello', start: 0, end: 0.5, confidence: 0.98 },
                { word: 'world', start: 0.5, end: 1.0, confidence: 0.97 },
              ],
            },
          ],
        },
      ],
      utterances: [
        { speaker: 'Speaker 1', transcript: 'Hello world', start: 0, end: 1, confidence: 0.95 },
        {
          speaker: 'Speaker 2',
          transcript: 'This is a test',
          start: 1,
          end: 2,
          confidence: 0.93,
        },
      ],
    },
    ...overrides,
  };
}

describe('DeepgramProvider', () => {
  let provider: DeepgramProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTranscribeFile.mockResolvedValue(makeMockTranscribeResponse());
    provider = new DeepgramProvider({
      apiKey: 'test-api-key',
      models: { stt: 'nova-2', diarize: 'nova-2' },
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('deepgram');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('audio.stt');
      expect(provider.supportedOperations).toContain('audio.diarize');
    });
  });

  describe('execute', () => {
    it('should execute audio.stt operation', async () => {
      const input: ProviderInput = {
        operation: 'audio.stt',
        config: {},
        params: { audio_data: Buffer.from('mock-audio-data'), language: 'en', diarize: false },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/json');
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    });

    it('should execute audio.stt with diarize enabled', async () => {
      const input: ProviderInput = {
        operation: 'audio.stt',
        config: {},
        params: { audio_data: Buffer.from('mock'), diarize: true },
      };

      const result = await provider.execute(input);
      expect(result.metadata.diarized).toBe(true);
    });

    it('should execute audio.diarize operation', async () => {
      const input: ProviderInput = {
        operation: 'audio.diarize',
        config: {},
        params: { audio_data: Buffer.from('mock-audio-data'), language: 'en' },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
      expect(result.metadata.speakerCount).toBeGreaterThan(0);
    });

    it('should throw when no transcription result received', async () => {
      mockTranscribeFile.mockResolvedValue(null);

      await expect(
        provider.execute({
          operation: 'audio.stt',
          config: {},
          params: { audio_data: Buffer.from('test') },
        }),
      ).rejects.toThrow('No transcription result received');
    });

    it('should throw when no diarization result received', async () => {
      mockTranscribeFile.mockResolvedValue(null);

      await expect(
        provider.execute({
          operation: 'audio.diarize',
          config: {},
          params: { audio_data: Buffer.from('test') },
        }),
      ).rejects.toThrow('No diarization result received');
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
  });

  describe('healthCheck', () => {
    afterEach(() => {
      mockFetch.mockReset();
    });

    it('should return healthy when API responds ok', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy on API error', async () => {
      mockFetch.mockResolvedValue({ ok: false, statusText: 'Forbidden' });

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

  describe('estimateCost', () => {
    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should estimate cost for audio.stt', async () => {
      const result = await provider.estimateCost({
        operation: 'audio.stt',
        params: { audio_data: Buffer.alloc(960 * 1024), model: 'nova-2' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should estimate minimum cost for small audio', async () => {
      const result = await provider.estimateCost({
        operation: 'audio.stt',
        params: { audio_data: Buffer.alloc(100) },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });
  });

  describe('extractSegments', () => {
    it('should extract word-level segments from result', () => {
      const result = makeMockTranscribeResponse();
      const segments = (
        provider as unknown as {
          extractSegments(
            result: Record<string, unknown>,
          ): Array<{ text: string; start: number; end: number; confidence: number }>;
        }
      ).extractSegments(result);
      expect(segments).toHaveLength(2);
      expect(segments[0].text).toBe('Hello');
      expect(segments[1].text).toBe('world');
    });

    it('should handle missing words gracefully', () => {
      const segments = (
        provider as unknown as {
          extractSegments(
            result: Record<string, unknown>,
          ): Array<{ text: string; start: number; end: number; confidence: number }>;
        }
      ).extractSegments({
        results: { channels: [{ alternatives: [{}] }] },
      });
      expect(segments).toEqual([]);
    });
  });

  describe('countUniqueSpeakers', () => {
    it('should count unique speakers', () => {
      const count = (
        provider as unknown as {
          countUniqueSpeakers(utterances: Array<{ speaker: string }>): number;
        }
      ).countUniqueSpeakers([{ speaker: 'A' }, { speaker: 'B' }, { speaker: 'A' }]);
      expect(count).toBe(2);
    });

    it('should handle empty utterances', () => {
      expect(
        (
          provider as unknown as {
            countUniqueSpeakers(utterances: Array<{ speaker: string }>): number;
          }
        ).countUniqueSpeakers([]),
      ).toBe(0);
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
          new Error('unsupported model'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid audio format'),
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
    expect(mod.DeepgramProvider).toBeDefined();
    expect(mod.defineDeepgramProvider).toBeDefined();
  });
});

describe('DeepgramProvider.cacheConfig (F2)', () => {
  it('hashes audio_data into audio_sha256 so cache keys stay compact', () => {
    const out = DeepgramProvider.cacheConfig.normalize({
      audio_data: Buffer.from('a'.repeat(1024)),
      model: 'nova-2',
      language: 'en',
      diarize: true,
      request_id: 'should-not-appear',
    });
    expect(typeof out.audio_sha256).toBe('string');
    expect((out.audio_sha256 as string).length).toBe(64); // sha256 hex
    expect(out).not.toHaveProperty('audio_data');
    expect(out).not.toHaveProperty('request_id');
    expect(out.diarize).toBe(true);
  });

  it('declares request_id as non-deterministic per the plan F2 table', () => {
    expect(DeepgramProvider.cacheConfig.nonDeterministicParams).toContain('request_id');
    expect(DeepgramProvider.cacheConfig.deterministicParams).toContain('audio_data');
    expect(DeepgramProvider.cacheConfig.deterministicParams).toContain('model');
  });
});
