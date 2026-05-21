import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  CostEstimate,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ArtifactMeta,
  ArtifactStore,
  StorageResult,
} from '@reaatech/media-pipeline-mcp-storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoGenOperations, createVideoGenOperations } from './video-gen-operations.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockMkdtempSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockRmSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: mockMkdtempSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    rmSync: mockRmSync,
  };
});

class MockProvider extends MediaProvider {
  readonly name: string;
  readonly supportedOperations: string[];
  private mockResult: ProviderOutput;

  constructor(name: string, supportedOperations: string[], mockResult: ProviderOutput) {
    super();
    this.name = name;
    this.supportedOperations = supportedOperations;
    this.mockResult = mockResult;
  }

  async execute(_input: ProviderInput): Promise<ProviderOutput> {
    return this.mockResult;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: this.mockResult.costUsd ?? 0.01, currency: 'USD' };
  }
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

function makeMockProcess() {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => (handler as (code: number) => void)(0), 0);
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

function makeFailingProcess(code: number) {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => (handler as (code: number) => void)(code), 0);
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

describe('VideoGenOperations', () => {
  let artifactRegistry: ArtifactRegistry;
  let storage: MockStorage;
  let operations: VideoGenOperations;

  function registerVideoArtifact(duration = 5, fps = 30) {
    const artifact = artifactRegistry.register({
      type: 'video',
      uri: 'file:///placeholder',
      mimeType: 'video/mp4',
      metadata: { duration, fps, width: 1920, height: 1080 },
    });
    storage.put(artifact.id, Buffer.from('video-data'), {
      id: artifact.id,
      type: 'video',
      mimeType: 'video/mp4',
      size: 1000,
      metadata: { duration, fps, width: 1920, height: 1080 },
    });
    return artifact;
  }

  function registerImageArtifact() {
    const artifact = artifactRegistry.register({
      type: 'image',
      uri: 'file:///image.png',
      mimeType: 'image/png',
      metadata: { width: 1920, height: 1080 },
    });
    storage.put(artifact.id, Buffer.from('image-data'), {
      id: artifact.id,
      type: 'image',
      mimeType: 'image/png',
      size: 100,
      metadata: { width: 1920, height: 1080 },
    });
    return artifact;
  }

  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(makeMockProcess());
    mockMkdtempSync.mockReturnValue('/tmp/test-video-gen');
    mockWriteFileSync.mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(Buffer.from('mock-output-data'));
    mockRmSync.mockImplementation(() => {});

    artifactRegistry = new ArtifactRegistry();
    storage = new MockStorage();
    operations = new VideoGenOperations(artifactRegistry, storage);

    operations.registerProvider(
      'mock-video-gen',
      new MockProvider('mock-video-gen', ['video.generate', 'video.image_to_video'], {
        data: Buffer.from('mock-video-data'),
        mimeType: 'video/mp4',
        metadata: {},
        costUsd: 0.02,
      }),
    );

    operations.registerProvider(
      'mock-frame-extract',
      new MockProvider('mock-frame-extract', ['video.extract_frames'], {
        data: Buffer.from('mock-image-data'),
        mimeType: 'image/png',
        metadata: {},
        costUsd: 0.001,
      }),
    );

    operations.registerProvider(
      'mock-audio-extract',
      new MockProvider('mock-audio-extract', ['video.extract_audio'], {
        data: Buffer.from('mock-audio-data'),
        mimeType: 'audio/aac',
        metadata: {},
        costUsd: 0.001,
      }),
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

    it('should use provider-specific routing when provider is specified', async () => {
      operations.registerProvider(
        'alt-video-gen',
        new MockProvider('alt-video-gen', ['video.generate'], {
          data: Buffer.from('alt-video-data'),
          mimeType: 'video/webm',
          metadata: {},
          costUsd: 0.03,
        }),
      );

      const result = await operations.generate({
        prompt: 'Test with provider',
        provider: 'alt-video-gen',
      });

      expect(result.mimeType).toBe('video/webm');
      expect(result.metadata.provider).toBe('alt-video-gen');
    });

    it('should include style and provider in metadata', async () => {
      const result = await operations.generate({
        prompt: 'Stylish scene',
        style: 'anime',
        provider: 'mock-video-gen',
      });

      expect(result.metadata.style).toBe('anime');
      expect(result.metadata.provider).toBe('mock-video-gen');
    });
  });

  describe('imageToVideo', () => {
    it('should convert image to video', async () => {
      const imageArtifact = registerImageArtifact();

      const result = await operations.imageToVideo({
        artifactId: imageArtifact.id,
      });

      expect(result.type).toBe('video');
      expect(result.mimeType).toBe('video/mp4');
      expect(result.metadata.operation).toBe('video.image_to_video');
      expect(result.metadata.sourceArtifact).toBe(imageArtifact.id);
    });

    it('should include motion prompt in video generation', async () => {
      const imageArtifact = registerImageArtifact();

      const result = await operations.imageToVideo({
        artifactId: imageArtifact.id,
        motionPrompt: 'Slow zoom in',
        duration: 8,
      });

      expect(result.metadata.motionPrompt).toBe('Slow zoom in');
      expect(result.metadata.duration).toBe(8);
    });

    it('should use provider-specific routing when provider is specified', async () => {
      operations.registerProvider(
        'alt-i2v',
        new MockProvider('alt-i2v', ['video.image_to_video'], {
          data: Buffer.from('alt-video-data'),
          mimeType: 'video/webm',
          metadata: {},
          costUsd: 0.03,
        }),
      );

      const imageArtifact = registerImageArtifact();

      const result = await operations.imageToVideo({
        artifactId: imageArtifact.id,
        provider: 'alt-i2v',
      });

      expect(result.metadata.provider).toBe('alt-i2v');
      expect(result.mimeType).toBe('video/webm');
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
    afterEach(() => {
      mockMkdtempSync.mockReset();
      mockWriteFileSync.mockReset();
      mockReadFileSync.mockReset();
      mockRmSync.mockReset();
    });

    it('should extract frames from video at default interval', async () => {
      const videoArtifact = registerVideoArtifact(5, 30);

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
      });

      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].type).toBe('image');
      expect(frames[0].mimeType).toBe('image/png');
      expect(frames[0].metadata.operation).toBe('video.extract_frames');
    });

    it('should extract frames at custom interval (every Nth frame)', async () => {
      const videoArtifact = registerVideoArtifact(10, 30);

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
        interval: 60,
      });

      expect(frames.length).toBe(5);
    });

    it('should extract frames at specific timestamps', async () => {
      const videoArtifact = registerVideoArtifact(10, 30);

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

    it('should fall back to interval-based extraction when timestamps array is empty', async () => {
      const videoArtifact = registerVideoArtifact(5, 30);

      const frames = await operations.extractFrames({
        artifactId: videoArtifact.id,
        timestamps: [],
      });

      expect(frames.length).toBeGreaterThan(0);
    });

    it('should reject when ffmpeg fails', async () => {
      mockSpawn.mockReset();
      mockSpawn.mockReturnValue(makeFailingProcess(1));

      const videoArtifact = registerVideoArtifact(5, 30);

      await expect(operations.extractFrames({ artifactId: videoArtifact.id })).rejects.toThrow(
        'ffmpeg exited with code 1',
      );
    });

    it('should reject on ffmpeg spawn error', async () => {
      mockSpawn.mockReset();
      mockSpawn.mockReturnValue({
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'error') setTimeout(() => handler(new Error('spawn failed')), 0);
          return undefined;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      });

      const videoArtifact = registerVideoArtifact(5, 30);

      await expect(operations.extractFrames({ artifactId: videoArtifact.id })).rejects.toThrow(
        'spawn failed',
      );
    });
  });

  describe('extractAudio', () => {
    afterEach(() => {
      mockMkdtempSync.mockReset();
      mockWriteFileSync.mockReset();
      mockReadFileSync.mockReset();
      mockRmSync.mockReset();
    });

    it('should extract audio from video', async () => {
      const videoArtifact = registerVideoArtifact(5);

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
      const videoArtifact = registerVideoArtifact(10);

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

    it('should reject when ffmpeg fails', async () => {
      mockSpawn.mockReset();
      mockSpawn.mockReturnValue(makeFailingProcess(1));

      const videoArtifact = registerVideoArtifact(5);

      await expect(operations.extractAudio({ artifactId: videoArtifact.id })).rejects.toThrow(
        'ffmpeg exited with code 1',
      );
    });

    it('should reject on ffmpeg spawn error', async () => {
      mockSpawn.mockReset();
      mockSpawn.mockReturnValue({
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'error') setTimeout(() => handler(new Error('spawn failed')), 0);
          return undefined;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      });

      const videoArtifact = registerVideoArtifact(5);

      await expect(operations.extractAudio({ artifactId: videoArtifact.id })).rejects.toThrow(
        'spawn failed',
      );
    });
  });
});

