import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, createRateLimiter, type RateLimitConfig } from './rate-limiter.js';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  const baseConfig: RateLimitConfig = {
    clientRequestsPerMinute: 60,
    clientBurstSize: 10,
  };

  describe('constructor', () => {
    it('should create a RateLimiter with base config', () => {
      const limiter = new RateLimiter(baseConfig);
      expect(limiter).toBeInstanceOf(RateLimiter);
    });

    it('should create a RateLimiter with global limit', () => {
      const limiter = new RateLimiter({
        ...baseConfig,
        globalRequestsPerSecond: 100,
      });
      expect(limiter).toBeInstanceOf(RateLimiter);
    });

    it('should create a RateLimiter with operation limits', () => {
      const limiter = new RateLimiter({
        ...baseConfig,
        operationLimits: new Map([['image.generate', { requestsPerMinute: 10, burstSize: 2 }]]),
      });
      expect(limiter).toBeInstanceOf(RateLimiter);
    });
  });

  describe('checkLimit', () => {
    beforeEach(() => {
      rateLimiter = new RateLimiter(baseConfig);
    });

    it('should allow requests under the limit', () => {
      const result = rateLimiter.checkLimit('client1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('should track remaining requests correctly', () => {
      rateLimiter.checkLimit('client1');
      rateLimiter.checkLimit('client1');
      const result = rateLimiter.checkLimit('client1');
      expect(result.remaining).toBe(7); // 10 burst - 3 requests
    });

    it('should track different clients separately', () => {
      rateLimiter.checkLimit('client1');
      rateLimiter.checkLimit('client1');
      // client2 first request
      rateLimiter.checkLimit('client2');
      // client2 second request - remaining should be 8 (10-2=8)
      const result = rateLimiter.checkLimit('client2');
      expect(result.remaining).toBe(8);
    });

    it('should deny requests when limit exceeded', () => {
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkLimit('client1');
      }
      const result = rateLimiter.checkLimit('client1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should include retryAfter when denied', () => {
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkLimit('client1');
      }
      const result = rateLimiter.checkLimit('client1');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should track operation-specific limits', () => {
      const limiterWithOps = new RateLimiter({
        clientRequestsPerMinute: 60,
        clientBurstSize: 10,
        operationLimits: new Map([['image.generate', { requestsPerMinute: 2, burstSize: 1 }]]),
      });

      // First request for image.generate should succeed
      const result1 = limiterWithOps.checkLimit('client1', 'image.generate');
      expect(result1.allowed).toBe(true);

      // Second request should fail due to burst size of 1
      const result2 = limiterWithOps.checkLimit('client1', 'image.generate');
      expect(result2.allowed).toBe(false);
    });

    it('should not apply operation limit if operation not in map', () => {
      const limiterWithOps = new RateLimiter({
        clientRequestsPerMinute: 60,
        clientBurstSize: 10,
        operationLimits: new Map([['image.generate', { requestsPerMinute: 2, burstSize: 1 }]]),
      });

      // Requests for other operations should use client bucket
      limiterWithOps.checkLimit('client1', 'video.generate');
      limiterWithOps.checkLimit('client1', 'video.generate');
      limiterWithOps.checkLimit('client1', 'video.generate');
      const result = limiterWithOps.checkLimit('client1', 'video.generate');
      expect(result.allowed).toBe(true); // Still has burst remaining
    });
  });

  describe('checkLimit with global limit', () => {
    it('should deny when global limit exceeded', () => {
      const limiter = new RateLimiter({
        clientRequestsPerMinute: 60,
        clientBurstSize: 10,
        globalRequestsPerSecond: 5,
      });

      for (let i = 0; i < 5; i++) {
        const result = limiter.checkLimit('client1');
        expect(result.allowed).toBe(true);
      }

      const denied = limiter.checkLimit('client2');
      expect(denied.allowed).toBe(false);
    });
  });

  describe('getHeaders', () => {
    it('should return correct rate limit headers', () => {
      const result = rateLimiter.checkLimit('client1');
      const headers = rateLimiter.getHeaders(result);

      expect(headers['X-RateLimit-Limit']).toBe('60');
      expect(headers['X-RateLimit-Remaining']).toBe('9');
      expect(headers['X-RateLimit-Reset']).toBeDefined();
    });

    it('should include Retry-After when present', () => {
      const limiter = new RateLimiter({
        clientRequestsPerMinute: 1,
        clientBurstSize: 1,
      });

      limiter.checkLimit('client1');
      const denied = limiter.checkLimit('client1');
      const headers = rateLimiter.getHeaders(denied);

      expect(headers['Retry-After']).toBeDefined();
    });
  });

  describe('createRateLimiter', () => {
    it('should create a RateLimiter instance', () => {
      const limiter = createRateLimiter(baseConfig);
      expect(limiter).toBeInstanceOf(RateLimiter);
    });
  });

  describe('token bucket refill', () => {
    it('should refill tokens over time', async () => {
      const limiter = new RateLimiter({
        clientRequestsPerMinute: 60,
        clientBurstSize: 2, // 1 per second refill rate
      });

      // Use up burst
      limiter.checkLimit('client1');
      limiter.checkLimit('client1');

      // Should be denied
      expect(limiter.checkLimit('client1').allowed).toBe(false);

      // Wait for token to refill (slightly more than 1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be allowed again
      const result = limiter.checkLimit('client1');
      expect(result.allowed).toBe(true);
    });
  });
});
