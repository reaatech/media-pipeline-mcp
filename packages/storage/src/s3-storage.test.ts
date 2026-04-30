import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from './s3-storage.ts';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      send = mockSend;
    },
    GetObjectCommand: class MockGetObjectCommand {},
    PutObjectCommand: class MockPutObjectCommand {},
    DeleteObjectCommand: class MockDeleteObjectCommand {},
    HeadBucketCommand: class MockHeadBucketCommand {},
    ListObjectsV2Command: class MockListObjectsV2Command {},
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => {
  return {
    getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
  };
});

describe('S3Storage', () => {
  let storage: S3Storage;

  beforeEach(() => {
    mockSend.mockResolvedValue({});
    storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', prefix: 'test-prefix/' });
  });

  describe('constructor', () => {
    it('should create an S3Storage instance with bucket and region', () => {
      const storage2 = new S3Storage({ bucket: 'my-bucket', region: 'us-west-2' });
      expect(storage2).toBeInstanceOf(S3Storage);
    });

    it('should create an S3Storage instance with custom endpoint', () => {
      const storage2 = new S3Storage({
        bucket: 'my-bucket',
        region: 'us-east-1',
        endpoint: 'https://custom-endpoint.example.com',
      });
      expect(storage2).toBeInstanceOf(S3Storage);
    });

    it('should create an S3Storage instance with access keys', () => {
      const storage2 = new S3Storage({
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      });
      expect(storage2).toBeInstanceOf(S3Storage);
    });
  });

  describe('put', () => {
    it('should store a buffer and return URI', async () => {
      const id = 'test-artifact';
      const data = Buffer.from('Hello, World!');
      const meta = { type: 'image' as const, mimeType: 'image/png' };

      const uri = await storage.put(id, data, meta);

      expect(uri).toBe('s3://test-bucket/test-prefix/test-artifact');
      expect(mockSend).toHaveBeenCalled();
    });

    it('should store a ReadableStream and return URI', async () => {
      const id = 'test-artifact-stream';
      const data = Buffer.from('Hello from stream!');
      const readable = Readable.from(data);
      const meta = { type: 'image' as const, mimeType: 'image/png' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('s3://test-bucket/test-prefix/test-artifact-stream');
    });
  });

  describe('get', () => {
    it('should retrieve an artifact', async () => {
      mockSend.mockResolvedValue({
        Body: Buffer.from('test data'),
        ContentType: 'image/png',
        Metadata: { artifacttype: 'image' },
      });

      const result = await storage.get('test-artifact');

      expect(result.meta.mimeType).toBe('image/png');
    });

    it('should throw error for non-existent artifact', async () => {
      mockSend.mockRejectedValue({ name: 'NoSuchKey' });

      await expect(storage.get('non-existent')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an artifact', async () => {
      await storage.delete('test-artifact');

      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should list artifacts with prefix', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/artifact1.png' }, { Key: 'test-prefix/artifact2.png' }],
      });

      const list = await storage.list();

      expect(list).toHaveLength(2);
    });

    it('should return empty array when no artifacts', async () => {
      mockSend.mockResolvedValue({ Contents: [] });

      const list = await storage.list();

      expect(list).toHaveLength(0);
    });
  });

  describe('getSignedUrl', () => {
    it('should return a signed URL', async () => {
      const url = await storage.getSignedUrl('test-artifact', 3600);

      expect(url).toBe('https://signed-url.example.com');
    });
  });

  describe('healthCheck', () => {
    it('should return true when S3 is accessible', async () => {
      const healthy = await storage.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false when S3 is not accessible', async () => {
      mockSend.mockRejectedValue(new Error('Connection failed'));

      const healthy = await storage.healthCheck();
      expect(healthy).toBe(false);
    });
  });
});
