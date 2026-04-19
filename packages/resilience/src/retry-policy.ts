/**
 * Retry Policy with Exponential Backoff and Jitter
 *
 * Implements resilient retry logic for transient failures.
 */

export interface RetryPolicyConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors?: string[]; // Error names to retry
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  delay: number;
  lastError?: Error;
}

export type RetryListener = (context: RetryContext) => void;

export class MaxRetriesExceededError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly attempts = 0
  ) {
    super(message);
    this.name = 'MaxRetriesExceededError';
  }
}

export class RetryPolicy {
  private config: RetryPolicyConfig;
  private listeners: RetryListener[] = [];

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      initialDelayMs: config.initialDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      jitter: config.jitter ?? true,
      retryableErrors: config.retryableErrors ?? [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'TimeoutError',
      ],
    };
  }

  /**
   * Execute function with retry policy
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (!this.isRetryableError(lastError)) {
          throw error;
        }

        if (attempt < this.config.maxAttempts) {
          const delay = this.calculateDelay(attempt);
          const context: RetryContext = {
            attempt,
            maxAttempts: this.config.maxAttempts,
            delay,
            lastError,
          };

          this.notifyListeners(context);

          await this.sleep(delay);
        }
      }
    }

    throw new MaxRetriesExceededError(
      `Failed after ${this.config.maxAttempts} attempts`,
      lastError,
      this.config.maxAttempts
    );
  }

  private calculateDelay(attempt: number): number {
    const baseDelay =
      this.config.initialDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    let delay = baseDelay;

    if (this.config.jitter) {
      delay = baseDelay * (0.75 + Math.random() * 0.5);
    }

    return Math.min(delay, this.config.maxDelayMs);
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    if (!this.config.retryableErrors || this.config.retryableErrors.length === 0) {
      return true;
    }

    const errorAny = error as Error & { code?: string };
    return (
      this.config.retryableErrors.includes(error.name) ||
      this.config.retryableErrors.includes(errorAny.code || '') ||
      this.config.retryableErrors.some((msg) => error.message.includes(msg))
    );
  }

  /**
   * Sleep for specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Add retry listener
   */
  onRetry(listener: RetryListener): void {
    this.listeners.push(listener);
  }

  /**
   * Notify listeners of retry
   */
  private notifyListeners(context: RetryContext): void {
    for (const listener of this.listeners) {
      try {
        listener(context);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

export function createRetryPolicy(config?: Partial<RetryPolicyConfig>): RetryPolicy {
  return new RetryPolicy(config);
}
