# @reaatech/media-pipeline-mcp-observability

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-observability.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-observability)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Observability layer providing OpenTelemetry tracing with auto-instrumentation, Prometheus-compatible metrics (histograms, counters, gauges), structured JSON logging with Pino-compatible output, and in-memory cost reporting with aggregation by pipeline, operation, and provider. Everything is bundled behind a single `ObservabilityService` facade with configurable OTLP export and graceful shutdown.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-observability
# or
pnpm add @reaatech/media-pipeline-mcp-observability
```

## Feature Overview

- **OpenTelemetry tracing** — NodeSDK with auto-instrumentations, OTLP trace export, span lifecycle helpers (`startPipelineSpan`, `startOperationSpan`, `withSpan`), attribute enrichment, and error recording
- **Prometheus-compatible metrics** — 7 metric instruments (histograms, counters, gauges) with dimensional labels for operation/provider/pipeline/quality gate type
- **Structured JSON logging** — configurable log levels (debug, info, warn, error), contextual fields (pipelineId, stepId, traceId, operation, provider, artifactId, costUsd, durationMs), and error stack capture
- **Cost reporting** — in-memory cost accumulation with breakdowns by pipeline, operation, and provider; sorted history with limit
- **Single `ObservabilityService` facade** — wires `TracerService`, `MetricsService`, `StructuredLogger`, and `CostReporter` together with consistent `ObservabilityConfig`
- **OTLP export** — traces and metrics exported to any OTLP-compatible collector (Jaeger, Grafana Tempo, Honeycomb, etc.) via HTTP protobuf
- **Graceful shutdown** — `shutdown()` flushes pending spans and metrics exports
- **Resource attributes** — service name and version set as OpenTelemetry `SemanticResourceAttributes`

## Quick Start

```typescript
import { createObservabilityService } from "@reaatech/media-pipeline-mcp-observability";

const obs = createObservabilityService({
  serviceName: "media-pipeline-mcp",
  serviceVersion: "0.3.0",
  otlpEndpoint: "http://localhost:4318",
  logLevel: "info",
});

// Start a traced span for an operation
const span = obs.tracer.startOperationSpan("image.generate", "stability", "artifact-123");
obs.tracer.setSpanAttributes(span, { "media.cost_usd": 0.007, "media.duration_ms": 1500 });

try {
  await generateImage();
} catch (err) {
  obs.tracer.recordSpanError(span, err as Error);
} finally {
  obs.tracer.endSpan(span);
}

// Record metrics
obs.metrics.recordOperationDuration("image.generate", "stability", 2345);
obs.metrics.recordOperationCost("image.generate", "stability", 0.007);
obs.metrics.recordQualityGatePassRate("dimension-check", 0.95);

// Structured log
obs.logger.info("Image generated successfully", {
  operation: "image.generate",
  provider: "stability",
  artifactId: "artifact-123",
  costUsd: 0.007,
  durationMs: 2345,
});

// Track costs
obs.costs.recordCost({
  pipelineId: "pipeline-123",
  operation: "image.generate",
  provider: "stability",
  costUsd: 0.007,
});

const summary = obs.costs.getSummary();
console.log(summary.totalCostUsd);     // 0.007
console.log(summary.byProvider);       // Map { "stability" => 0.007 }

// On shutdown
process.on("SIGTERM", async () => {
  await obs.shutdown();
  process.exit(0);
});
```

## API Reference

### `ObservabilityService`

Unified observability facade combining all services.

```typescript
class ObservabilityService {
  readonly tracer: TracerService;
  readonly metrics: MetricsService;
  readonly logger: StructuredLogger;
  readonly costs: CostReporter;

  constructor(config: ObservabilityConfig);
  shutdown(): Promise<void>;
}

function createObservabilityService(config: ObservabilityConfig): ObservabilityService;
```

#### `ObservabilityConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `serviceName` | `string` | **required** | OpenTelemetry service name |
| `serviceVersion` | `string` | **required** | Service version for resource attributes |
| `otlpEndpoint` | `string` | — | OTLP collector HTTP endpoint (traces → `/v1/traces`, metrics → `/v1/metrics`) |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Minimum log level |

### `TracerService`

OpenTelemetry tracing with span lifecycle management.

```typescript
class TracerService {
  startPipelineSpan(pipelineId: string): Span;
  startOperationSpan(operation: string, provider?: string, artifactId?: string): Span;
  setSpanAttributes(span: Span, attributes: Record<string, string | number | boolean>): void;
  recordSpanError(span: Span, error: Error): void;
  endSpan(span: Span): void;
  withSpan<T>(span: Span, fn: () => T): T;
  shutdown(): Promise<void>;
}
```

