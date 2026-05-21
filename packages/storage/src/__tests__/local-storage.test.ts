import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '../local-storage.js';

describe('LocalStorage', () => {
  let storage: LocalStorage;
  const testDir = join(tmpdir(), `media-storage-test-${Date.now()}`);

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    storage = new LocalStorage({ basePath: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('put and get', () => {
    it('should store and retrieve a file', async () => {
      const id = 'test-artifact-1';
      const data = Buffer.from('Hello, World!');
      const meta = { type: 'image' as const, mimeType: 'text/plain' };

      const uri = await storage.put(id, data, meta);
      expect(uri).toBe(`file://${join(testDir, 'test-artifact-1.txt')}`);

      const result = await storage.get(id);
      expect(result.meta).toMatchObject(meta);
    });

    it('should throw error for non-existent file', async () => {
      await expect(storage.get('non-existent')).rejects.toThrow('Artifact not found: non-existent');
    });
  });

  describe('delete', () => {
    it('should delete an existing file', async () => {
      const id = 'test-artifact-2';
      const data = Buffer.from('To be deleted');
      const meta = { type: 'image' as const, mimeType: 'text/plain' };

      await storage.put(id, data, meta);
      await storage.delete(id);

      await expect(storage.get(id)).rejects.toThrow();
    });

    it('should not throw for non-existent file', async () => {
      await expect(storage.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('list', () => {
    it('should list stored artifacts', async () => {
      const meta1 = { type: 'image' as const, mimeType: 'text/plain' };
      const meta2 = { type: 'image' as const, mimeType: 'image/png' };

      await storage.put('artifact-1', Buffer.from('data1'), meta1);
      await storage.put('artifact-2', Buffer.from('data2'), meta2);

      const list = await storage.list();
      expect(list).toHaveLength(2);
    });

    it('should filter by prefix', async () => {
      await storage.put('prefix1-artifact-1', Buffer.from('data1'), {
        type: 'image' as const,
        mimeType: 'text/plain',
      });
      await storage.put('prefix2-artifact-2', Buffer.from('data2'), {
        type: 'image' as const,
        mimeType: 'text/plain',
      });

      const list = await storage.list('prefix1');
      expect(list).toHaveLength(1);
    });
  });

  describe('getSignedUrl', () => {
    it('should return a file:// URL for local storage', async () => {
      const id = 'test-artifact-3';
      await storage.put(id, Buffer.from('data'), {
        type: 'image' as const,
        mimeType: 'text/plain',
      });

      const url = await storage.getSignedUrl(id, 3600);
      expect(url).toContain('file://');
      expect(url).toContain('expires=');
    });

    it('should throw for non-existent artifact', async () => {
      await expect(storage.getSignedUrl('non-existent')).rejects.toThrow();
    });
  });

  describe('healthCheck', () => {
    it('should return true when directory is accessible', async () => {
      const healthy = await storage.healthCheck();
      expect(healthy).toBe(true);
    });

    it('should return false for non-existent directory', async () => {
      const badStorage = new LocalStorage({ basePath: '/non-existent/directory' });
      const healthy = await badStorage.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('put with ReadableStream', () => {
    it('should store data from a ReadableStream', async () => {
      const id = 'stream-artifact';
      const data = Buffer.from('Stream data content');
      const readable = Readable.from(data);

      await storage.put(id, readable, { type: 'image' as const, mimeType: 'text/plain' });

      const result = await storage.get(id);
      expect(result.meta.mimeType).toBe('text/plain');
    });
  });

  describe('destroy', () => {
    it('should clear cleanup interval when TTL is set', async () => {
      const ttlStorage = new LocalStorage({ basePath: testDir, ttl: 60000 });
      ttlStorage.destroy();
    });

    it('should not throw when no TTL is set', () => {
      storage.destroy();
    });
  });

  describe('path traversal prevention', () => {
    it('should reject IDs with ../', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('../evil', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with /', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('dir/file', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs with \\', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('windows\\path', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });

    it('should reject IDs starting with /', async () => {
      const meta = { type: 'image' as const, mimeType: 'image/png' };
      await expect(storage.put('/etc/passwd', Buffer.from('data'), meta)).rejects.toThrow(
        'Invalid artifact ID',
      );
    });
  });

  describe('get with missing metadata', () => {
    it('should create basic metadata when .meta.json is missing', async () => {
      await fs.writeFile(join(testDir, 'no-meta-file'), Buffer.from('raw data'));
      const result = await storage.get('no-meta-file');
      expect(result.meta.mimeType).toBe('application/octet-stream');
      expect(result.meta.type).toBe('image');
      expect(result.meta.size).toBe(8);
    });

    it('should handle file with extension but no metadata', async () => {
      await fs.writeFile(join(testDir, 'bare.png'), Buffer.from('image bytes'));
      const result = await storage.get('bare');
      expect(result.meta.mimeType).toBe('application/octet-stream');
    });
  });

  describe('delete error handling', () => {
    it('should re-throw non-ENOENT errors', async () => {
      vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('Permission denied'));
      await expect(storage.delete('some-id')).rejects.toThrow('Permission denied');
      vi.restoreAllMocks();
    });
  });

  describe('list with invalid prefix', () => {
    it('should throw for prefix with ../', async () => {
      await expect(storage.list('../')).rejects.toThrow('Invalid prefix');
    });

    it('should throw for prefix with /', async () => {
      await expect(storage.list('a/b')).rejects.toThrow('Invalid prefix');
    });

    it('should throw for prefix with \\', async () => {
      await expect(storage.list('a\\b')).rejects.toThrow('Invalid prefix');
    });

    it('should throw for prefix starting with /', async () => {
      await expect(storage.list('/etc')).rejects.toThrow('Invalid prefix');
    });
  });

  describe('list with corrupt metadata', () => {
    it('should skip corrupt .meta.json files', async () => {
      await storage.put('good', Buffer.from('data'), {
        type: 'image' as const,
        mimeType: 'text/plain',
      });
      await fs.writeFile(join(testDir, 'bad.png.meta.json'), 'not valid json at all');
      const list = await storage.list();
      expect(list).toHaveLength(1);
    });
  });

  describe('content type extension mapping', () => {
    it('should map known mime types to extensions', async () => {
      const cases = [
        { mimeType: 'image/png', ext: '.png' },
        { mimeType: 'image/jpeg', ext: '.jpg' },
        { mimeType: 'image/webp', ext: '.webp' },
        { mimeType: 'image/gif', ext: '.gif' },
        { mimeType: 'audio/mpeg', ext: '.mp3' },
        { mimeType: 'audio/wav', ext: '.wav' },
        { mimeType: 'audio/ogg', ext: '.ogg' },
        { mimeType: 'video/mp4', ext: '.mp4' },
        { mimeType: 'video/webm', ext: '.webm' },
        { mimeType: 'text/plain', ext: '.txt' },
        { mimeType: 'application/json', ext: '.json' },
        { mimeType: 'application/pdf', ext: '.pdf' },
      ];

      for (const { mimeType, ext } of cases) {
        const id = `ext-test-${ext.replace('.', '')}`;
        const uri = await storage.put(id, Buffer.from('test'), {
          type: 'image' as const,
          mimeType,
        });
        expect(uri).toBe(`file://${join(testDir, id)}${ext}`);
      }
    });

    it('should fall back to .bin for unknown mime types', async () => {
      const uri = await storage.put('unknown-type', Buffer.from('test'), {
        type: 'image' as const,
        mimeType: 'application/x-unknown',
      });
      expect(uri).toBe(`file://${join(testDir, 'unknown-type.bin')}`);
    });
  });

  describe('TTL cleanup', () => {
    it('should clean up expired files via cleanup method', async () => {
      const ttlStorage = new LocalStorage({
        basePath: testDir,
        ttl: 50,
      });
      const ttlInternal = ttlStorage as unknown as {
        cleanup(): Promise<void>;
        destroy(): void;
      };
      await ttlStorage.put('expire-me', Buffer.from('data'), {
        type: 'image' as const,
        mimeType: 'text/plain',
      });

      await expect(ttlStorage.get('expire-me')).resolves.toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 60));

      await ttlInternal.cleanup();

      await expect(ttlStorage.get('expire-me')).rejects.toThrow();
      ttlInternal.destroy();
    }, 10000);

    it('should not fail cleanup when no TTL is set', async () => {
      const ttlStorage = new LocalStorage({ basePath: testDir }) as unknown as {
        cleanup(): Promise<void>;
      };
      await ttlStorage.cleanup();
    });

    it('should handle cleanup errors gracefully', async () => {
      const ttlStorage = new LocalStorage({
        basePath: testDir,
        ttl: 100,
      }) as unknown as { cleanup(): Promise<void>; destroy(): void };
      vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('Disk error'));
      await ttlStorage.cleanup();
      vi.restoreAllMocks();
      ttlStorage.destroy();
    });
  });

  describe('delete ENOENT handling', () => {
    it('should handle ENOENT from readdir gracefully', async () => {
      vi.spyOn(fs, 'readdir').mockRejectedValue({ code: 'ENOENT' });
      await expect(storage.delete('some-id')).resolves.not.toThrow();
      vi.restoreAllMocks();
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
    expect(mod.createStorage).toBeDefined();
  });

  it('should create storage factory for each type', async () => {
    const { createStorage } = await import('../index.js');
    const local = createStorage({ type: 'local', config: { basePath: '/tmp/test-factory' } });
    expect(local).toBeDefined();
  });
});
