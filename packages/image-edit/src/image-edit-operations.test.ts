import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp-core';
import type {
  CostEstimate,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ArtifactMeta,
  ArtifactStore,
  StorageResult,
} from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { ImageEditOperations } from './image-edit-operations.js';

class MockStorage implements ArtifactStore {
  private store = new Map<string, Buffer>();
  private metas = new Map<string, ArtifactMeta>();

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async put(id: string, data: Buffer | Readable | unknown, meta: ArtifactMeta): Promise<string> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from('');
    this.store.set(id, buffer);
    this.metas.set(id, meta);
    return `file://${id}`;
  }

  async get(id: string): Promise<StorageResult> {
    const data = this.store.get(id);
    const meta = this.metas.get(id);
    if (!data || !meta) throw new Error(`Artifact not found: ${id}`);
    return { data: Readable.from(data), meta };
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

// Use the real ArtifactRegistry; the previous subclass had an inverted-arg
// registerWithId that conflicted with the parent signature. Alias kept so call
// sites need no changes.
const TestArtifactRegistry = ArtifactRegistry;
type TestArtifactRegistry = ArtifactRegistry;

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
    return { costUsd: this.mockResult.costUsd ?? 0.001, currency: 'USD' };
  }
}

describe('ImageEditOperations', () => {
  let artifactRegistry: TestArtifactRegistry;
  let storage: MockStorage;
  let operations: ImageEditOperations;

  beforeEach(() => {
    artifactRegistry = new TestArtifactRegistry();
    storage = new MockStorage();
    operations = new ImageEditOperations(artifactRegistry, storage);

    operations.registerProvider(
      'mock-upscale',
      new MockProvider('mock-upscale', ['image.upscale'], {
        data: Buffer.from('upscaled'),
        mimeType: 'image/png',
        metadata: {},
        costUsd: 0.005,
      }),
    );
    operations.registerProvider(
      'mock-remove-bg',
      new MockProvider('mock-remove-bg', ['image.remove_background'], {
        data: Buffer.from('no-bg'),
        mimeType: 'image/png',
        metadata: {},
        costUsd: 0.003,
      }),
    );
    operations.registerProvider(
      'mock-inpaint',
      new MockProvider('mock-inpaint', ['image.inpaint'], {
        data: Buffer.from('inpainted'),
        mimeType: 'image/png',
        metadata: {},
        costUsd: 0.01,
      }),
    );
    operations.registerProvider(
      'mock-describe',
      new MockProvider('mock-describe', ['image.describe'], {
        data: Buffer.from('description text'),
        mimeType: 'text/plain',
        metadata: {},
        costUsd: 0.002,
      }),
    );
  });

  async function createTestImageArtifact(width = 100, height = 100): Promise<string> {
    const sharp = (await import('sharp')).default;
    const image = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const id = `artifact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await storage.put(id, image, {
      id,
      type: 'image',
      mimeType: 'image/png',
      size: image.length,
      width,
      height,
    } as ArtifactMeta);
    artifactRegistry.registerWithId(id, {
      type: 'image',
      uri: `file://${id}`,
      mimeType: 'image/png',
      metadata: { width, height },
    });
    return id;
  }

  describe('resize', () => {
    it('should resize image to exact dimensions', async () => {
      const id = await createTestImageArtifact(100, 100);
      const result = await operations.resize(id, { width: 200, height: 200 });
      expect(result.metadata.width).toBe(200);
      expect(result.metadata.height).toBe(200);
    });

    it('should maintain aspect ratio when only width provided', async () => {
      const id = await createTestImageArtifact(100, 100);
      const result = await operations.resize(id, { width: 200 });
      expect(result.metadata.width).toBe(200);
      expect(result.metadata.height).toBe(200);
    });

    it('should maintain aspect ratio when only height provided', async () => {
      const id = await createTestImageArtifact(100, 100);
      const result = await operations.resize(id, { height: 150 });
      expect(result.metadata.height).toBe(150);
    });

    it('should accept position option', async () => {
      const id = await createTestImageArtifact(100, 100);
      const result = await operations.resize(id, { width: 50, height: 50, position: 'center' });
      expect(result.metadata.width).toBe(50);
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.resize(id, { width: 100 })).rejects.toThrow('is not an image');
    });
  });

  describe('crop', () => {
    it('should crop image to specified region', async () => {
      const id = await createTestImageArtifact(100, 100);
      const result = await operations.crop(id, { x: 10, y: 10, width: 50, height: 50 });
      expect(result.metadata.width).toBe(50);
      expect(result.metadata.height).toBe(50);
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.crop(id, { x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow(
        'is not an image',
      );
    });
  });

  describe('composite', () => {
    it('should composite overlay onto base image', async () => {
      const baseId = await createTestImageArtifact(100, 100);
      const overlayId = await createTestImageArtifact(50, 50);
      const result = await operations.composite(baseId, overlayId, {
        top: 10,
        left: 10,
        opacity: 0.8,
      });
      expect(result.metadata.width).toBe(100);
      expect(result.metadata.operation).toBe('composite');
    });

    it('should throw for non-image base artifact', async () => {
      const overlayId = await createTestImageArtifact(50, 50);
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.composite(id, overlayId, {})).rejects.toThrow('Base artifact');
    });

    it('should throw for non-image overlay artifact', async () => {
      const baseId = await createTestImageArtifact(100, 100);
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.composite(baseId, id, {})).rejects.toThrow('Overlay artifact');
    });
  });

  describe('upscale', () => {
    it('should upscale image via provider', async () => {
      const id = await createTestImageArtifact();
      const result = await operations.upscale({ artifactId: id, scale: 4, model: 'real-esrgan' });
      expect(result.type).toBe('image');
      expect(result.metadata.operation).toBe('upscale');
      expect(result.metadata.scale).toBe(4);
      expect(result.metadata.provider).toBe('mock-upscale');
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.upscale({ artifactId: id })).rejects.toThrow('is not an image');
    });

    it('should throw when no provider available', async () => {
      const id = await createTestImageArtifact();
      const ops = new ImageEditOperations(artifactRegistry, storage);
      await expect(ops.upscale({ artifactId: id })).rejects.toThrow('No provider available');
    });
  });

  describe('removeBackground', () => {
    it('should remove background via provider', async () => {
      const id = await createTestImageArtifact();
      const result = await operations.removeBackground({ artifactId: id });
      expect(result.type).toBe('image');
      expect(result.metadata.operation).toBe('remove_background');
      expect(result.metadata.provider).toBe('mock-remove-bg');
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.removeBackground({ artifactId: id })).rejects.toThrow(
        'is not an image',
      );
    });

    it('should throw when no provider available', async () => {
      const id = await createTestImageArtifact();
      const ops = new ImageEditOperations(artifactRegistry, storage);
      await expect(ops.removeBackground({ artifactId: id })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('inpaint', () => {
    it('should inpaint via provider with mask', async () => {
      const id = await createTestImageArtifact();
      const maskId = await createTestImageArtifact(50, 50);
      const result = await operations.inpaint({
        artifactId: id,
        maskArtifactId: maskId,
        prompt: 'fill sky',
      });
      expect(result.type).toBe('image');
      expect(result.metadata.operation).toBe('inpaint');
      expect(result.metadata.hasMask).toBe(true);
    });

    it('should inpaint without mask', async () => {
      const id = await createTestImageArtifact();
      const result = await operations.inpaint({ artifactId: id, prompt: 'remove object' });
      expect(result.type).toBe('image');
      expect(result.metadata.operation).toBe('inpaint');
      expect(result.metadata.hasMask).toBe(false);
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.inpaint({ artifactId: id, prompt: 'test' })).rejects.toThrow(
        'is not an image',
      );
    });

    it('should throw when no provider available', async () => {
      const id = await createTestImageArtifact();
      const ops = new ImageEditOperations(artifactRegistry, storage);
      await expect(ops.inpaint({ artifactId: id, prompt: 'test' })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('describe', () => {
    it('should describe image via provider', async () => {
      const id = await createTestImageArtifact();
      const result = await operations.describe({ artifactId: id, detail: 'detailed' });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.operation).toBe('describe');
      expect(result.metadata.detail).toBe('detailed');
    });

    it('should default to detailed level', async () => {
      const id = await createTestImageArtifact();
      const result = await operations.describe({ artifactId: id });
      expect(result.metadata.detail).toBe('detailed');
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.describe({ artifactId: id })).rejects.toThrow('is not an image');
    });

    it('should throw when no provider available', async () => {
      const id = await createTestImageArtifact();
      const ops = new ImageEditOperations(artifactRegistry, storage);
      await expect(ops.describe({ artifactId: id })).rejects.toThrow('No provider available');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.ImageEditOperations).toBeDefined();
    expect(mod.createImageEditOperations).toBeDefined();
  });
});
