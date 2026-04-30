# @reaatech/media-pipeline-mcp

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Core framework for media pipeline orchestration. Provides the foundational types, pipeline execution engine, validation, quality gate evaluation, artifact registry, and a mock provider for testing.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp
# or
pnpm add @reaatech/media-pipeline-mcp
```

## Feature Overview

- **Pipeline execution engine** — sequential step processing with variable interpolation (`{{step_id.output}}`), timeout handling, and status management
- **Zod-validated types** — complete type system with 20+ schemas for `Pipeline`, `Step`, `Artifact`, `QualityGate`, `CostRecord`, and more
- **Quality gate evaluation** — threshold, dimension-check, LLM-judge, and custom evaluators with retry/gating/fail/warn actions
- **Artifact registry** — in-memory artifact tracking with CRUD operations, source-step lookup, and batch deletion
- **Pipeline validation** — schema validation, duplicate step detection, path-traversal checks, circular reference detection, provider availability checks
- **Mock provider** — for development and testing with configurable delay, failure rate, and cost
- **Pipeline events** — lifecycle events (`pipeline:start`, `step:complete`, `quality_gate:evaluate`, etc.)
- **Cost tracking** — per-operation, per-provider, per-pipeline cost aggregation via callback

## Quick Start

```typescript
import {
  PipelineExecutor,
  PipelineValidator,
  ArtifactRegistry,
  MockProvider,
} from "@reaatech/media-pipeline-mcp";

const executor = new PipelineExecutor({
  providers: [new MockProvider()],
});

const result = await executor.execute({
  id: "my-pipeline",
  steps: [
    {
      id: "generate",
      operation: "image.generate",
      inputs: { prompt: "A sunset over mountains" },
      config: { dimensions: "1024x1024" },
      qualityGate: {
        type: "threshold",
        config: { checks: [{ field: "metadata.width", operator: ">=", value: 1024 }] },
        action: "retry",
        maxRetries: 2,
      },
    },
    {
      id: "upscale",
      operation: "image.upscale",
      inputs: { artifact_id: "{{generate.output}}" },
      config: { scale: "4x" },
    },
  ],
});

console.log(result.status); // "completed"
console.log(result.artifacts); // [{ id: "...", type: "image", ... }, ...]
console.log(result.cost_usd); // 0.011
```

## API Reference

### `PipelineExecutor`

```typescript
interface PipelineExecutorOptions {
  providers: Provider[];
  artifactRegistry?: ArtifactRegistry;
  onEvent?: (event: PipelineEvent) => void;
  onCost?: (record: CostRecord) => void;
  stepTimeoutMs?: number;
}

class PipelineExecutor {
  constructor(options: PipelineExecutorOptions);
  execute(pipeline: Pipeline): Promise<PipelineResult>;
}
```

### `PipelineValidator`

```typescript
class PipelineValidator {
  validate(
    pipeline: PipelineDefinition,
    availableProviders: string[]
  ): ValidationResult;
}
```

### `ArtifactRegistry`

```typescript
interface ArtifactRegistryInterface {
  register(artifactId: string, stepId: string, metadata?: Record<string, unknown>): void;
  getStepArtifacts(stepId: string): string[];
  getStepOutput(stepId: string): string | undefined;
  deleteStep(stepId: string): void;
}
```

### Quality Gates

```typescript
import {
  createQualityGateEvaluator,
  ThresholdEvaluator,
  DimensionCheckEvaluator,
  LLMJudgeEvaluator,
  CustomEvaluator,
} from "@reaatech/media-pipeline-mcp";

const evaluator = createQualityGateEvaluator("threshold", {
  checks: [{ field: "metadata.width", operator: ">=", value: 1024 }],
});

const result = await evaluator.evaluate(artifact);
console.log(result.pass, result.score);
```

#### Gate Types

| Type | Description | Config |
|------|-------------|--------|
| `threshold` | Numeric checks on metadata fields | `{ checks: [{ field, operator, value }] }` |
| `dimension-check` | Verify output dimensions | `{ expectedWidth, expectedHeight, tolerance }` |
| `llm-judge` | LLM evaluates output quality | `{ prompt, model, timeout }` |
| `custom` | User-provided function | `{ customCheckFn: (artifact, ctx) => Promise<Result> }` |

#### Gate Actions

| Action | Behavior |
|--------|----------|
| `fail` | Halt pipeline execution |
| `retry` | Re-execute the step up to `maxRetries` times |
| `warn` | Log warning and continue |

### `MockProvider`

```typescript
interface MockProviderConfig {
  delayMs?: number;       // Simulated latency (default: 50)
  failureRate?: number;   // Probability of failure 0–1 (default: 0)
  defaultCostUsd?: number; // Cost per operation (default: 0.007)
}

class MockProvider implements Provider {
  readonly name = "mock";
  readonly supportedOperations = ["image.generate", "image.upscale", /* ... */];
  constructor(config?: MockProviderConfig);
}
```

### Core Types

| Export | Description |
|--------|-------------|
| `PipelineSchema` / `Pipeline` | Full pipeline definition with steps |
| `PipelineStepSchema` / `PipelineStep` | Step with operation, inputs, config, quality gate |
| `ArtifactSchema` / `Artifact` | Pipeline output artifact with metadata |
| `QualityGateSchema` / `QualityGate` | Gate configuration with type, config, action, maxRetries |
| `CostRecordSchema` / `CostRecord` | Per-operation cost entry |
| `CostSummarySchema` / `CostSummary` | Aggregated cost totals |
| `PipelineStatus` | `"pending" \| "running" \| "completed" \| "failed" \| "gated"` |

### Provider Interface

```typescript
interface Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  execute(operation: string, inputs: Record<string, unknown>, config: Record<string, unknown>): Promise<{
    artifact: Omit<Artifact, "id" | "createdAt">;
    cost_usd?: number;
    duration_ms?: number;
  }>;
  healthCheck(): Promise<boolean>;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server that consumes the pipeline engine
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence layer
- [`@reaatech/media-pipeline-mcp-pipeline`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline) — Pipeline templates and operations

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
