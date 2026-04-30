/**
 * Rate Limiter
 *
 * Implements:
 * - Per-client rate limiting
 * - Per-operation rate limiting
 * - Token bucket algorithm
 */

export interface RateLimitConfig {
  // Per-client limits
  clientRequestsPerMinute: number;
  clientBurstSize: number;

  // Per-operation limits
  operationLimits?: Map<string, { requestsPerMinute: number; burstSize: number }>;

  // Global limits
  globalRequestsPerSecond?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number; // tokens per second
}

interface ClientBucket {
  global: TokenBucket;
  operations: Map<string, TokenBucket>;
}

export class RateLimiter {
  private config: RateLimitConfig;
  private clients: Map<string, ClientBucket> = new Map();
  private globalBucket?: TokenBucket;

  constructor(config: RateLimitConfig) {
    this.config = config;

    if (config.globalRequestsPerSecond) {
      this.globalBucket = {
        tokens: config.globalRequestsPerSecond,
        lastRefill: Date.now(),
        capacity: config.globalRequestsPerSecond,
        refillRate: config.globalRequestsPerSecond,
      };
    }
  }

  /**
   * Check if request is allowed
   */
  checkLimit(clientId: string, operation?: string): RateLimitResult {
    const now = Date.now();

    // Check global limit first
    if (this.globalBucket) {
      const globalResult = this.consumeToken(this.globalBucket, 1, now);
      if (!globalResult.allowed) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: now + 1000,
          retryAfter: globalResult.retryAfter,
        };
      }
    }

    // Get or create client bucket
    let client = this.clients.get(clientId);
    if (!client) {
      client = this.createClientBucket();
      this.clients.set(clientId, client);
    }

    // Check client global limit
    const clientResult = this.consumeToken(client.global, 1, now);
    if (!clientResult.allowed) {
      return {
        allowed: false,
        remaining: Math.floor(client.global.tokens),
        resetAt: now + 60000,
        retryAfter: clientResult.retryAfter,
      };
    }

    // Check operation-specific limit
    if (operation && this.config.operationLimits?.has(operation)) {
      const opLimit = this.config.operationLimits.get(operation)!;
      let opBucket = client.operations.get(operation);

      if (!opBucket) {
        opBucket = {
          tokens: opLimit.burstSize,
          lastRefill: now,
          capacity: opLimit.burstSize,
          refillRate: opLimit.requestsPerMinute / 60,
        };
        client.operations.set(operation, opBucket);
      }

      const opResult = this.consumeToken(opBucket, 1, now);
      if (!opResult.allowed) {
        return {
          allowed: false,
          remaining: Math.floor(opBucket.tokens),
          resetAt: now + 60000,
          retryAfter: opResult.retryAfter,
        };
      }
    }

    return {
      allowed: true,
      remaining: Math.floor(client.global.tokens),
      resetAt: now + 60000,
    };
  }

  /**
   * Consume token from bucket
   */
  private consumeToken(
    bucket: TokenBucket,
    tokens: number,
    now: number,
  ): { allowed: boolean; retryAfter?: number } {
    // Refill bucket
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true };
    }

    // Calculate retry after
    const tokensNeeded = tokens - bucket.tokens;
    const retryAfter = Math.ceil((tokensNeeded / bucket.refillRate) * 1000);

    return { allowed: false, retryAfter };
  }

  /**
   * Create new client bucket
   */
  private createClientBucket(): ClientBucket {
    return {
      global: {
        tokens: this.config.clientBurstSize,
        lastRefill: Date.now(),
        capacity: this.config.clientBurstSize,
        refillRate: this.config.clientRequestsPerMinute / 60,
      },
      operations: new Map(),
    };
  }

  /**
   * Clean up old client buckets
   */
  cleanup(maxAge = 3600000): void {
    const now = Date.now();
    for (const [clientId, bucket] of this.clients.entries()) {
      if (now - bucket.global.lastRefill > maxAge) {
        this.clients.delete(clientId);
      }
    }
  }

  /**
   * Get rate limit headers for response
   */
  getHeaders(result: RateLimitResult): Record<string, string> {
    return {
      'X-RateLimit-Limit': this.config.clientRequestsPerMinute.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': result.resetAt.toString(),
      ...(result.retryAfter && { 'Retry-After': Math.ceil(result.retryAfter / 1000).toString() }),
    };
  }
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter(config);
}
