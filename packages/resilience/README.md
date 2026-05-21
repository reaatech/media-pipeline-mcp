# @reaatech/media-pipeline-mcp-resilience

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-resilience.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-resilience)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

High availability and resilience patterns for media pipeline operations. Provides a three-state circuit breaker for protecting downstream providers from cascading failures, and a retry policy with exponential backoff and jitter for transient error recovery.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-resilience
# or
pnpm add @reaatech/media-pipeline-mcp-resilience
```

## Feature Overview

- **Circuit breaker** — three-state machine (closed, open, half-open) with configurable failure/success thresholds, monitoring window, and half-open concurrency protection
- **Retry with exponential backoff** — configurable initial delay, backoff multiplier, max delay cap, and jitter for staggered recovery
- **Retryable error detection** — filter by error `name`, `code`, or message pattern (defaults: `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `TimeoutError`)
- **Typed error classes** — `CircuitBreakerError` with `retryAfter` ms and `MaxRetriesExceededError` with attempt count and cause chaining
- **Stats reporting** — live `CircuitBreakerStats` with state, failure/success counts, timestamps
- **Retry listeners** — subscribe to retry events for logging and observability
- **Manual control** — `reset()`, `forceOpen()` for operational overrides
- **Factory functions** — `createCircuitBreaker(name, config)` and `createRetryPolicy(config)` for concise construction

## Quick Start

```typescript
import {
  createCircuitBreaker,
  createRetryPolicy,
} from "@reaatech/media-pipeline-mcp-resilience";

// Circuit breaker protecting an external API
const breaker = createCircuitBreaker("stability-api", {
  failureThreshold: 5,
  successThreshold: 3,
  timeout: 30000,
});

const result = await breaker.execute(async () => {
  const response = await fetch("https://api.provider.com/generate");
  if (!response.ok) throw new Error("Provider error");
  return response.json();
});

// Retry with exponential backoff
const retry = createRetryPolicy({
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
});

// Combine circuit breaker + retry for robust calls
const data = await breaker.execute(async () => {
  return retry.execute(async () => {
    return await callUnreliableService();
  });
});
```

## API Reference

### `CircuitBreaker`

Three-state circuit breaker protecting external dependencies from cascading failures.

```typescript
class CircuitBreaker {
  constructor(name: string, config?: Partial<CircuitBreakerConfig>);

  execute<T>(fn: () => Promise<T>): Promise<T>;
  reset(): void;         // Force-close the circuit
  forceOpen(): void;     // Force-open the circuit
  getStats(): CircuitBreakerStats;
}
```

#### `CircuitBreakerConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `failureThreshold` | `number` | `5` | Consecutive failures to open the circuit |
| `successThreshold` | `number` | `3` | Successful requests needed in half-open to close |
| `timeout` | `number` | `60000` | Time in ms before attempting half-open transition |
| `monitoringWindow` | `number` | `60000` | Time window for counting failures |

#### State Machine

```
                                successThreshold met
  CLOSED ──(failureThreshold)──▶ OPEN ──(timeout elapsed)──▶ HALF-OPEN ──▶ CLOSED
                                                                  │
                                                                  └──(failureThreshold)──▶ OPEN
```

- **CLOSED**: Normal operation. Failures count toward threshold. Successes reset the counter.
- **OPEN**: All requests rejected immediately with `CircuitBreakerError`. Transitions to HALF-OPEN after `timeout` ms.
- **HALF-OPEN**: Limited probe requests allowed. Successes count toward `successThreshold` → CLOSE. Failures count toward `failureThreshold` → OPEN. Only one probe in-flight at a time.

#### `CircuitBreakerStats`

```typescript
interface CircuitBreakerStats {
  state: CircuitState;           // "closed" | "open" | "half-open"
  failures: number;
  successes: number;
  lastFailureTime?: number;      // Unix ms
  lastSuccessTime?: number;      // Unix ms
  openedAt?: number;              // Unix ms (when circuit opened)
}
```

### `CircuitBreakerError`

Thrown when a request is rejected because the circuit is open.

```typescript
class CircuitBreakerError extends Error {
  readonly cause?: Error;
  readonly retryAfter?: number;  // Suggested wait time in ms
}
```

### `RetryPolicy`

