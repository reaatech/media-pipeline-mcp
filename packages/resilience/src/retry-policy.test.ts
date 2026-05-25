import { describe, expect, it, vi } from 'vitest';
import { createRetryPolicy, MaxRetriesExceededError, RetryPolicy } from './retry-policy.js';

describe('RetryPolicy', () => {
  describe('default values', () => {
    it('should have sensible defaults', () => {
      const policy = new RetryPolicy();
      expect(policy).toBeInstanceOf(RetryPolicy);
    });

    it('should create via factory function', () => {
      const policy = createRetryPolicy();
      expect(policy).toBeInstanceOf(RetryPolicy);
    });

    it('should execute successfully on first try with no config', async () => {
      const policy = new RetryPolicy();
      const result = await policy.execute(async () => 'hello');
      expect(result).toBe('hello');
    });
  });

  describe('retry behavior', () => {
    it('should retry on failure and eventually succeed', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 10, jitter: false });

      let callCount = 0;
      const result = await policy.execute(async () => {
        callCount++;
        if (callCount < 3) throw new Error('ECONNRESET');
        return 'success';
      });

      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('should respect max retries and throw MaxRetriesExceededError', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 10, jitter: false });

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNRESET');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);
    });

    it('should include cause and attempts in MaxRetriesExceededError', async () => {
      const policy = new RetryPolicy({ maxAttempts: 2, initialDelayMs: 10, jitter: false });

      try {
        await policy.execute(async () => {
          throw new Error('ETIMEDOUT');
        });
      } catch (e) {
        expect(e).toBeInstanceOf(MaxRetriesExceededError);
        const err = e as MaxRetriesExceededError;
        expect(err.cause).toBeDefined();
        expect(err.cause!.message).toBe('ETIMEDOUT');
        expect(err.attempts).toBe(2);
      }
    });

    it('should not retry non-retryable errors', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 10, jitter: false });

      let callCount = 0;
      await expect(
        policy.execute(async () => {
          callCount++;
          throw new Error('ValidationError');
        }),
      ).rejects.toThrow('ValidationError');
      expect(callCount).toBe(1);
    });

    it('should retry errors matching retryable error names', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 3,
        initialDelayMs: 10,
        jitter: false,
        retryableErrors: ['CustomRetryable'],
      });

      let callCount = 0;
      await expect(
        policy.execute(async () => {
          callCount++;
          const err = new Error('custom error');
          err.name = 'CustomRetryable';
          throw err;
        }),
      ).rejects.toThrow(MaxRetriesExceededError);
      expect(callCount).toBe(3);
    });

    it('should retry errors matching error code', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 2,
        initialDelayMs: 10,
        jitter: false,
        retryableErrors: ['ERR_RETRY'],
      });

      let callCount = 0;
      await expect(
        policy.execute(async () => {
          callCount++;
          const err = new Error('some error') as Error & { code?: string };
          err.code = 'ERR_RETRY';
          throw err;
        }),
      ).rejects.toThrow(MaxRetriesExceededError);
      expect(callCount).toBe(2);
    });

    it('should retry errors matching message substring', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 2,
        initialDelayMs: 10,
        jitter: false,
        retryableErrors: ['timeout'],
      });

      let callCount = 0;
      await expect(
        policy.execute(async () => {
          callCount++;
          throw new Error('connection timeout occurred');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);
      expect(callCount).toBe(2);
    });

    it('should retry all errors when retryableErrors is empty', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 2,
        initialDelayMs: 10,
        jitter: false,
        retryableErrors: [],
      });

      let callCount = 0;
      await expect(
        policy.execute(async () => {
          callCount++;
          throw new Error('any error is retryable');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);
      expect(callCount).toBe(2);
    });

    it('should succeed on first attempt', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 10, jitter: false });

      const result = await policy.execute(async () => 'immediate');
      expect(result).toBe('immediate');
    });
  });

  describe('backoff calculation', () => {
    it('should call retry listeners with correct delay', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 100, jitter: false });

      const listener = vi.fn();
      policy.onRetry(listener);

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNRESET');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
      );
      expect(listener).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
      );
    });

    it('should provide last error in retry context', async () => {
      const policy = new RetryPolicy({ maxAttempts: 2, initialDelayMs: 10, jitter: false });
      const listener = vi.fn();
      policy.onRetry(listener);

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNREFUSED');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: expect.objectContaining({ message: 'ECONNREFUSED' }),
        }),
      );
    });

    it('should tolerate listener errors', async () => {
      const policy = new RetryPolicy({ maxAttempts: 2, initialDelayMs: 10, jitter: false });
      policy.onRetry(() => {
        throw new Error('listener error');
      });

      const result = await policy.execute(async () => 'ok');
      expect(result).toBe('ok');
    });

    it('should calculate exponential backoff', async () => {
      const policy = new RetryPolicy({ maxAttempts: 4, initialDelayMs: 100, jitter: false });
      const delays: number[] = [];
      policy.onRetry((ctx) => delays.push(ctx.delay));

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNRESET');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(delays.length).toBe(3);
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(400);
    });

    it('should respect max delay', async () => {
      const policy = new RetryPolicy({
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 50,
        backoffMultiplier: 3,
        jitter: false,
      });

      const delays: number[] = [];
      policy.onRetry((ctx) => delays.push(ctx.delay));

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNRESET');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);

      for (const d of delays) {
        expect(d).toBeLessThanOrEqual(50);
      }
      expect(Math.max(...delays)).toBe(50);
    });
  });

  describe('jitter', () => {
    it('should apply jitter by default', async () => {
      const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1000, jitter: true });
      const delays: number[] = [];
      policy.onRetry((ctx) => delays.push(ctx.delay));

      await expect(
        policy.execute(async () => {
          throw new Error('ECONNRESET');
        }),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(delays.length).toBe(2);
      const expectedBase = 1000 * 2 ** 0;
      const jitterRange = expectedBase * 0.75;
      expect(delays[0]).toBeGreaterThanOrEqual(jitterRange);
      expect(delays[0]).toBeLessThanOrEqual(expectedBase * 1.25);
    });
  });
});
