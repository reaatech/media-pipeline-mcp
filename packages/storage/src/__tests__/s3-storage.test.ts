import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Storage } from '../s3-storage.js';

const mockSend = vi.fn();

type MockS3ClientConfig = {
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

let mockS3ClientConfig: MockS3ClientConfig | undefined;

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class MockS3Client {
      constructor(config: MockS3ClientConfig) {
        mockS3ClientConfig = config;
      }
      send = mockSend;
    },
    GetObjectCommand: class MockGetObjectCommand {},
    PutObjectCommand: class MockPutObjectCommand {
      constructor(public input: Record<string, unknown>) {}
    },
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
    mockS3ClientConfig = undefined;
    storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', prefix: 'test-prefix/' });
  });

  describe('constructor', () => {
    it('should create an S3Storage instance with bucket and region', () => {
      const storage2 = new S3Storage({ bucket: 'my-bucket', region: 'us-west-2' });
      expect(storage2).toBeInstanceOf(S3Storage);
    });

    it('should create an S3Storage instance with custom endpoint', async () => {
      const storage2 = new S3Storage({
        bucket: 'my-bucket',
        region: 'us-east-1',
        endpoint: 'https://custom-endpoint.example.com',
      });
      await storage2.healthCheck();
      expect(mockS3ClientConfig!.endpoint).toBe('https://custom-endpoint.example.com');
      expect(mockS3ClientConfig!.forcePathStyle).toBe(true);
    });

    it('should create an S3Storage instance with access keys', async () => {
      const storage2 = new S3Storage({
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      });
      await storage2.healthCheck();
      expect(mockS3ClientConfig!.credentials!.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
    });

    it('should create an S3Storage instance without prefix', () => {
      const storage2 = new S3Storage({ bucket: 'my-bucket', region: 'us-east-1' });
      expect(storage2).toBeInstanceOf(S3Storage);
    });
  });

  describe('path traversal prevention', () => {
    it('should reject IDs with ..', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('../evil', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with /', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('foo/bar', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with \\', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('foo\\bar', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
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

    it('should handle string chunks in streamToBuffer', async () => {
      const id = 'string-stream';
      const readable = Readable.from(['string data']);
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('s3://test-bucket/test-prefix/string-stream');
    });

    it('should handle buffer chunks in streamToBuffer', async () => {
      const id = 'buffer-stream';
      const readable = Readable.from([Buffer.from('buffer data')]);
      const meta = { type: 'text' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, readable, meta);

      expect(uri).toBe('s3://test-bucket/test-prefix/buffer-stream');
    });

    it('should store with metadata fields (sourceStep, metadata)', async () => {
      const id = 'meta-artifact';
      const meta = {
        type: 'document' as const,
        mimeType: 'application/pdf',
        sourceStep: 'generate-step',
        metadata: { author: 'test', pageCount: 5 },
      };

      const uri = await storage.put(id, Buffer.from('pdf data'), meta);

      expect(uri).toBe('s3://test-bucket/test-prefix/meta-artifact');
      const lastCommand = mockSend.mock.lastCall![0];
      expect(lastCommand.input.Metadata.sourceStep).toBe('generate-step');
      expect(lastCommand.input.Metadata.metadata).toBe(
        JSON.stringify({ author: 'test', pageCount: 5 }),
      );
    });

    it('should store without prefix when none is configured', async () => {
      const storage2 = new S3Storage({ bucket: 'no-prefix-bucket', region: 'us-east-1' });
      const uri = await storage2.put('noprefix', Buffer.from('data'), {
        type: 'image' as const,
        mimeType: 'image/png',
      });
      expect(uri).toBe('s3://no-prefix-bucket/noprefix');
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
      expect(result.meta.type).toBe('image');
    });

    it('should throw error for non-existent artifact with NoSuchKey', async () => {
      mockSend.mockRejectedValue({ name: 'NoSuchKey' });

      await expect(storage.get('non-existent')).rejects.toThrow('Artifact not found: non-existent');
    });

    it('should throw error for non-existent artifact with 404 status code', async () => {
      mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });

      await expect(storage.get('non-existent')).rejects.toThrow('Artifact not found: non-existent');
    });

    it('should re-throw non-404 errors', async () => {
      mockSend.mockRejectedValue(new Error('Network error'));

      await expect(storage.get('error-id')).rejects.toThrow('Network error');
    });

    it('should handle missing ContentType gracefully', async () => {
      mockSend.mockResolvedValue({
        Body: Buffer.from('data'),
        Metadata: {},
      });

      const result = await storage.get('no-content-type');

      expect(result.meta.mimeType).toBe('application/octet-stream');
    });

    it('should parse stored metadata JSON', async () => {
      mockSend.mockResolvedValue({
        Body: Buffer.from('data'),
        ContentType: 'image/webp',
        Metadata: {
          artifacttype: 'image',
          sourcestep: 'step-1',
          metadata: JSON.stringify({ prompt: 'test prompt' }),
        },
      });

      const result = await storage.get('meta-artifact');
      expect(result.meta.sourceStep).toBe('step-1');
      expect(result.meta.metadata).toEqual({ prompt: 'test prompt' });
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

    it('should list artifacts with custom prefix filter', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/foo-1.png' }],
      });

      const list = await storage.list('foo');

      expect(list).toHaveLength(1);
    });

    it('should return empty array when no artifacts', async () => {
      mockSend.mockResolvedValue({ Contents: [] });

      const list = await storage.list();

      expect(list).toHaveLength(0);
    });

    it('should skip entries with null key', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/valid.png' }, { Key: null }],
      });

      const list = await storage.list();

      expect(list).toHaveLength(1);
    });

    it('should guess type and mime from key when metadata not present', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/photo.png' }],
      });

      const list = await storage.list();

      expect(list[0].type).toBe('image');
      expect(list[0].mimeType).toBe('image/png');
    });

    it('should guess correct types for various extensions', async () => {
      mockSend.mockResolvedValue({
        Contents: [
          { Key: 'test-prefix/a.webp' },
          { Key: 'test-prefix/b.gif' },
          { Key: 'test-prefix/c.bmp' },
          { Key: 'test-prefix/d.mp4' },
          { Key: 'test-prefix/e.webm' },
          { Key: 'test-prefix/f.mov' },
          { Key: 'test-prefix/g.avi' },
          { Key: 'test-prefix/h.mp3' },
          { Key: 'test-prefix/i.wav' },
          { Key: 'test-prefix/j.ogg' },
          { Key: 'test-prefix/k.flac' },
          { Key: 'test-prefix/l.pdf' },
          { Key: 'test-prefix/m.doc' },
          { Key: 'test-prefix/n.docx' },
          { Key: 'test-prefix/o.txt' },
        ],
      });

      const list = await storage.list();

      expect(list.find((x) => x.id === 'a.webp')!.type).toBe('image');
      expect(list.find((x) => x.id === 'b.gif')!.type).toBe('image');
      expect(list.find((x) => x.id === 'c.bmp')!.type).toBe('image');
      expect(list.find((x) => x.id === 'd.mp4')!.type).toBe('video');
      expect(list.find((x) => x.id === 'e.webm')!.type).toBe('video');
      expect(list.find((x) => x.id === 'f.mov')!.type).toBe('video');
      expect(list.find((x) => x.id === 'g.avi')!.type).toBe('video');
      expect(list.find((x) => x.id === 'h.mp3')!.type).toBe('audio');
      expect(list.find((x) => x.id === 'i.wav')!.type).toBe('audio');
      expect(list.find((x) => x.id === 'j.ogg')!.type).toBe('audio');
      expect(list.find((x) => x.id === 'k.flac')!.type).toBe('audio');
      expect(list.find((x) => x.id === 'l.pdf')!.type).toBe('document');
      expect(list.find((x) => x.id === 'm.doc')!.type).toBe('document');
      expect(list.find((x) => x.id === 'n.docx')!.type).toBe('document');
      expect(list.find((x) => x.id === 'o.txt')!.type).toBe('document');
    });

    it('should handle unknown extensions with default fallback types', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/unknown.bin' }, { Key: 'test-prefix/noext' }],
      });

      const list = await storage.list();

      expect(list[0].type).toBe('image');
      expect(list[0].mimeType).toBe('application/octet-stream');
      expect(list[1].type).toBe('image');
    });

    it('should handle undefined Contents gracefully', async () => {
      mockSend.mockResolvedValue({});

      const list = await storage.list();

      expect(list).toHaveLength(0);
    });

    it('should list without storage prefix when none is configured', async () => {
      const storage2 = new S3Storage({ bucket: 'b', region: 'us-east-1' });
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'file1.png' }, { Key: 'file2.png' }],
      });

      const list = await storage2.list();
      expect(list[0].id).toBe('file1.png');
      expect(list[1].id).toBe('file2.png');
    });

    it('should include .png and .jpg extensions for type guessing', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'test-prefix/photo.png' }, { Key: 'test-prefix/photo.jpeg' }],
      });

      const list = await storage.list();
      expect(list[0].mimeType).toBe('image/png');
      expect(list[1].mimeType).toBe('image/jpeg');
    });

    it('should strip prefix from keys in list results', async () => {
      const storage2 = new S3Storage({ bucket: 'b', region: 'us-east-1', prefix: 'custom/' });
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'custom/first.png' }, { Key: 'custom/second.png' }],
      });

      const list = await storage2.list();
      expect(list[0].id).toBe('first.png');
      expect(list[1].id).toBe('second.png');
    });

    it('should use stored metadata when present in list', async () => {
      mockSend.mockResolvedValue({
        Contents: [
          {
            Key: 'test-prefix/photo.png',
            Metadata: { artifacttype: 'image', mimetype: 'image/png' },
          },
        ],
      });

      const list = await storage.list();
      expect(list[0].type).toBe('image');
      expect(list[0].mimeType).toBe('image/png');
    });
  });

  describe('getSignedUrl', () => {
    it('should return a signed URL', async () => {
      const url = await storage.getSignedUrl('test-artifact', 3600);

      expect(url).toBe('https://signed-url.example.com');
    });

    it('should return a signed URL with default expiry', async () => {
      const url = await storage.getSignedUrl('test-artifact');

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
