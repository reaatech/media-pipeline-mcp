import { describe, expect, it } from 'vitest';
import { MockProvider, mockOperations } from '../mock-provider.js';

describe('MockProvider', () => {
  describe('default config', () => {
    it('should use default values', () => {
      const provider = new MockProvider();
      expect(provider.name).toBe('mock');
      expect(provider.supportedOperations).toEqual([
        'mock.generate',
        'mock.transform',
        'mock.extract',
      ]);
    });

    it('should execute default mock operation', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('mock.generate', {}, {});

      expect(result.artifact.type).toBe('image');
      expect(result.artifact.mimeType).toBe('image/png');
      expect(result.cost_usd).toBe(0.001);
      expect(result.duration_ms).toBe(0);
      expect(result.data).toBeInstanceOf(Buffer);
    });
  });

  describe('custom config', () => {
    it('should use custom name and operations', () => {
      const provider = new MockProvider({
        name: 'custom-mock',
        operations: ['custom.op1', 'custom.op2'],
      });
      expect(provider.name).toBe('custom-mock');
      expect(provider.supportedOperations).toEqual(['custom.op1', 'custom.op2']);
    });

    it('should use custom cost', async () => {
      const provider = new MockProvider({ delay: 0, baseCost: 0.5 });
      const result = await provider.execute('mock.generate', {}, {});
      expect(result.cost_usd).toBe(0.5);
    });
  });

  describe('operation type mapping', () => {
    it('should return image type by default', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('mock.generate', {}, {});
      expect(result.artifact.type).toBe('image');
      expect(result.artifact.mimeType).toBe('image/png');
    });

    it('should return audio type for audio operations', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('audio.tts', {}, {});
      expect(result.artifact.type).toBe('audio');
      expect(result.artifact.mimeType).toBe('audio/mpeg');
      expect(result.artifact.metadata.duration).toBe(30);
      expect(result.artifact.metadata.sampleRate).toBe(44100);
    });

    it('should return video type for video operations', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('video.generate', {}, {});
      expect(result.artifact.type).toBe('video');
      expect(result.artifact.mimeType).toBe('video/mp4');
      expect(result.artifact.metadata.duration).toBe(10);
      expect(result.artifact.metadata.fps).toBe(30);
    });

    it('should return text type for text/extract operations', async () => {
      const provider = new MockProvider({ delay: 0 });

      const result1 = await provider.execute('document.extract', {}, {});
      expect(result1.artifact.type).toBe('text');
      expect(result1.artifact.mimeType).toBe('text/plain');

      const result2 = await provider.execute('mock.extract', {}, {});
      expect(result2.artifact.type).toBe('text');
    });

    it('should return document type for document operations', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('document.ocr', {}, {});
      expect(result.artifact.type).toBe('document');
      expect(result.artifact.mimeType).toBe('application/pdf');
    });

    it('should handle image operations', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('image.upscale', {}, {});
      expect(result.artifact.type).toBe('image');
      expect(result.artifact.mimeType).toBe('image/png');
    });
  });

  describe('metadata', () => {
    it('should include config in metadata', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('mock.generate', {}, { seed: 42 });

      expect(result.artifact.metadata).toMatchObject({
        width: 1024,
        height: 1024,
        quality: 0.9,
        seed: 42,
      });
    });

    it('should allow config to override default quality', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('mock.generate', {}, { quality: 'high' });

      expect(result.artifact.metadata.quality).toBe('high');
    });
  });

  describe('failure rate', () => {
    it('should throw when failure rate is 1.0', async () => {
      const provider = new MockProvider({ delay: 0, failureRate: 1.0 });

      await expect(provider.execute('mock.generate', {}, {})).rejects.toThrow(
        'Mock provider simulated failure',
      );
    });

    it('should succeed when failure rate is 0', async () => {
      const provider = new MockProvider({ delay: 0, failureRate: 0 });

      const result = await provider.execute('mock.generate', {}, {});
      expect(result.artifact).toBeDefined();
    });
  });

  describe('alwaysPass', () => {
    it('should return higher quality when alwaysPass is true', async () => {
      const provider = new MockProvider({ delay: 0, alwaysPass: true });
      const result = await provider.execute('mock.generate', {}, {});
      expect(result.artifact.metadata.quality).toBe(0.99);
    });

    it('should return default quality when alwaysPass is false', async () => {
      const provider = new MockProvider({ delay: 0, alwaysPass: false });
      const result = await provider.execute('mock.generate', {}, {});
      expect(result.artifact.metadata.quality).toBe(0.9);
    });
  });

  describe('health check', () => {
    it('should return true when failure rate is 0', async () => {
      const provider = new MockProvider({ delay: 0, failureRate: 0 });
      const healthy = await provider.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when failure rate is 1', async () => {
      const provider = new MockProvider({ delay: 0, failureRate: 1.0 });
      const healthy = await provider.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('mockOperations constants', () => {
    it('should define all mock operation keys', () => {
      expect(mockOperations.generate).toBe('mock.generate');
      expect(mockOperations.transform).toBe('mock.transform');
      expect(mockOperations.extract).toBe('mock.extract');
      expect(mockOperations.imageGenerate).toBe('image.generate');
      expect(mockOperations.imageUpscale).toBe('image.upscale');
      expect(mockOperations.imageRemoveBackground).toBe('image.remove_background');
      expect(mockOperations.audioTts).toBe('audio.tts');
      expect(mockOperations.audioStt).toBe('audio.stt');
    });
  });

  describe('uri generation', () => {
    it('should generate proper mock URI', async () => {
      const provider = new MockProvider({ delay: 0 });
      const result = await provider.execute('image.generate', {}, {});
      expect(result.artifact.uri).toMatch(/^mock:\/\/image\.generate\/\d+\.png$/);
    });
  });
});
