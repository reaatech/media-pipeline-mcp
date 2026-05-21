import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GCSStorage } from '../gcs-storage.js';

const mockFile = {
  save: vi.fn().mockResolvedValue(undefined),
  createReadStream: vi.fn().mockReturnValue('mock-read-stream'),
  exists: vi.fn().mockResolvedValue([true]),
  delete: vi.fn().mockResolvedValue(undefined),
  getMetadata: vi
    .fn()
    .mockResolvedValue([{ contentType: 'image/png', metadata: { artifacttype: 'image' } }]),
  getSignedUrl: vi.fn().mockResolvedValue(['https://signed-url.example.com']),
};

const mockBucket = {
  file: vi.fn().mockReturnValue(mockFile),
  exists: vi.fn().mockResolvedValue([true]),
  getFiles: vi.fn().mockResolvedValue([
    [
      { name: 'test-prefix/artifact1.png', metadata: { contentType: 'image/png', size: '100' } },
      { name: 'test-prefix/artifact2.png', metadata: { contentType: 'image/png', size: '200' } },
    ],
  ]),
};

let mockStorageConstructor: unknown[] | undefined;

vi.mock('@google-cloud/storage', () => {
  const MockStorage = class MockStorage {
    constructor(...args: unknown[]) {
      mockStorageConstructor = args;
    }
    bucket = vi.fn().mockReturnValue(mockBucket);
  };
  return { Storage: MockStorage };
});

