import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepgramProvider } from './deepgram-provider.js';
import type { ProviderInput } from '@media-pipeline/provider-core';

// Mock global fetch for health checks
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the Deepgram SDK
vi.mock('@deepgram/sdk', () => {
  return {
    createClient: vi.fn().mockReturnValue({
      listen: {
        prerecorded: {
          transcribeFile: vi.fn().mockResolvedValue({
            result: {
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
                  {
                    speaker: 'Speaker 1',
                    transcript: 'Hello world',
                    start: 0,
                    end: 1,
                    confidence: 0.95,
                  },
                  {
                    speaker: 'Speaker 2',
                    transcript: 'This is a test',
                    start: 1,
                    end: 2,
                    confidence: 0.93,
                  },
                ],
              },
              duration: 2.5,
            },
          }),
        },
      },
    }),
  };
});

describe('DeepgramProvider', () => {
  let provider: DeepgramProvider;

  beforeEach(() => {
    provider = new DeepgramProvider({
      apiKey: 'test-api-key',
      models: {
        stt: 'nova-2',
        diarize: 'nova-2',
      },
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
        params: {
          audio_data: Buffer.from('mock-audio-data'),
          language: 'en',
          diarize: false,
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/json');
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute audio.diarize operation', async () => {
      const input: ProviderInput = {
        operation: 'audio.diarize',
        config: {},
        params: {
          audio_data: Buffer.from('mock-audio-data'),
          language: 'en',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.metadata.speakerCount).toBeGreaterThan(0);
    });

    it('should throw error for unsupported operation', async () => {
      const input: ProviderInput = {
        operation: 'unknown.operation' as any,
        config: {},
        params: {},
      };

      await expect(provider.execute(input)).rejects.toThrow('Unsupported operation');
    });
  });

  describe('healthCheck', () => {
    afterEach(() => {
      mockFetch.mockReset();
    });

    it('should return health status', async () => {
      const mockResponse = {
        ok: true,
      };
      mockFetch.mockResolvedValue(mockResponse);

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy status on error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  describe('segment extraction', () => {
    it('should extract segments from transcription result', async () => {
      const input: ProviderInput = {
        operation: 'audio.stt',
        config: {},
        params: {
          audio_data: Buffer.from('mock-audio-data'),
        },
      };

      const result = await provider.execute(input);
      const output = JSON.parse(result.data.toString());

      expect(output.segments).toBeDefined();
      expect(Array.isArray(output.segments)).toBe(true);
    });
  });

  describe('speaker counting', () => {
    it('should count unique speakers in diarization', async () => {
      const input: ProviderInput = {
        operation: 'audio.diarize',
        config: {},
        params: {
          audio_data: Buffer.from('mock-audio-data'),
        },
      };

      const result = await provider.execute(input);
      const output = JSON.parse(result.data.toString());

      expect(output.speakers).toBeGreaterThanOrEqual(1);
      expect(output.segments).toBeDefined();
    });
  });
});
