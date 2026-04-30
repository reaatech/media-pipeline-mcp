# @reaatech/media-pipeline-mcp-observability

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-observability.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-observability)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Observability layer providing OpenTelemetry tracing, Prometheus-compatible metrics, structured JSON logging, and cost reporting for media pipeline operations.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-observability
# or
pnpm add @reaatech/media-pipeline-mcp-observability
```

## Feature Overview

- **OpenTelemetry tracing** — auto-instrumentation with pipeline/operation spans, attribute enrichment, OTLP export
- **Prometheus metrics** — histograms for operation duration/cost, pipeline duration, error rates, quality gate pass rates
- **Structured logging** — JSON-formatted with pipeline/step/trace context, Pino-compatible output
- **Cost reporting** — per-pipeline, per-operation, per-provider cost aggregation with history
- **Single service facade** — `ObservabilityService` ties tracing, metrics, logging, and cost reporting together

## Quick Start

```typescript
import { createObservabilityService } from "@reaatech/media-pipeline-mcp-observability";

const obs = createObservabilityService({
  serviceName: "media-pipeline-mcp",
  otlpEndpoint: "http://localhost:4318",
});

// Start a traced span
await obs.tracer.withSpan("media.image.generate", async (span) => {
  span.setAttribute("media.provider", "stability");
  // ... do work ...
});

// Record metrics
obs.metrics.recordOperationDuration("image.generate", "stability", 2345);
obs.metrics.recordOperationCost("image.generate", "stability", 0.007);

// Structured log
obs.logger.info({
  operation: "image.generate",
  provider: "stability",
  artifactId: "artifact-123",
  costUsd: 0.007,
}, "Image generated");
```

## API Reference

### `ObservabilityService`

```typescript
class ObservabilityService {
  readonly tracer: TracerService;
  readonly metrics: MetricsService;
  readonly logger: StructuredLogger;
  readonly costReporter: CostReporter;
  shutdown(): Promise<void>;
}

function createObservabilityService(config?: ObservabilityConfig): ObservabilityService;
```

#### `ObservabilityConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `serviceName` | `string` | `"media-pipeline-mcp"` | OTel service name |
| `otlpEndpoint` | `string` | — | OTLP collector endpoint |
| `logLevel` | `string` | `"info"` | Log level (error/warn/info/debug) |

### `TracerService`

```typescript
class TracerService {
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>;
  getActiveSpan(): Span | undefined;
}
```

Spans created:
- `media.pipeline` — pipeline execution lifecycle
- `media.pipeline.step` — individual step execution
- `media.*` — operation-specific spans (e.g., `media.image.generate`)

Span attributes: `media.operation`, `media.provider`, `media.pipeline_id`, `media.step_id`, `media.artifact_id`, `media.cost_usd`, `media.duration_ms`

### `MetricsService`

```typescript
class MetricsService {
  recordOperationDuration(operation: string, provider: string, durationMs: number): void;
  recordOperationCost(operation: string, provider: string, costUsd: number): void;
  recordPipelineDuration(pipelineId: string, durationMs: number, stepCount: number): void;
  recordPipelineSteps(pipelineId: string, stepCount: number): void;
  recordQualityGatePass(qualityGateType: string, passed: boolean): void;
  recordQualityGateRetry(qualityGateType: string): void;
  recordProviderError(providerId: string): void;
}
```

| Metric | Type | Labels |
|--------|------|--------|
| `media.operation.duration_ms` | Histogram | `operation`, `provider` |
| `media.operation.cost_usd` | Histogram | `operation`, `provider` |
| `media.pipeline.duration_ms` | Histogram | `pipeline_id` |
| `media.pipeline.step_count` | Counter | `pipeline_id` |
| `media.quality_gate.pass_rate` | Gauge | `type` |
| `media.quality_gate.retries` | Counter | `type` |
| `media.provider.error_rate` | Gauge | `provider` |

### `StructuredLogger`

```typescript
class StructuredLogger {
  error(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  debug(context: LogContext, message: string): void;
  logOperation(context: LogContext): void;
  logPipelineStep(context: LogContext): void;
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
  [key: string]: unknown;
}
```

### `CostReporter`

```typescript
class CostReporter {
  record(entry: CostEntry): void;
  getSummary(): CostSummary;
  getHistory(): CostEntry[];
  reset(): void;
}
```

#### `CostEntry`

```typescript
interface CostEntry {
  timestamp: Date;
  pipelineId: string;
  operation: string;
  provider: string;
  costUsd: number;
  artifactId?: string;
}
```

#### `CostSummary`

```typescript
interface CostSummary {
  totalCost: number;
  byPipeline: Record<string, number>;
  byOperation: Record<string, number>;
  byProvider: Record<string, number>;
  count: number;
}
```

## Usage Patterns

### OpenTelemetry Context Propagation

```typescript
const obs = createObservabilityService({ otlpEndpoint: "http://collector:4318" });

async function executePipeline(pipelineId: string) {
  await obs.tracer.withSpan("media.pipeline", async (span) => {
    span.setAttribute("media.pipeline_id", pipelineId);

    await obs.tracer.withSpan("media.pipeline.step", async (stepSpan) => {
      stepSpan.setAttribute("media.operation", "image.generate");
      stepSpan.setAttribute("media.provider", "stability");

      const start = Date.now();
      await generateImage();
      const duration = Date.now() - start;

      obs.metrics.recordOperationDuration("image.generate", "stability", duration);
      obs.metrics.recordOperationCost("image.generate", "stability", 0.007);
    });
  });
}
```

### Structured Logging with Context

```typescript
obs.logger.info({
  pipelineId: "pipeline-123",
  stepId: "generate",
  operation: "image.generate",
  provider: "openai",
  artifactId: "artifact-456",
  costUsd: 0.04,
  durationMs: 2345,
}, "Step completed successfully");
```

### Cost Reporting Aggregation

```typescript
obs.costReporter.record({
  timestamp: new Date(),
  pipelineId: "pipeline-123",
  operation: "image.generate",
  provider: "stability",
  costUsd: 0.007,
});

const summary = obs.costReporter.getSummary();
console.log(summary.totalCost); // 0.007
console.log(summary.byProvider); // { stability: 0.007 }
console.log(summary.byOperation); // { "image.generate": 0.007 }
```

### Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  obs.logger.info({}, "Shutting down observability");
  await obs.shutdown();
  process.exit(0);
});
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server with built-in observability

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