describe('factory', () => {
  it('should create via factory function', () => {
    const registry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = createVideoGenOperations(registry, storage);
    expect(ops).toBeInstanceOf(VideoGenOperations);
  });
});

describe('generate with no provider', () => {
  it('should throw when no provider is registered for generate', async () => {
    const artifactRegistry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(artifactRegistry, storage);

    await expect(ops.generate({ prompt: 'test' })).rejects.toThrow('No provider available');
  });
});

describe('imageToVideo with no provider', () => {
  it('should throw when no provider is registered for imageToVideo', async () => {
    const artifactRegistry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(artifactRegistry, storage);

    const imageArtifact = artifactRegistry.register({
      type: 'image',
      uri: 'file:///image.png',
      mimeType: 'image/png',
      metadata: {},
    });
    await storage.put(imageArtifact.id, Buffer.from('data'), {
      id: imageArtifact.id,
      type: 'image',
      mimeType: 'image/png',
      size: 100,
      metadata: {},
    });

    await expect(ops.imageToVideo({ artifactId: imageArtifact.id })).rejects.toThrow(
      'No provider available',
    );
  });
});

describe('provider fallback routing', () => {
  it('should fall back to another provider when preferred does not support operation', async () => {
    const registry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(registry, storage);

    const preferred = new MockProvider('preferred', ['other.op'], {
      data: Buffer.from('data'),
      mimeType: 'text/plain',
      metadata: {},
      costUsd: 0.01,
    });
    const fallback = new MockProvider('fallback', ['video.generate'], {
      data: Buffer.from('video-data'),
      mimeType: 'video/mp4',
      metadata: {},
      costUsd: 0.02,
    });

    ops.registerProvider('preferred', preferred);
    ops.registerProvider('fallback', fallback);

    const result = await ops.generate({ prompt: 'test', provider: 'preferred' });

    expect(result.metadata.provider).toBe('fallback');
  });

  it('should throw when no provider supports the operation', async () => {
    const registry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(registry, storage);

    ops.registerProvider(
      'provider-a',
      new MockProvider('provider-a', ['other.op'], {
        data: Buffer.from('data'),
        mimeType: 'text/plain',
        metadata: {},
        costUsd: 0.01,
      }),
    );

    await expect(ops.generate({ prompt: 'test' })).rejects.toThrow('No provider available');
  });

  it('should use any suitable provider when no preferred is specified', async () => {
    const registry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(registry, storage);

    ops.registerProvider(
      'provider-a',
      new MockProvider('provider-a', ['video.generate'], {
        data: Buffer.from('video-data'),
        mimeType: 'video/mp4',
        metadata: {},
        costUsd: 0.02,
      }),
    );

    const result = await ops.generate({ prompt: 'fallback test' });
    expect(result.metadata.provider).toBe('provider-a');
  });
});

describe('registerProvider', () => {
  it('should allow overwriting an existing provider', async () => {
    const registry = new ArtifactRegistry();
    const storage = new MockStorage();
    const ops = new VideoGenOperations(registry, storage);

    ops.registerProvider(
      'dynamic',
      new MockProvider('dynamic-v1', ['video.generate'], {
        data: Buffer.from('v1-data'),
        mimeType: 'video/mp4',
        metadata: {},
        costUsd: 0.01,
      }),
    );

    ops.registerProvider(
      'dynamic',
      new MockProvider('dynamic-v2', ['video.generate'], {
        data: Buffer.from('v2-data'),
        mimeType: 'video/webm',
        metadata: {},
        costUsd: 0.02,
      }),
    );

    const result = await ops.generate({ prompt: 'overwritten', provider: 'dynamic' });
    expect(result.mimeType).toBe('video/webm');
    expect(result.metadata.provider).toBe('dynamic-v2');
  });
});
