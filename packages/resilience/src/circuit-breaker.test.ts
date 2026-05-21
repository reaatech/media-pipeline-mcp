import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitBreakerError, createCircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('state transitions', () => {
    it('should start in closed state', () => {
      cb = new CircuitBreaker('test');
      expect(cb.getStats().state).toBe('closed');
    });

    it('should transition from closed to open on failure threshold', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 3, timeout: 10000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});

      expect(cb.getStats().state).toBe('open');
      expect(cb.getStats().failures).toBe(3);
    });

    it('should remain closed below failure threshold', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 3, timeout: 10000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});

      expect(cb.getStats().state).toBe('closed');
    });

    it('should transition from open to half-open after timeout', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', { failureThreshold: 2, successThreshold: 1, timeout: 1000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      vi.advanceTimersByTime(1000);
      expect(cb.getStats().state).toBe('open');

      await cb.execute(async () => 'success');
      expect(cb.getStats().state).toBe('closed');
    });

    it('should transition from half-open to closed on success', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', { failureThreshold: 2, successThreshold: 1, timeout: 1000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      vi.advanceTimersByTime(1000);
      const result = await cb.execute(async () => 'recovered');
      expect(result).toBe('recovered');
      expect(cb.getStats().state).toBe('closed');
    });

    it('should transition from half-open back to open on failure', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', { failureThreshold: 2, successThreshold: 1, timeout: 1000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      vi.advanceTimersByTime(1000);

      await cb
        .execute(() => {
          throw new Error('half-open fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');
    });

    it('should reset failure count on success in closed state', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 3, timeout: 10000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().failures).toBe(1);

      await cb.execute(async () => 'success');
      expect(cb.getStats().failures).toBe(0);
      expect(cb.getStats().state).toBe('closed');
    });

    it('should require successThreshold successes in half-open to close', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        successThreshold: 3,
        timeout: 1000,
      });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      vi.advanceTimersByTime(1000);

      await cb.execute(async () => 'ok1');
      expect(cb.getStats().state).toBe('half-open');
      expect(cb.getStats().successes).toBe(1);

      await cb.execute(async () => 'ok2');
      expect(cb.getStats().state).toBe('half-open');

      await cb.execute(async () => 'ok3');
      expect(cb.getStats().state).toBe('closed');
    });
  });

  describe('request handling', () => {
    it('should allow requests in closed state', async () => {
      cb = new CircuitBreaker('test');

      const result = await cb.execute(async () => 'data');
      expect(result).toBe('data');
    });

    it('should reject requests in open state', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 10000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});

      await expect(cb.execute(async () => 'data')).rejects.toThrow(CircuitBreakerError);
    });

    it('should allow request in half-open state', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', { failureThreshold: 2, successThreshold: 1, timeout: 1000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      vi.advanceTimersByTime(1000);

      const result = await cb.execute(async () => 'half-open-success');
      expect(result).toBe('half-open-success');
      expect(cb.getStats().state).toBe('closed');
    });

    it('should rethrow original error (not CircuitBreakerError) on failure', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 3, timeout: 10000 });

      await expect(
        cb.execute(async () => {
          throw new Error('original error');
        }),
      ).rejects.toThrow('original error');
    });

    it('should include retryAfter in CircuitBreakerError', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 5000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});

      try {
        await cb.execute(async () => 'never');
      } catch (e) {
        expect(e).toBeInstanceOf(CircuitBreakerError);
        const err = e as CircuitBreakerError;
        expect(err.name).toBe('CircuitBreakerError');
        expect(err.retryAfter).toBeGreaterThan(0);
        expect(err.retryAfter).toBeLessThanOrEqual(5000);
        expect(err.message).toContain("'test'");
      }
    });
  });

  describe('configuration', () => {
    it('should have configurable thresholds', () => {
      cb = new CircuitBreaker('custom', {
        failureThreshold: 10,
        successThreshold: 5,
        timeout: 30000,
        monitoringWindow: 60000,
      });

      expect(cb.name).toBe('custom');
      expect(cb.getStats().state).toBe('closed');

      const stats = cb.getStats();
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
    });

    it('should create via factory function', () => {
      cb = createCircuitBreaker('factory-test');
      expect(cb).toBeInstanceOf(CircuitBreaker);
      expect(cb.name).toBe('factory-test');
    });

    it('should use default config values', () => {
      cb = new CircuitBreaker('defaults');
      expect(cb.getStats().state).toBe('closed');
    });
  });

  describe('manual controls', () => {
    it('should reset the circuit breaker', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 1, timeout: 10000 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      cb.reset();
      expect(cb.getStats().state).toBe('closed');
      expect(cb.getStats().failures).toBe(0);
      expect(cb.getStats().successes).toBe(0);
    });

    it('should force open the circuit breaker', () => {
      cb = new CircuitBreaker('test');
      expect(cb.getStats().state).toBe('closed');

      cb.forceOpen();
      expect(cb.getStats().state).toBe('open');
      expect(cb.getStats().openedAt).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      vi.useFakeTimers();
      cb = new CircuitBreaker('stats-test', { failureThreshold: 3, timeout: 1000 });

      let stats = cb.getStats();
      expect(stats.state).toBe('closed');
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.lastFailureTime).toBeUndefined();
      expect(stats.lastSuccessTime).toBeUndefined();

      await cb.execute(async () => 'ok');
      stats = cb.getStats();
      expect(stats.lastSuccessTime).toBeDefined();

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      stats = cb.getStats();
      expect(stats.lastFailureTime).toBeDefined();
      expect(stats.failures).toBe(1);
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple concurrent successful requests', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 5, timeout: 5000 });

      const results = await Promise.all([
        cb.execute(async () => 'a'),
        cb.execute(async () => 'b'),
        cb.execute(async () => 'c'),
      ]);

      expect(results).toEqual(['a', 'b', 'c']);
      expect(cb.getStats().failures).toBe(0);
    });
  });

  describe('half-open concurrency guard', () => {
    it('should allow second probe when first completes', async () => {
      cb = new CircuitBreaker('test', { failureThreshold: 2, successThreshold: 1, timeout: 100 });

      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(() => {
          throw new Error('fail');
        })
        .catch(() => {});
      expect(cb.getStats().state).toBe('open');

      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = await cb.execute(async () => 'probe');
      expect(result).toBe('probe');
      expect(cb.getStats().state).toBe('closed');
    });
  });
});
