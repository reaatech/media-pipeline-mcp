import { describe, it, expect, beforeEach } from 'vitest';
import { ImageEditOperations } from './image-edit-operations.js';
import { ArtifactRegistry } from '@media-pipeline/core';
import type { ArtifactStore, ArtifactMeta, StorageResult } from '@media-pipeline/storage';
import { Readable } from 'stream';

// Mock storage that uses the artifact ID directly
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

// Extended registry that allows setting custom IDs for testing
class TestArtifactRegistry extends ArtifactRegistry {
  registerWithId(
    artifact: { type: string; uri: string; mimeType: string; metadata: Record<string, unknown> },
    id: string
  ) {
    const fullArtifact = {
      ...artifact,
      id,
      createdAt: new Date().toISOString(),
    };
    (this as any).artifacts.set(id, fullArtifact);
    return fullArtifact;
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
  });

  // Helper to create a test image artifact with consistent ID between registry and storage
  async function createTestImageArtifact(width = 100, height = 100): Promise<string> {
    const sharp = (await import('sharp')).default;
    const image = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    // Use the same ID for both storage and registry
    const id = `artifact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Store in storage
    await storage.put(id, image, {
      id,
      type: 'image',
      mimeType: 'image/png',
      size: image.length,
      width,
      height,
    } as ArtifactMeta);

    // Register with registry using the same ID
    artifactRegistry.registerWithId(
      {
        type: 'image',
        uri: `file://${id}`,
        mimeType: 'image/png',
        metadata: { width, height },
      },
      id
    );

    return id;
  }

  describe('resize', () => {
    it('should resize image to exact dimensions', async () => {
      const artifactId = await createTestImageArtifact(100, 100);
      const result = await operations.resize(artifactId, {
        width: 200,
        height: 200,
      });

      expect(result.type).toBe('image');
      expect(result.mimeType).toBe('image/png');
      expect(result.metadata.width).toBe(200);
      expect(result.metadata.height).toBe(200);
      expect(result.metadata.sourceArtifact).toBe(artifactId);
      expect(result.metadata.operation).toBe('resize');
    });

    it('should maintain aspect ratio when only width provided', async () => {
      const artifactId = await createTestImageArtifact(100, 100);
      const result = await operations.resize(artifactId, {
        width: 200,
      });

      expect(result.metadata.width).toBe(200);
      expect(result.metadata.height).toBe(200);
    });

    it('should maintain aspect ratio when only height provided', async () => {
      const artifactId = await createTestImageArtifact(100, 100);
      const result = await operations.resize(artifactId, {
        height: 150,
      });

      expect(result.metadata.width).toBe(150);
      expect(result.metadata.height).toBe(150);
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id
      );

      await expect(operations.resize(id, { width: 100 })).rejects.toThrow('is not an image');
    });
  });

  describe('crop', () => {
    it('should crop image to specified region', async () => {
      const artifactId = await createTestImageArtifact(100, 100);
      const result = await operations.crop(artifactId, {
        x: 10,
        y: 10,
        width: 50,
        height: 50,
      });

      expect(result.type).toBe('image');
      expect(result.metadata.width).toBe(50);
      expect(result.metadata.height).toBe(50);
      expect(result.metadata.sourceArtifact).toBe(artifactId);
      expect(result.metadata.operation).toBe('crop');
      expect(result.metadata.cropX).toBe(10);
      expect(result.metadata.cropY).toBe(10);
    });

    it('should throw for non-image artifact', async () => {
      const id = 'non-image';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id
      );

      await expect(operations.crop(id, { x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow(
        'is not an image'
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

      expect(result.type).toBe('image');
      expect(result.metadata.width).toBe(100);
      expect(result.metadata.height).toBe(100);
      expect(result.metadata.sourceArtifact).toBe(baseId);
      expect(result.metadata.overlayArtifact).toBe(overlayId);
      expect(result.metadata.operation).toBe('composite');
    });

    it('should throw for non-image base artifact', async () => {
      const overlayId = await createTestImageArtifact(50, 50);

      const id = 'non-image';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id
      );

      await expect(operations.composite(id, overlayId, {})).rejects.toThrow('Base artifact');
    });

    it('should throw for non-image overlay artifact', async () => {
      const baseId = await createTestImageArtifact(100, 100);

      const id = 'non-image';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id
      );

      await expect(operations.composite(baseId, id, {})).rejects.toThrow('Overlay artifact');
    });
  });
});
