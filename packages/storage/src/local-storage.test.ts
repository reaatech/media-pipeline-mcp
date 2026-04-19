import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalStorage } from './local-storage.ts';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';

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
      const meta = { contentType: 'text/plain' };

      const uri = await storage.put(id, data, meta);
      expect(uri).toBeDefined();

      const result = await storage.get(id);
      expect(result.meta).toEqual(meta);
    });

    it('should throw error for non-existent file', async () => {
      await expect(storage.get('non-existent')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an existing file', async () => {
      const id = 'test-artifact-2';
      const data = Buffer.from('To be deleted');
      const meta = { contentType: 'text/plain' };

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
      const meta1 = { contentType: 'text/plain' };
      const meta2 = { contentType: 'image/png' };

      await storage.put('artifact-1', Buffer.from('data1'), meta1);
      await storage.put('artifact-2', Buffer.from('data2'), meta2);

      const list = await storage.list();
      expect(list).toHaveLength(2);
    });

    it('should filter by prefix', async () => {
      await storage.put('prefix1-artifact-1', Buffer.from('data1'), { contentType: 'text/plain' });
      await storage.put('prefix2-artifact-2', Buffer.from('data2'), { contentType: 'text/plain' });

      const list = await storage.list('prefix1');
      expect(list).toHaveLength(1);
    });
  });

  describe('getSignedUrl', () => {
    it('should return a file:// URL for local storage', async () => {
      const id = 'test-artifact-3';
      await storage.put(id, Buffer.from('data'), { contentType: 'text/plain' });

      const url = await storage.getSignedUrl(id, 3600);
      expect(url).toContain('file://');
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

      await storage.put(id, readable, { contentType: 'text/plain' });

      const result = await storage.get(id);
      expect(result.meta.contentType).toBe('text/plain');
    });
  });

  describe('destroy', () => {
    it('should clear cleanup interval when TTL is set', async () => {
      const ttlStorage = new LocalStorage({ basePath: testDir, ttl: 60000 });
      ttlStorage.destroy();
      // Should not throw
    });

    it('should not throw when no TTL is set', () => {
      storage.destroy();
    });
  });
});
