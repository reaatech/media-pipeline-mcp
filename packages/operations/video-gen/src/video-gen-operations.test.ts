import { describe, it, expect, beforeEach } from 'vitest';
import { VideoGenOperations } from './video-gen-operations.js';
import { ArtifactRegistry } from '@media-pipeline/core';
import type { ArtifactStore, ArtifactMeta, StorageResult } from '@media-pipeline/storage';
import type { ProviderOutput } from '@media-pipeline/provider-core';
import { Readable } from 'stream';

interface MockProvider {
  name: string;
  supportedOperations: string[];
  execute: (input: any) => Promise<ProviderOutput>;
  healthCheck: () => Promise<{ healthy: boolean }>;
}

class MockStorage implements ArtifactStore {
  private store = new Map<string, Buffer>();
  private metas = new Map<string, ArtifactMeta>();

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async put(id: string, data: Buffer | Readable | unknown, meta: ArtifactMeta): Promise<string> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from('mock-video-data');
    this.store.set(id, buffer);
    this.metas.set(id, meta);
    return `file://${id}`;
  }

  async get(id: string): Promise<StorageResult> {
    const data = this.store.get(id);
    const meta = this.metas.get(id);
    if (!data || !meta) throw new Error(`Artifact ${id} not found`);
    return {
      data: Readable.from(data),
      meta,
    };
  }

  async getSignedUrl(id: string): Promise<string> {
    return `file://${id}`;
  }

  async delete(_id: string): Promise<void> {
    this.store.delete(_id);
    this.metas.delete(_id);
  }

  async list(): Promise<ArtifactMeta[]> {
    return Array.from(this.metas.values());
  }
}

function createMockProvider(
  name: string,
  supportedOperations: string[],
  mockResult: ProviderOutput
): MockProvider {
  return {
    name,
    supportedOperations,
    execute: async () => mockResult,
    healthCheck: async () => ({ healthy: true }),
  };
}