describe('GCSStorage', () => {
  let storage: GCSStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageConstructor = undefined;
    mockBucket.exists.mockResolvedValue([true]);
    mockFile.exists.mockResolvedValue([true]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.delete.mockResolvedValue(undefined);
    mockFile.getMetadata.mockResolvedValue([
      { contentType: 'image/png', metadata: { artifacttype: 'image' } },
    ]);
    mockFile.getSignedUrl.mockResolvedValue(['https://signed-url.example.com']);
    mockBucket.getFiles.mockResolvedValue([
      [
        { name: 'test-prefix/artifact1.png', metadata: { contentType: 'image/png', size: '100' } },
        { name: 'test-prefix/artifact2.png', metadata: { contentType: 'image/png', size: '200' } },
      ],
    ]);
    storage = new GCSStorage({ bucket: 'test-bucket', prefix: 'test-prefix/' });
  });

  describe('constructor', () => {
    it('should create a GCSStorage instance with bucket and prefix', () => {
      const storage2 = new GCSStorage({ bucket: 'my-bucket', prefix: 'my-prefix/' });
      expect(storage2).toBeInstanceOf(GCSStorage);
    });

    it('should create a GCSStorage instance without prefix', () => {
      const storage2 = new GCSStorage({ bucket: 'my-bucket' });
      expect(storage2).toBeInstanceOf(GCSStorage);
    });

    it('should pass projectId to Storage constructor', async () => {
      const gcs = new GCSStorage({ bucket: 'b', projectId: 'my-project' });
      await gcs.healthCheck();
      expect(
        (mockStorageConstructor?.[0] as { projectId?: string; keyFilename?: string })?.projectId,
      ).toBe('my-project');
    });

    it('should pass keyFilename to Storage constructor', async () => {
      const gcs = new GCSStorage({ bucket: 'b', keyFilename: '/path/to/key.json' });
      await gcs.healthCheck();
      expect(
        (mockStorageConstructor?.[0] as { projectId?: string; keyFilename?: string })?.keyFilename,
      ).toBe('/path/to/key.json');
    });
  });

  describe('path traversal prevention', () => {
    it('should reject IDs with ..', async () => {
      const meta = { type: 'image' as const, mimeType: 'text/plain' };
      await expect(storage.put('../evil', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with /', async () => {
      const meta = { type: 'image' as const, mimeType: 'text/plain' };
      await expect(storage.put('foo/bar', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with \\', async () => {
      const meta = { type: 'image' as const, mimeType: 'text/plain' };
      await expect(storage.put('foo\\bar', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });
  });

  describe('put', () => {
    it('should store a buffer and return URI', async () => {
      const id = 'test-artifact';
      const data = Buffer.from('Hello, World!');
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, data, meta);

      expect(uri).toBe('gs://test-bucket/test-prefix/test-artifact');
      expect(mockFile.save).toHaveBeenCalled();
    });

    it('should store a stream and return URI', async () => {
      const id = 'test-artifact-stream';
      const data = Buffer.from('Hello from stream!');
      const readable = Readable.from(data);
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('gs://test-bucket/test-prefix/test-artifact-stream');
    });

    it('should handle string chunks in streamToBuffer', async () => {
      const id = 'string-stream';
      const readable = Readable.from(['hello world']);
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('gs://test-bucket/test-prefix/string-stream');
    });

    it('should handle buffer chunks in streamToBuffer', async () => {
      const id = 'buffer-stream';
      const readable = Readable.from([Buffer.from('buffer data')]);
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('gs://test-bucket/test-prefix/buffer-stream');
    });

    it('should store with sourceStep and metadata fields', async () => {
      const id = 'meta-artifact';
      const meta = {
        type: 'video' as const,
        mimeType: 'video/mp4',
        sourceStep: 'generate-video',
        metadata: { duration: 30, fps: 24 },
      };

      await storage.put(id, Buffer.from('video data'), meta);

      const saveCall = mockFile.save.mock.calls[0];
      expect(saveCall[1].metadata.metadata.sourceStep).toBe('generate-video');
      expect(saveCall[1].metadata.metadata.artifactMetadata).toBe(
        JSON.stringify({ duration: 30, fps: 24 }),
      );
    });

    it('should store without prefix when none is configured', async () => {
      const storage2 = new GCSStorage({ bucket: 'no-prefix-bucket' });
      const uri = await storage2.put('noprefix', Buffer.from('data'), {
        type: 'text' as const,
        mimeType: 'text/plain',
      });
      expect(uri).toBe('gs://no-prefix-bucket/noprefix');
    });
  });

  describe('get', () => {
    it('should retrieve an artifact', async () => {
      const result = await storage.get('test-artifact');

      expect(result.meta.mimeType).toBe('image/png');
      expect(mockFile.createReadStream).toHaveBeenCalled();
    });

    it('should throw error for non-existent artifact', async () => {
      mockFile.exists.mockResolvedValue([false]);

      await expect(storage.get('non-existent')).rejects.toThrow('Artifact not found: non-existent');
    });

    it('should throw 404 error with cause', async () => {
      mockFile.exists.mockRejectedValue({ code: 404 });

      await expect(storage.get('missing-404')).rejects.toThrow('Artifact not found: missing-404');
    });

    it('should re-throw non-404 errors', async () => {
      mockFile.exists.mockRejectedValue(new Error('Connection refused'));

      await expect(storage.get('error-id')).rejects.toThrow('Connection refused');
    });

    it('should extract full metadata from stored artifact', async () => {
      mockFile.getMetadata.mockResolvedValue([
        {
          contentType: 'image/webp',
          metadata: {
            artifacttype: 'image',
            sourcestep: 'step-2',
            artifactmetadata: JSON.stringify({ prompt: 'sunset' }),
          },
        },
      ]);

      const result = await storage.get('full-meta');
      expect(result.meta.mimeType).toBe('image/webp');
      expect(result.meta.type).toBe('image');
      expect(result.meta.sourceStep).toBe('step-2');
      expect(result.meta.metadata).toEqual({ prompt: 'sunset' });
    });

    it('should handle missing contentType gracefully', async () => {
      mockFile.getMetadata.mockResolvedValue([{ metadata: { artifacttype: 'image' } }]);

      const result = await storage.get('no-content-type');
      expect(result.meta.mimeType).toBe('application/octet-stream');
    });

    it('should fall back to image type when artifacttype is missing', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { contentType: 'text/plain', metadata: { sourcestep: 'step' } },
      ]);

      const result = await storage.get('no-type');
      expect(result.meta.type).toBe('image');
    });

    it('should handle missing artifactmetadata gracefully', async () => {
      mockFile.getMetadata.mockResolvedValue([
        { contentType: 'image/png', metadata: { artifacttype: 'image', sourcestep: 'step-1' } },
      ]);

      const result = await storage.get('no-artifactmeta');
      expect(result.meta.sourceStep).toBe('step-1');
      expect(result.meta.metadata).toBeUndefined();
    });
  });

  describe('getSignedUrl', () => {
    it('should return a signed URL', async () => {
      const url = await storage.getSignedUrl('test-artifact');

      expect(url).toBe('https://signed-url.example.com');
    });

    it('should pass custom expiresIn', async () => {
      await storage.getSignedUrl('test-artifact', 7200);

      expect(mockFile.getSignedUrl).toHaveBeenCalledWith({
        action: 'read',
        expires: expect.any(Number),
      });
    });

    it('should throw for non-existent artifact', async () => {
      mockFile.getSignedUrl.mockRejectedValue({ code: 404 });

      await expect(storage.getSignedUrl('non-existent')).rejects.toThrow(
        'Artifact not found: non-existent',
      );
    });

    it('should re-throw non-404 errors', async () => {
      mockFile.getSignedUrl.mockRejectedValue(new Error('Signing failed'));

      await expect(storage.getSignedUrl('error-id')).rejects.toThrow('Signing failed');
    });
  });

  describe('delete', () => {
    it('should delete an artifact', async () => {
      await storage.delete('test-artifact');

      expect(mockFile.delete).toHaveBeenCalled();
    });

    it('should not throw for non-existent artifact (404)', async () => {
      mockFile.delete.mockRejectedValue({ code: 404 });

      await expect(storage.delete('non-existent')).resolves.not.toThrow();
    });

    it('should re-throw non-404 errors', async () => {
      mockFile.delete.mockRejectedValue(new Error('Delete failed'));

      await expect(storage.delete('error-id')).rejects.toThrow('Delete failed');
    });
  });

  describe('list', () => {
    it('should list artifacts', async () => {
      const list = await storage.list();

      expect(list).toHaveLength(2);
    });

    it('should filter by prefix', async () => {
      const list = await storage.list('prefix1');

      expect(list).toHaveLength(2);
    });

    it('should handle empty results', async () => {
      mockBucket.getFiles.mockResolvedValue([[]]);

      const list = await storage.list();
      expect(list).toHaveLength(0);
    });

    it('should skip entries with empty name', async () => {
      mockBucket.getFiles.mockResolvedValue([
        [
          { name: 'test-prefix/valid.png', metadata: { contentType: 'image/png', size: '100' } },
          { name: '', metadata: { contentType: '', size: '0' } },
        ],
      ]);

      const list = await storage.list();
      expect(list).toHaveLength(1);
    });

    it('should guess types for various extensions', async () => {
      mockBucket.getFiles.mockResolvedValue([
        [
          { name: 'test-prefix/a.png', metadata: { size: '1' } },
          { name: 'test-prefix/b.jpg', metadata: { size: '1' } },
          { name: 'test-prefix/c.webp', metadata: { size: '1' } },
          { name: 'test-prefix/d.gif', metadata: { size: '1' } },
          { name: 'test-prefix/e.bmp', metadata: { size: '1' } },
          { name: 'test-prefix/f.mp4', metadata: { size: '1' } },
          { name: 'test-prefix/g.webm', metadata: { size: '1' } },
          { name: 'test-prefix/h.mov', metadata: { size: '1' } },
          { name: 'test-prefix/i.avi', metadata: { size: '1' } },
          { name: 'test-prefix/j.mp3', metadata: { size: '1' } },
          { name: 'test-prefix/k.wav', metadata: { size: '1' } },
          { name: 'test-prefix/l.ogg', metadata: { size: '1' } },
          { name: 'test-prefix/m.flac', metadata: { size: '1' } },
          { name: 'test-prefix/n.pdf', metadata: { size: '1' } },
          { name: 'test-prefix/o.doc', metadata: { size: '1' } },
          { name: 'test-prefix/p.docx', metadata: { size: '1' } },
          { name: 'test-prefix/q.txt', metadata: { size: '1' } },
        ],
      ]);

      const list = await storage.list();

      expect(list.find((x) => x.id === 'a.png')!.mimeType).toBe('image/png');
      expect(list.find((x) => x.id === 'b.jpg')!.mimeType).toBe('image/jpeg');
      expect(list.find((x) => x.id === 'c.webp')!.mimeType).toBe('image/webp');
      expect(list.find((x) => x.id === 'd.gif')!.mimeType).toBe('image/gif');
      expect(list.find((x) => x.id === 'f.mp4')!.mimeType).toBe('video/mp4');
      expect(list.find((x) => x.id === 'g.webm')!.mimeType).toBe('video/webm');
      expect(list.find((x) => x.id === 'j.mp3')!.mimeType).toBe('audio/mpeg');
      expect(list.find((x) => x.id === 'k.wav')!.mimeType).toBe('audio/wav');
      expect(list.find((x) => x.id === 'n.pdf')!.mimeType).toBe('application/pdf');
    });

    it('should handle unknown extensions with default fallback', async () => {
      mockBucket.getFiles.mockResolvedValue([
        [{ name: 'test-prefix/unknown.bin', metadata: { size: '1' } }],
      ]);

      const list = await storage.list();
      expect(list[0].mimeType).toBe('application/octet-stream');
      expect(list[0].type).toBe('image');
    });

    it('should extract metadata from files when present', async () => {
      mockBucket.getFiles.mockResolvedValue([
        [
          {
            name: 'test-prefix/photo.png',
            metadata: {
              contentType: 'image/png',
              size: '500',
              metadata: {
                artifacttype: 'image',
                sourcestep: 'gen-step',
              },
            },
          },
        ],
      ]);

      const list = await storage.list();
      expect(list[0].sourceStep).toBe('gen-step');
      expect(list[0].type).toBe('image');
      expect(list[0].size).toBe(500);
    });

    it('should strip prefix from names in list', async () => {
      const storage2 = new GCSStorage({ bucket: 'b', prefix: 'custom/' });
      mockBucket.getFiles.mockResolvedValue([
        [
          { name: 'custom/first.png', metadata: { contentType: 'image/png' } },
          { name: 'custom/second.png', metadata: { contentType: 'image/png' } },
        ],
      ]);

      const list = await storage2.list();
      expect(list[0].id).toBe('first.png');
      expect(list[1].id).toBe('second.png');
    });

    it('should use no prefix when listing without prefix and no storage prefix', async () => {
      const storage2 = new GCSStorage({ bucket: 'b' });
      mockBucket.getFiles.mockResolvedValue([
        [{ name: 'file.png', metadata: { contentType: 'image/png' } }],
      ]);

      const list = await storage2.list('custom-filter');
      expect(list).toHaveLength(1);
    });
  });

  describe('healthCheck', () => {
    it('should return true when bucket exists', async () => {
      const healthy = await storage.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when bucket does not exist', async () => {
      mockBucket.exists.mockResolvedValue([false]);

      const healthy = await storage.healthCheck();
      expect(healthy).toBe(false);
    });

    it('should return false on error', async () => {
      mockBucket.exists.mockRejectedValue(new Error('API error'));

      const healthy = await storage.healthCheck();
      expect(healthy).toBe(false);
    });
  });
});
