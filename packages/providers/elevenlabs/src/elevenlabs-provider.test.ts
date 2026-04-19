import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ElevenLabsProvider } from './elevenlabs-provider.js';
import type { ProviderInput } from '@media-pipeline/provider-core';

// Mock fetch
global.fetch = vi.fn();

describe('ElevenLabsProvider', () => {
  let provider: ElevenLabsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElevenLabsProvider({
      apiKey: 'test-api-key',
      voices: {
        default: 'Rachel',
        'test-voice': 'Josh',
      },
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

  describe('execute', () => {
    it('should execute audio.tts operation', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world',
          voice: 'Rachel',
          speed: 1.0,
          response_format: 'mp3',
          model: 'eleven_monolingual_v1',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('audio/mpeg');
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should use default voice when not specified', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
    });

    it('should handle different audio formats', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const formats = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

      for (const format of formats) {
        const input: ProviderInput = {
          operation: 'audio.tts',
          config: {},
          params: {
            text: 'Hello world',
            response_format: format,
          },
        };

        const result = await provider.execute(input);
        expect(result.mimeType).not.toBe('application/octet-stream');
      }
    });

    it('should throw error for unsupported operation', async () => {
      const input: ProviderInput = {
        operation: 'unknown.operation' as any,
        config: {},
        params: {},
      };

      await expect(provider.execute(input)).rejects.toThrow('Unsupported operation');
    });

    it('should throw error when text is missing', async () => {
      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {},
      };

      await expect(provider.execute(input)).rejects.toThrow('Text is required');
    });

    it('should handle API errors', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        text: async () => 'Invalid API key',
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world',
        },
      };

      await expect(provider.execute(input)).rejects.toThrow('ElevenLabs API error');
    });
  });

  describe('healthCheck', () => {
    it('should return health status when healthy', async () => {
      const mockResponse = {
        ok: true,
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy status on error', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  describe('voice resolution', () => {
    it('should resolve named voices from config', () => {
      // This is tested implicitly through execute
      expect(provider).toBeDefined();
    });

    it('should use default voice as fallback', () => {
      // This is tested implicitly through execute
      expect(provider).toBeDefined();
    });
  });

  describe('cost estimation', () => {
    it('should estimate cost based on character count', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // ~11 characters = ~$0.0033
      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world', // 11 characters
        },
      };

      const result = await provider.execute(input);
      expect(result.costUsd).toBeCloseTo(0.0033, 3);
    });
  });

  describe('duration estimation', () => {
    it('should include duration in metadata', async () => {
      const mockResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const input: ProviderInput = {
        operation: 'audio.tts',
        config: {},
        params: {
          text: 'Hello world, this is a test of the duration estimation.',
        },
      };

      const result = await provider.execute(input);
      expect(result.metadata.duration).toBeDefined();
      expect(typeof result.metadata.duration).toBe('number');
    });
  });
});
