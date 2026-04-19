/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by failing fast when a provider is unhealthy.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening
  successThreshold: number; // Number of successes to close from half-open
  timeout: number; // Time in ms before attempting reset (open -> half-open)
  monitoringWindow: number; // Time window for counting failures
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  openedAt?: number;
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private openedAt?: number;
  private halfOpenInProgress = false;

  constructor(
    public readonly name: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 3,
      timeout: config.timeout ?? 60000,
      monitoringWindow: config.monitoringWindow ?? 60000,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldAttemptReset()) {
        if (this.halfOpenInProgress) {
          const retryAfter = this.config.timeout - (Date.now() - (this.openedAt || Date.now()));
          throw new CircuitBreakerError(
            `Circuit breaker '${this.name}' is open (half-open probe in progress)`,
            undefined,
            retryAfter
          );
        }
        this.state = 'half-open';
        this.halfOpenInProgress = true;
        this.successes = 0;
      } else {
        const retryAfter = this.config.timeout - (Date.now() - (this.openedAt || Date.now()));
        throw new CircuitBreakerError(
          `Circuit breaker '${this.name}' is open`,
          undefined,
          retryAfter
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.halfOpenInProgress = false;
    }
  }

  /**
   * Record a successful call
   */
  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();

    if (this.state === 'half-open') {
      if (this.successes >= this.config.successThreshold) {
        this.close();
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  /**
   * Record a failed call
   */
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.open();
    } else if (this.state === 'closed') {
      // Check if we should open the circuit
      if (this.failures >= this.config.failureThreshold) {
        this.open();
      }
    }
  }

  /**
   * Check if we should attempt to reset the circuit
   */
  private shouldAttemptReset(): boolean {
    if (!this.openedAt) return true;
    return Date.now() - this.openedAt >= this.config.timeout;
  }

  /**
   * Open the circuit (fail fast)
   */
  private open(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.successes = 0;
    console.warn(`Circuit breaker '${this.name}' opened after ${this.failures} failures`);
  }

  /**
   * Close the circuit (normal operation)
   */
  private close(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = undefined;
    console.info(`Circuit breaker '${this.name}' closed`);
  }

  /**
   * Get current state and statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      openedAt: this.openedAt,
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.close();
  }

  /**
   * Force open the circuit breaker
   */
  forceOpen(): void {
    this.open();
  }
}

export function createCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(name, config);
}