#### Spans Created

| Span Name | Context | Attributes |
|-----------|---------|------------|
| `media.pipeline` | Pipeline execution lifecycle | `media.pipeline_id` |
| `media.pipeline.step` | Individual step execution | `media.operation`, `media.provider`, `media.pipeline_id`, `media.step_id`, `media.artifact_id`, `media.cost_usd`, `media.duration_ms` |
| `media.{operation}` | Operation (e.g. `media.image.generate`) | Same as step, operation-specific |

#### Standard Span Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `media.operation` | `string` | Operation name (e.g. `image.generate`) |
| `media.provider` | `string` | Provider (e.g. `stability`, `openai`) |
| `media.pipeline_id` | `string` | Pipeline identifier |
| `media.step_id` | `string` | Step identifier within pipeline |
| `media.artifact_id` | `string` | Output artifact identifier |
| `media.cost_usd` | `number` | Operation cost in USD |
| `media.duration_ms` | `number` | Operation duration in milliseconds |

### `MetricsService`

Prometheus-compatible metrics via OpenTelemetry SDK.

```typescript
class MetricsService {
  recordOperationDuration(operation: string, provider: string, durationMs: number): void;
  recordOperationCost(operation: string, provider: string, costUsd: number): void;
  recordPipelineDuration(pipelineId: string, durationMs: number): void;
  incrementPipelineSteps(pipelineId: string, count?: number): void;
  recordQualityGatePassRate(gateType: string, passRate: number): void;
  incrementQualityGateRetries(gateType: string, count?: number): void;
  recordProviderErrorRate(provider: string, operation: string, errorRate: number): void;
  shutdown(): Promise<void>;
}
```

#### Metric Instruments

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `media.operation.duration_ms` | **Histogram** | `media.operation`, `media.provider` | Operation latency in milliseconds |
| `media.operation.cost_usd` | **Histogram** | `media.operation`, `media.provider` | Cost per operation call in USD |
| `media.pipeline.duration_ms` | **Histogram** | `media.pipeline_id` | End-to-end pipeline execution time |
| `media.pipeline.steps_total` | **Counter** | `media.pipeline_id` | Total number of pipeline steps executed |
| `media.quality_gate.pass_rate` | **Gauge** | `media.quality_gate_type` | Quality gate pass rate by type |
| `media.quality_gate.retry_count` | **Counter** | `media.quality_gate_type` | Number of quality gate retries |
| `media.provider.error_rate` | **Gauge** | `media.provider`, `media.operation` | Provider error rate by provider and operation |

### `StructuredLogger`

JSON-formatted structured logging with contextual fields and log level filtering.

```typescript
class StructuredLogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;

  logOperation(operation: string, provider: string, artifactId: string, costUsd: number, durationMs: number, context?: LogContext): void;
  logPipelineStep(pipelineId: string, stepId: string, operation: string, status: "start" | "complete" | "failed" | "gated", context?: LogContext): void;
}
```

#### `LogContext`

```typescript
interface LogContext {
  pipelineId?: string;
  stepId?: string;
  traceId?: string;
  operation?: string;
  provider?: string;
  artifactId?: string;
  costUsd?: number;
  durationMs?: number;
  [key: string]: unknown;   // Extensible
}
```

#### Log Output Format

Each log entry is serialized as a single-line JSON object:

```json
{
  "timestamp": "2026-04-15T23:00:00.000Z",
  "service": "media-pipeline-mcp",
  "level": "info",
  "message": "Step completed successfully",
  "pipelineId": "pipeline-123",
  "stepId": "generate",
  "operation": "image.generate",
  "provider": "stability",
  "artifactId": "artifact-456",
  "costUsd": 0.007,
  "durationMs": 2345
}
```

### `CostReporter`

In-memory cost accumulation with breakdowns and history.

```typescript
class CostReporter {
  recordCost(entry: Omit<CostEntry, "timestamp">): void;
  getSummary(): CostSummary;
  getPipelineCost(pipelineId: string): number;
  getOperationCost(operation: string): number;
  getProviderCost(provider: string): number;
  getCostHistory(limit?: number): CostEntry[];
  reset(): void;
}
```

#### `CostEntry`

```typescript
interface CostEntry {
  pipelineId?: string;
  stepId?: string;
  operation: string;
  provider: string;
  costUsd: number;
  timestamp: Date;
  artifactId?: string;
}
```

#### `CostSummary`

```typescript
interface CostSummary {
  totalCostUsd: number;
  byPipeline: Map<string, number>;
  byOperation: Map<string, number>;
  byProvider: Map<string, number>;
  lastUpdated: Date;
}
```

## Usage Patterns

### Full Pipeline Observability with Traced Spans

