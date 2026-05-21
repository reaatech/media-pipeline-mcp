import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdempotencyConflictError,
  IdempotencyMiddleware,
  InMemoryIdempotencyStore,
  computeBodyHash,
} from '../idempotency.js';

describe('InMemoryIdempotencyStore', () => {
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  it('should store and retrieve entries', async () => {
    const entry = {
      key: 'test-key',
      runId: 'run-1',
      bodyHash: 'abc123',
      response: { success: true },
      status: 'completed' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    };

    await store.set(entry);
    const retrieved = await store.get('test-key');
    expect(retrieved).toBeDefined();
    expect(retrieved!.key).toBe('test-key');
    expect(retrieved!.status).toBe('completed');
  });

  it('should return undefined for missing keys', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('should delete entries', async () => {
    const entry = {
      key: 'test-key',
      runId: 'run-1',
      bodyHash: 'abc123',
      response: { success: true },
      status: 'completed' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    };

    await store.set(entry);
    await store.delete('test-key');
    const result = await store.get('test-key');
    expect(result).toBeUndefined();
  });

  it('should expire entries', async () => {
    const entry = {
      key: 'test-key',
      runId: 'run-1',
      bodyHash: 'abc123',
      response: { success: true },
      status: 'completed' as const,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000), // Already expired
    };

    await store.set(entry);
    const result = await store.get('test-key');
    expect(result).toBeUndefined();
  });

  it('should track size', () => {
    expect(store.size).toBe(0);
  });
});

describe('computeBodyHash', () => {
  it('should produce consistent hashes for same input', () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    expect(computeBodyHash(obj1)).toBe(computeBodyHash(obj2));
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = computeBodyHash({ a: 1 });
    const hash2 = computeBodyHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
  });

  it('should handle nested objects consistently', () => {
    const obj1 = { a: { x: 1, y: 2 }, b: 3 };
    const obj2 = { b: 3, a: { y: 2, x: 1 } };
    expect(computeBodyHash(obj1)).toBe(computeBodyHash(obj2));
  });

  it('should handle arrays', () => {
    const hash1 = computeBodyHash([1, 2, 3]);
    const hash2 = computeBodyHash([1, 2, 3]);
    expect(hash1).toBe(hash2);
  });
});

describe('IdempotencyMiddleware', () => {
  let middleware: IdempotencyMiddleware;
  let store: InMemoryIdempotencyStore;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    middleware = new IdempotencyMiddleware({ store, ttlMs: 3600000 });
  });

  describe('extractIdempotencyKey', () => {
    it('should extract key from _meta', () => {
      const key = middleware.extractIdempotencyKey({
        _meta: { idempotencyKey: 'abc-123' },
        prompt: 'test',
      });
      expect(key).toBe('abc-123');
    });

    it('should return undefined when _meta is missing', () => {
      const key = middleware.extractIdempotencyKey({ prompt: 'test' });
      expect(key).toBeUndefined();
    });

    it('should return undefined when key is empty', () => {
      const key = middleware.extractIdempotencyKey({
        _meta: { idempotencyKey: '' },
      });
      expect(key).toBeUndefined();
    });
  });

  describe('extractProgressToken', () => {
    it('should extract progressToken from _meta', () => {
      const token = middleware.extractProgressToken({
        _meta: { progressToken: 'token-1' },
      });
      expect(token).toBe('token-1');
    });

    it('should return undefined when _meta is missing', () => {
      const token = middleware.extractProgressToken({ prompt: 'test' });
      expect(token).toBeUndefined();
    });
  });

  describe('wrap', () => {
    it('should pass through when no idempotency key', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const wrapped = middleware.wrap(handler);

      const result = await wrapped({ prompt: 'test' });
      expect(result).toEqual({ success: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return cached response on subsequent identical calls', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, data: 'original' });
      const wrapped = middleware.wrap(handler);

      const args = {
        _meta: { idempotencyKey: 'key-1' },
        prompt: 'test',
      };

      const result1 = await wrapped(args);
      const result2 = await wrapped(args);

      expect(result1).toEqual({ success: true, data: 'original' });
      expect(result2).toEqual({ success: true, data: 'original' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should throw IdempotencyConflictError for body mismatch', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const wrapped = middleware.wrap(handler);

      await wrapped({
        _meta: { idempotencyKey: 'key-2' },
        prompt: 'first',
      });

      await expect(
        wrapped({
          _meta: { idempotencyKey: 'key-2' },
          prompt: 'different body',
        }),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('should call handler on first call and cache result', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const wrapped = middleware.wrap(handler);

      const args = {
        _meta: { idempotencyKey: 'key-3' },
        prompt: 'test',
      };

      const result = await wrapped(args);
      expect(result).toEqual({ success: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
