import type { ArtifactStore, StorageResult } from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ArtifactResourceConfig, ArtifactResourceHandler } from './resources.js';

describe('ArtifactResourceHandler', () => {
  let handler: ArtifactResourceHandler;
  let mockStorage: ArtifactStore;
  let mockData: Buffer;

  beforeEach(() => {
    mockData = Buffer.from('mock-image-data');
    mockStorage = {
      get: vi.fn<(id: string) => Promise<StorageResult>>().mockResolvedValue({
        data: mockData,
        meta: { id: 'test-id', type: 'image' as const, mimeType: 'image/png' },
      }),
      put: vi.fn().mockResolvedValue('artifact://bucket/key'),
      getSignedUrl: vi.fn().mockResolvedValue('https://signed.url'),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
  });

  describe('addResource', () => {
    it('should add a resource and appear in listResources', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3', ['tag1']);
      const list = await handler.listResources();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('img-1');
    });

    it('should silently skip when artifact not found in storage', async () => {
      mockStorage.get = vi.fn().mockRejectedValue(new Error('not found'));
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('missing', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list).toHaveLength(0);
    });
  });

  describe('listResources', () => {
    it('should return all added resources', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('a', 'r1', 's1', 'p1', 'm1');
      await handler.addResource('b', 'r1', 's2', 'p2', 'm2');
      await handler.addResource('c', 'r2', 's1', 'p3', 'm3');
      const list = await handler.listResources();
      expect(list).toHaveLength(3);
    });
  });

  describe('readResource', () => {
    it('should return data and mimeType for valid URI', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const result = await handler.readResource('artifact://session/img-1');
      expect(result).not.toBeNull();
      // Narrow the discriminated union — small artifacts return 'inline' with bytes.
      if (result?.kind !== 'inline') throw new Error('expected inline result');
      expect(result.data).toBe(mockData);
      expect(result.mimeType).toBe('image/png');
    });

    it('should return null for nonexistent URI', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      const result = await handler.readResource('artifact://session/nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when storage.get fails on read', async () => {
      mockStorage.get = vi
        .fn()
        .mockResolvedValueOnce({
          data: mockData,
          meta: { id: 'fail-id', type: 'image' as const, mimeType: 'image/png' },
        })
        .mockRejectedValueOnce(new Error('storage error'));
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('fail-id', 'run-1', 'step-1', 'stability', 'sd3');
      const result = await handler.readResource('artifact://session/fail-id');
      expect(result).toBeNull();
    });
  });

  describe('URI structure', () => {
    it('should use session scope: artifact://session/<id>', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].uri).toBe('artifact://session/img-1');
    });

    it('should use tenant scope: artifact://tenant/<tenantId>/<id>', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'tenant' },
        mockStorage,
        'tenant-42',
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].uri).toBe('artifact://tenant/tenant-42/img-1');
    });

    it('should use global scope: artifact://global/<id>', async () => {
      handler = new ArtifactResourceHandler({ enabled: true, defaultScope: 'global' }, mockStorage);
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].uri).toBe('artifact://global/img-1');
    });

    it('should default to session when no defaultScope set', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true } as ArtifactResourceConfig,
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].uri).toBe('artifact://session/img-1');
    });
  });

  describe('resource metadata', () => {
    it('should return metadata with runId, stepId, provider, model, tags', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-42', 'step-gen', 'stability', 'sd3', [
        'test',
        'photo',
      ]);
      const list = await handler.listResources();
      expect(list[0].metadata).toEqual({
        runId: 'run-42',
        stepId: 'step-gen',
        provider: 'stability',
        model: 'sd3',
        tags: ['test', 'photo'],
      });
    });

    it('should include description with step, provider, and model', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-gen', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].description).toContain('step-gen');
      expect(list[0].description).toContain('stability');
      expect(list[0].description).toContain('sd3');
    });

    it('should report positive size for valid artifacts', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(list[0].size).toBeGreaterThan(0);
    });

    it('should have valid ISO createdAt timestamp', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      const list = await handler.listResources();
      expect(new Date(list[0].createdAt).toISOString()).toBe(list[0].createdAt);
    });
  });

  describe('malformed URI', () => {
    it('should throw INVALID_RESOURCE_URI for malformed readResource URI', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      await expect(handler.readResource('not-a-valid-uri')).rejects.toMatchObject({
        code: 'INVALID_RESOURCE_URI',
      });
    });
  });

  describe('session retention', () => {
    it('should prune expired session-scoped resources from list/read', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session', sessionRetentionMs: 10 },
        mockStorage,
      );
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      handler.pruneExpiredResources(Date.now() + 11);

      expect(await handler.listResources()).toHaveLength(0);
      expect(await handler.readResource('artifact://session/img-1')).toBeNull();
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('should call onUpdate callback when resource is added', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      const cb = vi.fn();
      handler.onUpdate(cb);
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('should not call callback after dispose is called', async () => {
      handler = new ArtifactResourceHandler(
        { enabled: true, defaultScope: 'session' },
        mockStorage,
      );
      const cb = vi.fn();
      const dispose = handler.onUpdate(cb);
      dispose();
      await handler.addResource('img-1', 'run-1', 'step-1', 'stability', 'sd3');
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
