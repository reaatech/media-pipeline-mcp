# @reaatech/media-pipeline-mcp-persistence

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-persistence)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-persistence)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Pipeline state store abstractions with in-memory and Redis implementations. Provides optimistic locking, run lifecycle management, event log persistence, and tenant-scoped queries for multi-tenant pipeline orchestration.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-persistence
```

```bash
pnpm add @reaatech/media-pipeline-mcp-persistence
```

The Redis backend requires the optional `ioredis` peer dependency:

```bash
pnpm add ioredis
```

## Feature Overview

- In-memory store for development and single-process deployments
- Redis-backed store with TTL-managed keys, per-tenant zset indexes, and external job ID mappings
- Optimistic locking with expected-version conflict detection (`update(runId, patch, expectedVersion)`)
- Exclusive write lock via `withLock()` — in-memory mutex for single-process, `SET NX EX` for Redis
- Canonical event taxonomy with 12 event types tracking the full run lifecycle
- Run filtering by status, tenant, idempotency key, and time window
- Idempotency key deduplication preventing duplicate run creation
- External job ID lookup for webhook-based provider integrations

## Quick Start

```typescript
import { InMemoryPipelineStateStore } from '@reaatech/media-pipeline-mcp-persistence';

const store = new InMemoryPipelineStateStore();

