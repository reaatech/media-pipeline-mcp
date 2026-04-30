import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GCSStorage } from './gcs-storage.ts';

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

vi.mock('@google-cloud/storage', () => {
  return {
    Storage: class MockStorage {
      bucket = vi.fn().mockReturnValue(mockBucket);
    },
  };
});

describe('GCSStorage', () => {
  let storage: GCSStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBucket.exists.mockResolvedValue([true]);
    mockFile.exists.mockResolvedValue([true]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.delete.mockResolvedValue(undefined);
    mockFile.getMetadata.mockResolvedValue([
      { contentType: 'image/png', metadata: { artifacttype: 'image' } },
    ]);
    mockFile.getSignedUrl.mockResolvedValue(['https://signed-url.example.com']);
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
  });

  describe('get', () => {
    it('should retrieve an artifact', async () => {
      const result = await storage.get('test-artifact');

      expect(result.meta.mimeType).toBe('image/png');
      expect(mockFile.createReadStream).toHaveBeenCalled();
    });

    it('should throw error for non-existent artifact', async () => {
      mockFile.exists.mockResolvedValue([false]);

      await expect(storage.get('non-existent')).rejects.toThrow();
    });
  });

  describe('getSignedUrl', () => {
    it('should return a signed URL', async () => {
      const url = await storage.getSignedUrl('test-artifact');

      expect(url).toBe('https://signed-url.example.com');
    });

    it('should throw for non-existent artifact', async () => {
      mockFile.getSignedUrl.mockRejectedValue({ code: 404 });

      await expect(storage.getSignedUrl('non-existent')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an artifact', async () => {
      await storage.delete('test-artifact');

      expect(mockFile.delete).toHaveBeenCalled();
    });

    it('should not throw for non-existent artifact', async () => {
      mockFile.delete.mockRejectedValue({ code: 404 });

      await expect(storage.delete('non-existent')).resolves.not.toThrow();
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
  });
});