Retries transient failures with exponential backoff and optional jitter.

```typescript
class RetryPolicy {
  constructor(config?: Partial<RetryPolicyConfig>);

  execute<T>(fn: () => Promise<T>): Promise<T>;
  onRetry(listener: RetryListener): void;
}
```

#### `RetryPolicyConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum execution attempts (including initial) |
| `initialDelayMs` | `number` | `1000` | Delay before first retry |
| `maxDelayMs` | `number` | `30000` | Maximum delay cap |
| `backoffMultiplier` | `number` | `2` | Exponential backoff multiplier |
| `jitter` | `boolean` | `true` | Add ±25% random jitter to delay |
| `retryableErrors` | `string[]` | `["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "TimeoutError"]` | Error names/codes/messages that trigger retry |

#### Delay Calculation

```
delay = min(initialDelay × multiplier^(attempt-1) × [0.75…1.25], maxDelay)
```

#### `RetryContext`

Passed to retry listeners on each retry.

```typescript
interface RetryContext {
  attempt: number;         // Current attempt number (0-indexed)
  maxAttempts: number;     // Total configured attempts
  delay: number;           // Delay before next attempt in ms
  lastError?: Error;       // Error that triggered this retry
}

type RetryListener = (context: RetryContext) => void;
```

### `MaxRetriesExceededError`

Thrown when all retry attempts are exhausted.

```typescript
class MaxRetriesExceededError extends Error {
  readonly cause?: Error;        // The last error encountered
  readonly attempts: number;     // Total attempts made
}
```

### Factory Functions

```typescript
function createCircuitBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker;
function createRetryPolicy(config?: Partial<RetryPolicyConfig>): RetryPolicy;
```

## Usage Patterns

### Circuit Breaker + Retry Combo (Recommended)

```typescript
const breaker = createCircuitBreaker("provider-api", {
  failureThreshold: 3,
  timeout: 60000,
});

const retry = createRetryPolicy({
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitter: true,
});

async function robustProviderCall() {
  return breaker.execute(async () => {
    return retry.execute(async () => {
      return await callProviderApi();
    });
  });
}
```

### Retry Listener for Observability

```typescript
const retry = createRetryPolicy({ maxAttempts: 3, initialDelayMs: 1000 });

retry.onRetry(({ attempt, delay, lastError }) => {
  logger.warn(`Retry ${attempt + 1} after ${delay}ms: ${lastError?.message}`, {
    attempt,
    delayMs: delay,
    error: lastError?.message,
  });
});

await retry.execute(() => callService());
```

### Custom Retryable Errors

```typescript
const retry = createRetryPolicy({
  maxAttempts: 5,
  initialDelayMs: 2000,
  retryableErrors: [
    "ECONNREFUSED",         // Connection refused
    "ETIMEDOUT",            // Timeout
    "TooManyRequestsError",  // 429 rate limit
    "*rate limit*",          // Wildcard message match
  ],
});
```

### Circuit Breaker State Monitoring

```typescript
const breaker = createCircuitBreaker("critical-api", { failureThreshold: 5 });

setInterval(() => {
  const stats = breaker.getStats();
  metrics.gauge("circuit_breaker.state", stats.state === "closed" ? 1 : stats.state === "half-open" ? 0.5 : 0);
  metrics.gauge("circuit_breaker.failures", stats.failures);
  // Alert if circuit stays open > 5 minutes
  if (stats.openedAt && Date.now() - stats.openedAt > 300000) {
    alertOnCall("Circuit breaker open > 5min");
  }
}, 10000);
```

### Manual Circuit Control for Maintenance

```typescript
const breaker = createCircuitBreaker("maintenance-api");

// Before maintenance: force open to shed load
breaker.forceOpen();

// After maintenance: reset circuit
breaker.reset();
```

### Check Circuit State Before Call (with Fallback)

```typescript
const breaker = createCircuitBreaker("provider-api", { failureThreshold: 3 });

async function safeCall() {
  const stats = breaker.getStats();
  if (stats.state === "open") {
    logger.warn("Circuit open — using cached/fallback response");
    return getCachedResponse();
  }
  return breaker.execute(() => callProvider());
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types, uses resilience patterns in provider calls
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — MediaProvider base class with built-in retry

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
