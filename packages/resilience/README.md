# @reaatech/media-pipeline-mcp-resilience

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-resilience.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-resilience)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

High availability and resilience patterns for media pipeline operations. Provides circuit breaker and retry with exponential backoff — essential for protecting downstream providers from cascading failures.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-resilience
# or
pnpm add @reaatech/media-pipeline-mcp-resilience
```

## Feature Overview

- **Circuit breaker** — three-state machine protecting external providers from overload
- **Retry with backoff** — exponential delay with jitter, max delay cap, and retryable error detection
- **Typed errors** — `CircuitBreakerError` and `MaxRetriesExceededError` with cause chaining
- **Stats reporting** — state, failures, successes, and transition timestamps for monitoring
- **Manual control** — force-open, reset, and half-open concurrency protection

## Quick Start

```typescript
import {
  createCircuitBreaker,
  createRetryPolicy,
} from "@reaatech/media-pipeline-mcp-resilience";

// Circuit breaker protecting an external API
const breaker = createCircuitBreaker({
  failureThreshold: 5,
  openTimeoutMs: 30000,
  successThreshold: 2,
});

const result = await breaker.execute(async () => {
  const response = await fetch("https://api.provider.com/generate");
  if (!response.ok) throw new Error("Provider error");
  return response.json();
});

// Retry with exponential backoff
const retry = createRetryPolicy({
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: true,
});

const data = await retry.execute(async () => {
  return await callUnreliableService();
});
```

## API Reference

### `CircuitBreaker`

```typescript
class CircuitBreaker {
  constructor(config: CircuitBreakerConfig);
  execute<T>(fn: () => Promise<T>): Promise<T>;
  reset(): void;
  forceOpen(): void;
  getStats(): CircuitBreakerStats;
}
```

#### `CircuitBreakerConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `failureThreshold` | `number` | `5` | Consecutive failures to open the circuit |
| `openTimeoutMs` | `number` | `30000` | Time before transitioning to half-open |
| `successThreshold` | `number` | `2` | Successful requests needed in half-open to close |

#### States

```
                                                                 successThreshold met
        ┌──────────┐   failureThreshold reached   ┌───────────┐ ──────────────────▶ ┌──────────┐
        │  CLOSED  │ ──────────────────────────▶  │   OPEN    │                     │  CLOSED  │
        └──────────┘                              └───────────┘ ◀────────────────── └──────────┘
                                                         │     failureThreshold met
                                                         │ openTimeoutMs elapsed
                                                         ▼
                                                  ┌───────────┐
                                                  │ HALF-OPEN │
                                                  └───────────┘
```

#### `CircuitBreakerStats`

```typescript
interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  openedAt: Date | null;
}
```

### `CircuitBreakerError`

Thrown when the circuit is open and a request is rejected.

```typescript
class CircuitBreakerError extends Error {
  readonly code = "CIRCUIT_OPEN";
  constructor(message?: string);
}
```

### `RetryPolicy`

```typescript
class RetryPolicy {
  constructor(config: RetryPolicyConfig);
  execute<T>(fn: (attempt: number) => Promise<T>): Promise<T>;
  onRetry(listener: RetryListener): void;
}
```

#### `RetryPolicyConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum retry attempts |
| `baseDelayMs` | `number` | `1000` | Initial delay before first retry |
| `maxDelayMs` | `number` | `30000` | Maximum delay cap |
| `jitter` | `boolean` | `true` | Add random jitter to delay |
| `retryableErrors` | `{ name?, code?, message? }[]` | — | Errors that trigger retry |

#### `RetryListener`

```typescript
type RetryListener = (context: RetryContext) => void;

interface RetryContext {
  attempt: number;
  error: Error;
  delayMs: number;
}
```

### `MaxRetriesExceededError`

```typescript
class MaxRetriesExceededError extends Error {
  readonly code = "MAX_RETRIES_EXCEEDED";
  readonly attempts: number;
  readonly cause: Error;
}
```

## Usage Patterns

### Circuit Breaker + Retry Combo

```typescript
const breaker = createCircuitBreaker({ failureThreshold: 3, openTimeoutMs: 60000 });
const retry = createRetryPolicy({ maxRetries: 2, baseDelayMs: 500 });

async function robustCall() {
  return breaker.execute(async () => {
    return retry.execute(async () => {
      return await callProviderApi();
    });
  });
}
```

### Retryable Error Detection

```typescript
const retry = createRetryPolicy({
  maxRetries: 3,
  retryableErrors: [
    { code: "ECONNREFUSED" },
    { code: "ETIMEDOUT" },
    { name: "TooManyRequestsError" },
    { message: "*rate limit*" },
  ],
});

retry.onRetry(({ attempt, error, delayMs }) => {
  console.log(`Retry ${attempt} after ${delayMs}ms: ${error.message}`);
});
```

### Check Circuit State Before Call

```typescript
const breaker = createCircuitBreaker({ failureThreshold: 5 });

const stats = breaker.getStats();
if (stats.state === "open") {
  console.log("Circuit open — using fallback");
  return fallbackResponse();
}

const data = await breaker.execute(() => callProvider());
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server that uses resilience patterns

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
