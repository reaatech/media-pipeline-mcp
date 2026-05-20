import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import type { OpenAIConfig } from './openai-provider.js';

const mockConfig: OpenAIConfig = {
  apiKey: 'test-api-key',
};

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
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
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      // Mock fetch to avoid actual API calls
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
        } as Response),
      );

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should throw for unsupported operations', async () => {
      await expect(
        provider.execute({
          operation: 'unsupported.operation',
          params: {},
          config: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });

    it('should honor public tool parameter names for image generation', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: [{ url: 'https://example.com/image.png', revised_prompt: 'revised' }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response);

      global.fetch = fetchMock;

      const result = await provider.execute({
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
      expect(result.metadata.size).toBe('1536x1024');
    });

    it('should honor detail_level and output_format aliases', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'brief description' } }],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response);

      global.fetch = fetchMock;

      const imageResult = await provider.execute({
        operation: 'image.describe',
        params: {
          artifact_data: Buffer.from('img'),
          mime_type: 'image/jpeg',
          detail_level: 'brief',
        },
        config: {},
      });

      const ttsResult = await provider.execute({
        operation: 'audio.tts',
        params: {
          text: 'hello',
          output_format: 'wav',
        },
        config: {},
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          body: expect.stringContaining('Describe this image briefly'),
        }),
      );
      expect(imageResult.metadata.detail).toBe('brief');
      expect(ttsResult.mimeType).toBe('audio/wav');
      expect(ttsResult.metadata.format).toBe('wav');
    });
  });
});