describe('VideoGenOperations', () => {
  let artifactRegistry: ArtifactRegistry;
  let storage: MockStorage;
  let operations: VideoGenOperations;

  beforeEach(() => {
    artifactRegistry = new ArtifactRegistry();
    storage = new MockStorage();
    operations = new VideoGenOperations(artifactRegistry, storage);

    // Register mock providers for video operations
    operations.registerProvider(
      'mock-video-gen',
      createMockProvider('mock-video-gen', ['video.generate', 'video.image_to_video'], {
        data: Buffer.from('mock-video-data'),
        mimeType: 'video/mp4',
        costUsd: 0.02,
      })
    );

    operations.registerProvider(
      'mock-frame-extract',
      createMockProvider('mock-frame-extract', ['video.extract_frames'], {
        data: Buffer.from('mock-image-data'),
        mimeType: 'image/png',
        costUsd: 0.001,
      })
    );

    operations.registerProvider(
      'mock-audio-extract',
      createMockProvider('mock-audio-extract', ['video.extract_audio'], {
        data: Buffer.from('mock-audio-data'),
        mimeType: 'audio/aac',
        costUsd: 0.001,
      })
    );
  });

  describe('generate', () => {
    it('should generate video from prompt with default settings', async () => {
      const result = await operations.generate({
        prompt: 'A cat playing piano',
      });

      expect(result.type).toBe('video');
      expect(result.mimeType).toBe('video/mp4');
      expect(result.metadata.operation).toBe('video.generate');
      expect(result.metadata.duration).toBe(5);
      expect(result.metadata.aspectRatio).toBe('16:9');
    });

    it('should generate video with custom duration and aspect ratio', async () => {
      const result = await operations.generate({
        prompt: 'A sunset over mountains',
        duration: 10,
        aspectRatio: '9:16',
      });

      expect(result.type).toBe('video');
      expect(result.metadata.duration).toBe(10);
      expect(result.metadata.aspectRatio).toBe('9:16');
    });
  });

  describe('imageToVideo', () => {
    it('should convert image to video', async () => {
      // First register the image artifact in the registry (generates UUID)
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///placeholder',
        mimeType: 'image/png',
        metadata: { width: 1920, height: 1080 },
      });

      // Store the image data in storage using the artifact's ID as the key
      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 100,
        metadata: { width: 1920, height: 1080 },
      });

      const result = await operations.imageToVideo({
        artifactId: imageArtifact.id,
      });

      expect(result.type).toBe('video');
      expect(result.mimeType).toBe('video/mp4');
      expect(result.metadata.operation).toBe('video.image_to_video');
      expect(result.metadata.sourceArtifact).toBe(imageArtifact.id);
    });

    it('should include motion prompt in video generation', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///placeholder',
        mimeType: 'image/png',
        metadata: {},
      });

      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 100,
        metadata: {},
      });

      const result = await operations.imageToVideo({
        artifactId: imageArtifact.id,
        motionPrompt: 'Slow zoom in',
        duration: 8,
      });

      expect(result.metadata.motionPrompt).toBe('Slow zoom in');
      expect(result.metadata.duration).toBe(8);
    });

    it('should fail for non-image artifact', async () => {
      const textArtifact = artifactRegistry.register({
        type: 'text',
        uri: 'file:///text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      await expect(operations.imageToVideo({ artifactId: textArtifact.id })).rejects.toThrow();
    });
  });

  describe('extractFrames', () => {
    it('should extract frames from video at default interval', async () => {
      // Skip if ffmpeg is not available
      const { execSync } = await import('child_process');
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        return;
      }

      const videoArtifact = artifactRegistry.register({
        type: 'video',
        uri: 'file:///placeholder',
        mimeType: 'video/mp4',
        metadata: { duration: 5, fps: 30 },
      });

      await storage.put(videoArtifact.id, Buffer.from('video-data'), {
        id: videoArtifact.id,
        type: 'video',
        mimeType: 'video/mp4',
        size: 1000,
        metadata: { duration: 5, fps: 30 },
      });

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
      });

      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].type).toBe('image');
      expect(frames[0].mimeType).toBe('image/png');
      expect(frames[0].metadata.operation).toBe('video.extract_frames');
    });

    it('should extract frames at custom interval', async () => {
      // Skip if ffmpeg is not available
      const { execSync } = await import('child_process');
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        return;
      }

      const videoArtifact = artifactRegistry.register({
        type: 'video',
        uri: 'file:///placeholder',
        mimeType: 'video/mp4',
        metadata: { duration: 10, fps: 30 },
      });

      await storage.put(videoArtifact.id, Buffer.from('video-data'), {
        id: videoArtifact.id,
        type: 'video',
        mimeType: 'video/mp4',
        size: 1000,
        metadata: { duration: 10, fps: 30 },
      });

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
        interval: 2, // Every 2 seconds
      });

      expect(frames.length).toBe(5); // 10 seconds / 2 seconds per frame
    });

    it('should extract frames at specific timestamps', async () => {
      // Skip if ffmpeg is not available
      const { execSync } = await import('child_process');
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        return;
      }

      const videoArtifact = artifactRegistry.register({
        type: 'video',
        uri: 'file:///placeholder',
        mimeType: 'video/mp4',
        metadata: { duration: 10, fps: 30 },
      });

      await storage.put(videoArtifact.id, Buffer.from('video-data'), {
        id: videoArtifact.id,
        type: 'video',
        mimeType: 'video/mp4',
        size: 1000,
        metadata: { duration: 10, fps: 30 },
      });

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
        timestamps: [0, 2.5, 5, 7.5],
      });

      expect(frames.length).toBe(4);
    });

    it('should fail for non-video artifact', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///image.png',
        mimeType: 'image/png',
        metadata: {},
      });

      await expect(operations.extractFrames({ artifactId: imageArtifact.id })).rejects.toThrow();
    });
  });

  describe('extractAudio', () => {
    it('should extract audio from video', async () => {
      // Skip if ffmpeg is not available
      const { execSync } = await import('child_process');
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        return;
      }

      const videoArtifact = artifactRegistry.register({
        type: 'video',
        uri: 'file:///placeholder',
        mimeType: 'video/mp4',
        metadata: { duration: 5, fps: 30 },
      });

      await storage.put(videoArtifact.id, Buffer.from('video-data'), {
        id: videoArtifact.id,
        type: 'video',
        mimeType: 'video/mp4',
        size: 1000,
        metadata: { duration: 5, fps: 30 },
      });

      const result = await operations.extractAudio({
        artifactId: videoArtifact.id,
      });

      expect(result.type).toBe('audio');
      expect(result.mimeType).toBe('audio/aac');
      expect(result.metadata.operation).toBe('video.extract_audio');
      expect(result.metadata.sourceArtifact).toBe(videoArtifact.id);
      expect(result.metadata.duration).toBe(5);
    });

    it('should preserve audio metadata', async () => {
      // Skip if ffmpeg is not available
      const { execSync } = await import('child_process');
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        return;
      }

      const videoArtifact = artifactRegistry.register({
        type: 'video',
        uri: 'file:///placeholder',
        mimeType: 'video/mp4',
        metadata: { duration: 10, fps: 30 },
      });

      await storage.put(videoArtifact.id, Buffer.from('video-data'), {
        id: videoArtifact.id,
        type: 'video',
        mimeType: 'video/mp4',
        size: 1000,
        metadata: { duration: 10, fps: 30 },
      });

      const result = await operations.extractAudio({
        artifactId: videoArtifact.id,
      });

      expect(result.metadata.sampleRate).toBe(48000);
      expect(result.metadata.channels).toBe(2);
      expect(result.metadata.codec).toBe('aac');
    });

    it('should fail for non-video artifact', async () => {
      const audioArtifact = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });

      await expect(operations.extractAudio({ artifactId: audioArtifact.id })).rejects.toThrow();
    });
  });
});
