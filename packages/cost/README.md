# @reaatech/media-pipeline-mcp-cost

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-cost)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-cost)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Cost ledger for tracking per-operation costs in the media pipeline. Supports USD micro-precision, run-scoped and tenant-scoped queries, and preflight budget checks that prevent pipeline execution before caps are exceeded.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-cost
```

```bash
pnpm add @reaatech/media-pipeline-mcp-cost
```

## Feature Overview

- Per-operation cost recording with typed unit tracking (tokens, seconds, pixels, characters, requests)
- Run-scoped cost aggregation and budget enforcement
- Tenant-scoped queries with time-bounded windows (daily / monthly caps)
- Preflight budget checks that reject operations before they execute
- In-memory ledger implementation suitable for development and single-process deployments
- Configurable cap defaults with per-run and per-tenant overrides

## Quick Start

```typescript
import { InMemoryCostLedger } from '@reaatech/media-pipeline-mcp-cost';
import type { CostEntry } from '@reaatech/media-pipeline-mcp-cost';

const ledger = new InMemoryCostLedger({
  defaultRunCapUsd: 5.0,
  tenantDailyCaps: new Map([['acme', 50.0]]),
});

// Record a charge
await ledger.charge({
  id: 'entry-1',
  runId: 'run-42',
  tenantId: 'acme',
  stepId: 'gen',
  provider: 'openai',
  operation: 'image.describe',
  modelId: 'gpt-4o-mini',
  inputUnits: 256,
  outputUnits: 128,
  inputUnitType: 'tokens',
  outputUnitType: 'tokens',
  usd: 0.0012,
  at: new Date().toISOString(),
});

// Preflight check before executing an expensive step
const result = await ledger.preflight(
  {
    provider: 'stability',
    operation: 'image.generate',
    modelId: 'sd3-large',
    inputUnits: 1,
    outputUnitsLow: 1,
    outputUnitsHigh: 1,
    usdLow: 0.02,
    usdHigh: 0.04,
  },
  { type: 'run', runId: 'run-42' },
);

if (!result.allowed) {
  console.error(`Rejected: ${result.reason}`);
  // result.currentSpentUsd / result.capUsd / result.remainingUsd available
}

// Query totals
const spent = await ledger.totalForRun('run-42');
const tenantSpent = await ledger.totalForTenant('acme', {
  start: new Date(Date.now() - 86400000).toISOString(),
  end: new Date().toISOString(),
});
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `CostEntry` | Individual cost record: run ID, tenant, provider, operation, model, input/output units, USD amount |
| `CostEstimate` | Preflight estimate: provider, operation, unit range, USD low/high bound |
| `TimeWindow` | ISO 8601–bounded window (`start`/`end`, with `since`/`until` spec-compat aliases) |
| `CostScope` | Discriminated union — scoped by `{ type: 'run', runId }` or `{ type: 'tenant', tenantId, timeWindow }` |
| `PreflightResult` | Budget check outcome: `allowed`, `currentSpentUsd`, `requestEstimateUsd`, `capUsd`, `remainingUsd`, `reason` |
| `CostLedger` | Interface: `charge()`, `preflight()`, `totalForRun()`, `totalForTenant()`, `listEntries()` |

### Classes

| Class | Description |
|-------|-------------|
| `InMemoryCostLedger` | In-process cost ledger with configurable per-run and per-tenant caps |

**`InMemoryCostLedger` constructor options (`InMemoryCostLedgerConfig`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultRunCapUsd` | `number` | `0` | Default USD cap for any run without a specific override |
| `runCaps` | `Map<string, number>` | `new Map()` | Per-run cap overrides keyed by `runId` |
| `tenantDailyCaps` | `Map<string, number>` | `new Map()` | Per-tenant daily USD caps |
| `tenantMonthlyCaps` | `Map<string, number>` | `new Map()` | Per-tenant monthly USD caps |

## Usage Patterns

### Budget-Gated Pipeline Execution

Every pipeline step should call `preflight()` before dispatching work. If `allowed` is `false`, halt the pipeline and surface the `reason` to the caller:

```typescript
async function executeStep(step: Step, scope: CostScope) {
  const estimate: CostEstimate = {
    provider: step.provider,
    operation: step.operation,
    modelId: step.model,
    inputUnits: step.estimatedInputUnits,
    outputUnitsLow: step.estimatedOutputUnitsLow,
    outputUnitsHigh: step.estimatedOutputUnitsHigh,
    usdLow: step.usdLow,
    usdHigh: step.usdHigh,
  };

  const check = await ledger.preflight(estimate, scope);
  if (!check.allowed) {
    return { status: 'blocked', reason: check.reason };
  }

  const output = await dispatchToProvider(step);
  await ledger.charge(/* cost entry from provider response */);
  return output;
}
```

### Tenant Audit

```typescript
const entries = await ledger.listEntries({
  type: 'tenant',
  tenantId: 'acme',
  timeWindow: {
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-31T23:59:59Z',
  },
});

const total = entries.reduce((sum, e) => sum + e.usd, 0);
console.log(`Tenant acme spent $${total.toFixed(4)} in January`);
```

## Related Packages

- [@reaatech/media-pipeline-mcp-core](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core business logic and shared error types
- [@reaatech/media-pipeline-mcp](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Full MCP server with pipeline orchestration

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
