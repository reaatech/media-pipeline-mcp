import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitBreakerError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('should be instantiated with name', () => {
    const cb = new CircuitBreaker('test-service', { failureThreshold: 3, timeout: 1000 });
    expect(cb).toBeDefined();
    expect(cb.name).toBe('test-service');
  });

  it('should execute function successfully', async () => {
    const cb = new CircuitBreaker('test-service');
    const result = await cb.execute(async () => 'success');
    expect(result).toBe('success');
  });

  it('should throw CircuitBreakerError when circuit is open', async () => {
    const cb = new CircuitBreaker('test-service', { failureThreshold: 1, timeout: 10000 });

    // Force circuit open by causing a failure
    await cb
      .execute(async () => {
        throw new Error('test failure');
      })
      .catch(() => {});

    // Now it should throw CircuitBreakerError
    await expect(cb.execute(async () => 'success')).rejects.toThrow(CircuitBreakerError);
  });
});