// Create a pipeline run
await store.create({
  runId: 'run-42',
  pipelineId: 'product-photo',
  status: 'pending',
  tenantId: 'acme',
  pipelineDefHash: 'sha256-abc123',
  currentStepIndex: 0,
  steps: [
    {
      stepId: 'gen',
      operation: 'image.generate',
      inputs: { prompt: 'A product photo of a sneaker' },
      status: 'pending',
      attempts: 0,
      maxRetries: 2,
      artifactIds: [],
      costUsd: 0,
    },
  ],
  events: [],
  externalJobIds: {},
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Append events as the run progresses
await store.appendEvent('run-42', {
  kind: 'run-started',
  runId: 'run-42',
  at: Date.now(),
});
await store.appendEvent('run-42', {
  kind: 'step-started',
  runId: 'run-42',
  stepId: 'gen',
  at: Date.now(),
  attempt: 1,
});
await store.appendEvent('run-42', {
  kind: 'step-completed',
  runId: 'run-42',
  stepId: 'gen',
  at: Date.now(),
  artifactIds: ['artifact-99'],
  costUsd: 0.014,
});
await store.appendEvent('run-42', {
  kind: 'run-completed',
  runId: 'run-42',
  at: Date.now(),
  totalCostUsd: 0.014,
});

// Update with optimistic locking
await store.update(
  'run-42',
  { status: 'completed', completedAt: new Date().toISOString() },
  1, // expectedVersion — fails if another writer updated first
);

// Replay events (for reconnect/resume)
const events = await store.listEvents('run-42', /* sinceSeq */ 0);

// Query runs by tenant
const runs = await store.listRuns({
  tenantId: 'acme',
  status: 'completed',
  since: '2026-01-01T00:00:00Z',
  limit: 10,
  offset: 0,
});

// Cancel a run
await store.cancel('run-42', 'User requested cancellation');
```

### Redis

```typescript
import { Redis } from 'ioredis';
import { RedisPipelineStateStore } from '@reaatech/media-pipeline-mcp-persistence';

const redis = new Redis();
const store = new RedisPipelineStateStore({
  client: redis,
  prefix: 'mp',
  runTtlSeconds: 30 * 86400,   // 30 days
  lockTtlSeconds: 60,           // 60s lock TTL
  idempotencyTtlSeconds: 86400, // 24h
  externalJobTtlSeconds: 7 * 86400, // 7 days
  lockAcquireTimeoutMs: 5000,   // 5s max wait for lock
});

// Locked mutation
const result = await store.withLock('run-42', async (run) => {
  // Safe to mutate — exclusive lock held
  return performCriticalUpdate(run);
}, /* timeoutMs */ 10_000);
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `PipelineRunStatus` | `'pending' \| 'running' \| 'suspended' \| 'completed' \| 'failed' \| 'cancelled'` |
| `StepStatus` | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'gated' \| 'cached' \| 'cancelled'` |
| `StepState` | Per-step state: operation, status, attempts, artifact IDs, cost, error, timestamps, cache key |
| `PipelineRun` | Full run record: status, steps, events, version, timestamps, idempotency key, external job IDs |
| `PipelineEvent` | Discriminated union of 12 event types (`run-created`, `run-started`, `step-started`, `step-progress`, `step-cached`, `step-completed`, `step-failed`, `step-gated`, `run-suspended`, `run-resumed`, `run-completed`, `run-failed`) |
| `RunFilter` | Query filter: status (single or array), tenantId, idempotencyKey, since/until time window, limit/offset |
| `PipelineStateStore` | Interface: `create()`, `get()`, `update()`, `cancel()`, `appendEvent()`, `listEvents()`, `listRuns()`, `findByExternalJobId()`, `withLock()` |

### Classes

| Class | Description |
|-------|-------------|
| `InMemoryPipelineStateStore` | In-process store with Map-based storage and async-mutex locking. Single-process only. |
| `RedisPipelineStateStore` | Redis-backed store with TTL-managed keys, tenant zset indexes, and `SET NX EX` distributed locking. |

**`RedisPipelineStateStoreConfig`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `RedisClientLike` | _(required)_ | ioredis-compatible client |
| `prefix` | `string` | `'mp'` | Redis key namespace |
| `runTtlSeconds` | `number` | `2_592_000` (30d) | TTL for run, events, and tenant index keys |
| `lockTtlSeconds` | `number` | `60` | Lock TTL (SET NX EX) |
| `idempotencyTtlSeconds` | `number` | `86_400` (24h) | Idempotency entry TTL |
| `externalJobTtlSeconds` | `number` | `604_800` (7d) | External job mapping TTL |
| `lockAcquireTimeoutMs` | `number` | `5_000` | Max time to wait for lock acquisition |
| `lockPollIntervalMs` | `number` | `100` | Poll interval during lock acquisition |

### Event Taxonomy

| Event | Description |
|-------|-------------|
| `run-created` | Run initialized with pipeline definition hash |
| `run-started` | Execution has begun |
| `step-started` | Step execution started (includes attempt counter) |
| `step-progress` | In-flight progress with percentage, ETA, accrued cost |
| `step-cached` | Step result retrieved from cache |
| `step-completed` | Step finished successfully with artifact IDs and cost |
| `step-failed` | Step failed with error code and retryability flag |
| `step-gated` | Step blocked by quality gate with gate type and verdict |
| `run-suspended` | Execution suspended (webhook, budget, or gate) with resume token |
| `run-resumed` | Execution resumed from a specific step |
| `run-completed` | Pipeline finished successfully with total cost |
| `run-failed` | Pipeline terminated with error code and terminal reason |

## Usage Patterns

### Optimistic Locking

```typescript
async function atomicStepComplete(runId: string, stepId: string, currentVersion: number) {
  await store.update(runId, {
    steps: updatedSteps,
    currentStepIndex: nextIndex,
  }, currentVersion); // Throws RunInProgressError if version mismatch
}
```

### Idempotent Run Creation

```typescript
async function createIfAbsent(run: PipelineRun) {
  const existing = await store.listRuns({ idempotencyKey: run.idempotencyKey });
  if (existing.length > 0) return existing[0];
  await store.create(run);
  return run;
}
```

### Webhook Callback Resolution

```typescript
// When a provider webhook reports job completion
async function onJobComplete(provider: string, jobId: string, result: unknown) {
  const run = await store.findByExternalJobId(provider, jobId);
  if (!run) return; // Stale / unknown callback
  await store.appendEvent(run.runId, {
    kind: 'step-completed',
    runId: run.runId,
    stepId: currentStep(run).stepId,
    at: Date.now(),
    artifactIds: [result.id],
    costUsd: result.cost,
  });
}
```

## Related Packages

- [@reaatech/media-pipeline-mcp-core](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — `RunNotFoundError`, `RunInProgressError`, `StateStoreUnavailableError`
- [@reaatech/media-pipeline-mcp](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Full MCP server that consumes this store for pipeline orchestration

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