```typescript
import { createObservabilityService } from "@reaatech/media-pipeline-mcp-observability";

const obs = createObservabilityService({
  serviceName: "media-pipeline-mcp",
  serviceVersion: "1.0.0",
  otlpEndpoint: "http://otel-collector:4318",
});

async function executePipeline(pipelineId: string, steps: Array<{ id: string; operation: string; provider: string }>) {
  const start = Date.now();

  // Top-level pipeline span
  const pipelineSpan = obs.tracer.startPipelineSpan(pipelineId);

  for (const step of steps) {
    // Per-step span
    const stepSpan = obs.tracer.startOperationSpan(step.operation, step.provider);
    obs.tracer.setSpanAttributes(stepSpan, {
      "media.pipeline_id": pipelineId,
      "media.step_id": step.id,
    });

    const stepStart = Date.now();
    try {
      // ... execute step ...
      const duration = Date.now() - stepStart;
      const cost = 0.007;

      obs.tracer.setSpanAttributes(stepSpan, {
        "media.duration_ms": duration,
        "media.cost_usd": cost,
        "media.artifact_id": "artifact-123",
      });

      obs.metrics.recordOperationDuration(step.operation, step.provider, duration);
      obs.metrics.recordOperationCost(step.operation, step.provider, cost);
      obs.costs.recordCost({
        pipelineId,
        stepId: step.id,
        operation: step.operation,
        provider: step.provider,
        costUsd: cost,
      });

      obs.logger.logOperation(step.operation, step.provider, "artifact-123", cost, duration, {
        pipelineId,
        stepId: step.id,
      });

    } catch (err) {
      obs.tracer.recordSpanError(stepSpan, err as Error);
      obs.metrics.recordProviderErrorRate(step.provider, step.operation, 1);
      obs.logger.error(`Step ${step.id} failed`, err as Error, { pipelineId, stepId: step.id });
      throw err;
    } finally {
      obs.tracer.endSpan(stepSpan);
      obs.metrics.incrementPipelineSteps(pipelineId);
    }
  }

  obs.metrics.recordPipelineDuration(pipelineId, Date.now() - start);
  obs.tracer.endSpan(pipelineSpan);
}
```

### Quality Gate Observability

```typescript
async function evaluateQualityGate(gateType: string, passed: boolean, retries: number) {
  obs.metrics.recordQualityGatePassRate(gateType, passed ? 1 : 0);
  for (let i = 0; i < retries; i++) {
    obs.metrics.incrementQualityGateRetries(gateType);
  }
  obs.logger.info(`Gate ${gateType} evaluated`, {
    qualityGateType: gateType,
    passed,
    retries,
  });
}
```

### Cost Reporting Dashboard

```typescript
// Periodic cost snapshot (e.g., every minute)
setInterval(() => {
  const summary = obs.costs.getSummary();
  const recent = obs.costs.getCostHistory(10);

  console.log(JSON.stringify({
    totalCost: summary.totalCostUsd.toFixed(4),
    byPipeline: Object.fromEntries(summary.byPipeline),
    byProvider: Object.fromEntries(summary.byProvider),
    byOperation: Object.fromEntries(summary.byOperation),
    recentOperations: recent.map(e => ({
      operation: e.operation,
      provider: e.provider,
      cost: e.costUsd,
      time: e.timestamp.toISOString(),
    })),
  }));
}, 60000);
```

### Graceful Shutdown with Flush

```typescript
let shuttingDown = false;

process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  obs.logger.info("Shutting down observability", {});
  await obs.shutdown();  // Flush pending spans and metrics
  obs.logger.info("Shutdown complete", {});
  process.exit(0);
});

process.on("SIGINT", async () => {
  obs.logger.info("Received SIGINT", {});
  await obs.shutdown();
  process.exit(0);
});
```

### Log Level Filtering

```typescript
// Only errors are emitted
const prodObs = createObservabilityService({
  serviceName: "media-pipeline-mcp",
  serviceVersion: "1.0.0",
  logLevel: "error",
});

// All levels emitted
const devObs = createObservabilityService({
  serviceName: "media-pipeline-mcp",
  serviceVersion: "0.3.0-dev",
  logLevel: "debug",
});

devObs.logger.debug("Cache key computed", { cacheKey: "abc123", provider: "stability" });
devObs.logger.info("Step started", { stepId: "generate" });
devObs.logger.warn("Gate below threshold", { gateType: "dimension-check", score: 0.92 });
devObs.logger.error("Provider call failed", new Error("Connection refused"), { provider: "openai" });
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and events consumed by observability
- [`@reaatech/media-pipeline-mcp-security`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security) — Audit logging (complements structured logging)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
