# @reaatech/media-pipeline-mcp-core

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-core.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Core framework for media pipeline orchestration. Provides the complete type system (Zod-validated), pipeline execution engine with variable interpolation, validation with provider availability checks, quality gate evaluation (threshold, dimension-check, LLM-judge, custom), artifact registry, budget enforcement, persistence-based resume, cost tracking, event bus, and a configurable mock provider for testing.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-core
# or
pnpm add @reaatech/media-pipeline-mcp-core
```

## Feature Overview

- **Pipeline execution engine** — sequential step processing with `{{step_id.output}}` variable interpolation, timeout handling, budget preflight, persistence-based resume, and run lifecycle management
- **Zod-validated type system** — 20+ schemas for `Pipeline`, `Step`, `Artifact`, `QualityGate`, `CostRecord`, `PipelineEvent`, `VariantsConfig`, `RunContext`, and more
- **Quality gate evaluation** — `threshold` (numeric checks on metadata fields), `dimension-check` (output dimensions with tolerance), `llm-judge` (LLM evaluates quality), and `custom` (user-provided function) with retry/gating/fail/warn actions
- **Artifact registry** — in-memory artifact tracking with CRUD operations, source-step lookup, batch deletion by source step, and latest-artifact retrieval
- **Pipeline validation** — Zod schema validation, duplicate step detection, path-traversal checks, circular/forward reference detection, provider availability verification, quality gate config validation, budget and variants config validation
- **Pipeline estimation** — dry-run cost estimation with per-step `usdLow`/`usdHigh` bands, provider-specific pricing, router-spread warnings, and prior-step dependency detection
- **Mock provider** — configurable simulated provider with delay, failure rate, base cost, and operation-specific artifact type/mime generation for development and testing
- **Event bus** — typed event emitter with `kind`-based subscription, promise-based `await`, and optional timeout
- **Budget enforcement** — `abort`/`suspend` on budget exceed with configurable warning thresholds
- **Persistence integration** — `PipelineStateStore` and `CostLedger` injection for run durability and cost recording
- **Provenance signing** — C2PA manifest callback with pipeline definition hash and ingredient tracking
- **Extensible provider interface** — `Provider` contract with `execute`, `healthCheck`, and optional `estimateCost`
- **Stateful resume (F3)** — persistence-backed resume from any step with lock acquisition and step state tracking
- **Adapter injection callbacks** — route-based provider selection, variants execution, ratio fan-out, context resolution, gate evaluation, and tenant policy enforcement via injected callbacks
- **30+ typed error classes** — categorized errors with `code`, `retryable` flags, and structured payloads for `BudgetExceededError`, `ArtifactNotFoundError`, `VariantsAllRejectedError`, `SafetyGateRejectedError`, and more

## Quick Start

```typescript
import {
  PipelineExecutor,
  PipelineValidator,
  ArtifactRegistry,
  MockProvider,
} from "@reaatech/media-pipeline-mcp-core";

const executor = new PipelineExecutor({
  providers: [new MockProvider()],
  defaultStepTimeoutMs: 60000,
});

const result = await executor.execute({
  id: "product-photo",
  steps: [
    {
      id: "generate",
      operation: "mock.generate",
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
      operation: "mock.transform",
      inputs: { artifact_id: "{{generate.output}}" },
      config: { scale: "4x" },
    },
  ],
  budget: {
    maxUsd: 1.0,
    onExceed: "abort",
    warnAtPct: 0.8,
  },
});

console.log(result.status); // "completed"
console.log(result.artifacts.size); // 2
```

## API Reference

### `PipelineExecutor`

The core execution engine for running pipelines with step-by-step processing, quality gate evaluation, budget enforcement, and variable interpolation.

```typescript
class PipelineExecutor {
  constructor(options: PipelineExecutorOptions);
  execute(definition: PipelineDefinition, options?: { runId?: string }): Promise<Pipeline>;
  resume(runId: string, fromStepId?: string): Promise<Pipeline>;
  resume(pipeline: Pipeline, action: 'retry' | 'skip' | 'abort'): Promise<Pipeline>;
  estimate(definition: PipelineDefinition): Promise<PipelineEstimate>;
  getRegistry(): ArtifactRegistry;
}
```

#### `PipelineExecutorOptions`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `providers` | `Provider[]` | **required** | Provider instances registered by operation |
| `defaultPipelineTimeoutMs` | `number` | `300000` | Max pipeline wall-clock time |
| `defaultStepTimeoutMs` | `number` | — | Max per-step execution time |
| `llmJudgeFn` | `(prompt, artifact) => Promise<{pass,reasoning,score?}>` | — | LLM-based quality evaluation |
| `customCheckFn` | `(artifact, config) => boolean \| Promise<boolean>` | — | Custom quality gate check |
| `prepareInputs` | `(op, inputs) => Promise<Record>` | — | Pre-execution input transformation |
| `persistArtifact` | `({artifactId,data,...}) => Promise<{uri?}>` | — | Storage persistence callback |
| `onEvent` | `(event: PipelineEvent) => void` | — | Lifecycle event listener |
| `onCost` | `(record: CostRecord) => void` | — | Per-operation cost callback |
| `persistence` | `PipelineStateStore` | — | Run state persistence (enables resume) |
| `ledger` | `CostLedger` | — | Cost accounting ledger |
| `routeStepFn` | `RouteStepFn` | — | Route-based provider selection |
| `variantsStepFn` | `VariantsStepFn` | — | Variants execution callback |
| `ratiosStepFn` | `RatiosStepFn` | — | Aspect-ratio fan-out callback |
| `context` | `RunContext` | — | Run context (voices, styles, brand kit) |
| `contextResolveFn` | `ContextResolveFn` | — | Context reference resolution |
| `gateEvalFn` | `GateEvalFn` | — | Custom gate evaluation (loudness, safety) |
| `tenantPolicyEnforceFn` | `(provider?, model?) => void` | — | Per-tenant allow-list enforcement |
| `signProvenance` | `({artifactId, runId, ...}) => Promise<{signedArtifactId,manifestUri}>` | — | C2PA provenance signing |

#### Provider Interface

```typescript
interface Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  execute(operation: string, inputs: Record<string, unknown>, config: Record<string, unknown>): Promise<{
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    cost_usd?: number;
    duration_ms?: number;
  }>;
  healthCheck(): Promise<boolean>;
  estimateCost?(input: { operation: string; params: Record<string, unknown>; config: Record<string, unknown> }): Promise<{ costUsd: number; estimatedDurationMs?: number }>;
}
```

### `PipelineValidator`

Validates pipeline definitions with schema checks, reference integrity, provider availability, and config warnings.

```typescript
class PipelineValidator {
  constructor(providerAvailability: ProviderAvailability);
  validate(definition: PipelineDefinition): ValidationResult;
}
```

Validation checks performed:
1. Zod schema validation against `PipelineDefinitionSchema`
2. Duplicate step ID and path-traversal character detection
3. Circular/forward reference detection in `{{step_id.output}}` patterns
4. Provider availability for each operation
5. Quality gate configuration completeness (retry without `maxRetries`, `llm-judge` without prompt, etc.)
6. Budget config validity (`maxUsd > 0`, `onExceed` must be `'abort'` or `'suspend'`)
7. Variants config validity (n between 2-16, valid `seedStrategy`, judge configured)
8. Run context validity (valid voice providers, clean style names)

### `PipelineEstimator`

Dry-run cost estimation with per-step bands.

```typescript
class PipelineEstimator {
  constructor(options?: PipelineEstimatorOptions);
  estimate(pipeline: PipelineDefinition): Promise<PipelineEstimate>;
}

interface PipelineEstimate {
  totalUsdLow: number;
  totalUsdHigh: number;
  perStep: StepEstimate[];
  warnings: EstimateWarning[];
}
```

### `ArtifactRegistry`

In-memory artifact tracking for pipeline execution.

```typescript
class ArtifactRegistry {
  register(artifact: Omit<Artifact, 'id'>): Artifact;
  registerWithId(id: string, artifact: Omit<Artifact, 'id'>): Artifact;
  get(id: string): Artifact | undefined;
  delete(id: string): boolean;
  list(): Artifact[];
  findBySourceStep(stepId: string): Artifact | undefined;
  deleteBySourceStep(stepId: string): number;
  clear(): void;
  size(): number;
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
} from "@reaatech/media-pipeline-mcp-core";

const evaluator = createQualityGateEvaluator(
  { type: "threshold", config: { checks: [{ field: "metadata.width", operator: ">=", value: 1024 }] }, action: "fail" },
  llmJudgeFn,   // required for llm-judge type
  customCheckFn // required for custom type
);

const result = await evaluator.evaluate(gate, artifact);
// { passed: boolean, reasoning: string, score?: number, action: 'fail' | 'retry' | 'warn' }
```

#### Gate Types

| Type | Config | Description |
|------|--------|-------------|
| `threshold` | `{ checks: [{ field, operator, value }] }` | Numeric checks on artifact metadata fields. Operators: `>=`, `<=`, `>`, `<`, `==`, `!=` |
| `dimension-check` | `{ expectedWidth, expectedHeight, tolerance? }` | Verify output dimensions within tolerance (0-1) |
| `llm-judge` | `{ prompt, model?, timeout? }` | LLM evaluates output quality against a prompt. Requires `llmJudgeFn` injection |
| `custom` | `{ [key: string]: unknown }` | Arbitrary config passed to `customCheckFn` |

#### Gate Actions

| Action | Behavior |
|--------|----------|
| `fail` | Halt pipeline execution immediately |
| `retry` | Re-execute the step up to `maxRetries` times |
| `warn` | Log a warning and continue execution |

### `MockProvider`

Configurable simulated provider for development and testing.

```typescript
class MockProvider implements Provider {
  readonly name: string;
  readonly supportedOperations: string[];

  constructor(config?: {
    name?: string;                         // default: "mock"
    operations?: string[];                 // default: ["mock.generate", "mock.transform", "mock.extract"]
    delay?: number;                        // Simulated latency in ms (default: 100)
    failureRate?: number;                  // 0-1 probability of failure (default: 0)
    baseCost?: number;                     // Cost per operation (default: 0.001)
    alwaysPass?: boolean;                  // Generate high-quality (0.99) metadata (default: false)
  });
}
```

### Event Bus

Typed event bus for pipeline lifecycle events.

```typescript
import { createEventBus } from "@reaatech/media-pipeline-mcp-core";

const bus = createEventBus<{ kind: "step:complete"; stepId: string; artifactId: string }>();

const dispose = bus.on("step:complete", (event) => {
  console.log(`Step ${event.stepId} completed: ${event.artifactId}`);
});

bus.emit({ kind: "step:complete", stepId: "generate", artifactId: "artifact-123" });

// Promise-based await with optional predicate and timeout
const event = await bus.await("step:complete", (e) => e.stepId === "generate", 5000);

dispose(); // Unsubscribe
```

### Core Types

| Export | Description |
|--------|-------------|
| `PipelineSchema` / `Pipeline` | Full pipeline with steps, status, artifacts, and timing |
| `PipelineDefinitionSchema` / `PipelineDefinition` | User-supplied pipeline definition with optional budget/context |
| `PipelineStepSchema` / `PipelineStep` | Step with id, operation, inputs, config, quality gate, variants, cache, route |
| `ArtifactSchema` / `Artifact` | Pipeline output with id, type, uri, mimeType, metadata, sourceStep |
| `QualityGateSchema` / `QualityGate` | Gate with type, config, action, maxRetries |
| `QualityGateResultSchema` / `QualityGateResult` | Evaluation result with passed, reasoning, score, action |
| `CostRecordSchema` / `CostRecord` | Per-operation cost entry with operation, provider, model, cost_usd |
| `CostSummarySchema` / `CostSummary` | Aggregated costs by operation, provider, pipeline |
| `PipelineEventSchema` / `PipelineEvent` | Lifecycle event with type, pipelineId, stepId, timestamp, data |
| `PipelineStatus` | `"pending" \| "running" \| "completed" \| "failed" \| "gated" \| "cancelled"` |
| `PipelineRunRecord` | Persistence-layer run record with runId, definition, stepStates, cost |
| `StepStateRecord` | Per-step state in persistence: status, artifactId, attempts, timing |
| `PipelineStateStore` | Persistence interface: createRun, getRun, updateRun, acquireLock, releaseLock, listRuns |
| `CostLedger` | Cost interface: charge, getRunCost, getTotalCost |
| `BudgetConfig` | Budget with maxUsd, onExceed, warnAtPct |
| `PipelineEstimate` / `StepEstimate` / `EstimateWarning` | Dry-run estimation results |
| `RunContext` / `VoiceRef` / `StyleRef` / `BrandKit` | Run context for voice/style/brand resolution |
| `VariantsConfig` / `VariantResult` / `VariantsStepOutput` | Variants configuration and results |
| `JudgeConfig` / `JudgeRubric` | Variants judge types (llm-judge, image-judge, rule, custom) |
| `ArtifactMetaSchema` / `ArtifactMeta` | Storage-level artifact metadata |
| `ValidationResultSchema` / `ValidationResult` | Validator output with valid, errors, warnings, estimates |

### Error Classes

All errors extend `A2AError` and carry `code` and `retryable` properties.

| Error Class | Code | Retryable | Description |
|-------------|------|-----------|-------------|
| `IdempotencyConflictError` | `IDEMPOTENCY_CONFLICT` | No | Duplicate idempotency key with in-flight or body-mismatch |
| `BudgetExceededError` | `BUDGET_EXCEEDED` | No | Budget cap reached (run, tenant-daily, or tenant-monthly) |
| `RunNotFoundError` | `RUN_NOT_FOUND` | No | Persisted run not found for resume |
| `RunInProgressError` | `RUN_IN_PROGRESS` | Yes | Run lock held by another process |
| `RunNotResumableError` | `RUN_NOT_RESUMABLE` | No | Run in terminal state or `resumable: false` |
| `WebhookSignatureInvalidError` | `WEBHOOK_SIGNATURE_INVALID` | No | Webhook HMAC verification failed |
| `WebhookProviderUnknownError` | `WEBHOOK_PROVIDER_UNKNOWN` | No | Webhook provider not recognized |
| `StateStoreUnavailableError` | `STATE_STORE_UNAVAILABLE` | Yes | Persistence backend unreachable |
| `EstimateUnsupportedError` | `ESTIMATE_UNSUPPORTED` | No | Cost estimation not available for operation |
| `ArtifactNotFoundError` | `ARTIFACT_NOT_FOUND` | No | Referenced artifact missing from registry |
| `RouterAllCandidatesFailedError` | `ROUTER_ALL_CANDIDATES_FAILED` | No | All routing candidates exhausted |
| `RouterNoCandidatesError` | `ROUTER_NO_CANDIDATES` | No | Empty candidate list for routing |
| `RouterFastestIneligibleError` | `ROUTER_FASTEST_INELIGIBLE` | No | Candidate exceeds fastest strategy duration cap |
| `SafetyGateRejectedError` | `SAFETY_GATE_REJECTED` | No | Content safety check blocked artifact |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` | No | Tenant not found in multi-tenant deployment |
| `KeyVaultUnavailableError` | `KEY_VAULT_UNAVAILABLE` | Yes | Key vault service unreachable |
| `FfmpegUnavailableError` | `FFMPEG_UNAVAILABLE` | No | ffmpeg not found for audio/video processing |
| `VariantsAllRejectedError` | `VARIANTS_ALL_REJECTED` | No | All variants failed (safety, judge-low, generation-error) |
| `JudgeUnavailableError` | `JUDGE_UNAVAILABLE` | Yes | LLM judge service unreachable |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | No | ComfyUI workflow not found |
| `WorkflowExpiredError` | `WORKFLOW_EXPIRED` | No | ComfyUI workflow exceeded retention period |
| `ContextRefUnknownError` | `CONTEXT_REF_UNKNOWN` | No | Context reference (voice/style/brand) not found |
| `ContextRefTypeError` | `CONTEXT_REF_TYPE_MISMATCH` | No | Context reference type mismatch for operation |
| `LoudnessGateFailedError` | `LOUDNESS_GATE_FAILED` | No | Audio loudness gate out of tolerance |
| `TenantPolicyViolationError` | `TENANT_POLICY_VIOLATION` | No | Provider/model blocked by tenant allow-list |
| `ProvenanceSigningFailedError` | `PROVENANCE_SIGNING_FAILED` | No | C2PA manifest signing failed |
| `SafetyProviderUnavailableError` | `SAFETY_PROVIDER_UNAVAILABLE` | Yes | Safety classifier unreachable |
| `RatioUnsupportedError` | `RATIO_UNSUPPORTED` | No | Aspect ratio not natively supported by provider |
| `InvalidInputError` | `INVALID_INPUT` | No | Invalid step input |
| `FormatUnsupportedError` | `FORMAT_UNSUPPORTED` | No | Output format not supported for operation |
| `ArtifactAccessDeniedError` | `ARTIFACT_ACCESS_DENIED` | No | Tenant-scoped access denied |
| `InvalidResourceUriError` | `INVALID_RESOURCE_URI` | No | Invalid resource URI format |

## Usage Patterns

### Pipeline with Persistence and Resume

```typescript
const executor = new PipelineExecutor({
  providers: [new MockProvider()],
  persistence: stateStore,     // PipelineStateStore for durability
  ledger: costLedger,          // CostLedger for cost tracking
  onEvent: (event) => console.log(event.type, event.pipelineId),
  onCost: (record) => console.log(`Cost: $${record.cost_usd}`),
});

// Execute with a specific runId for idempotency
const result = await executor.execute(definition, { runId: "run-001" });

// Resume from persistence
const resumed = await executor.resume("run-001");
// Or resume from a specific step
const resumedFrom = await executor.resume("run-001", "upscale");
```

### Dry-Run Estimation

```typescript
const estimator = new PipelineEstimator({
  estimateOperation: async (operation, config) => {
    return { usdLow: 0.001, usdHigh: 0.01 };
  },
  ledger: costLedger,
});

const estimate = await estimator.estimate(definition);
console.log(`Cost range: $${estimate.totalUsdLow} - $${estimate.totalUsdHigh}`);
```

### Validation with Provider Checks

```typescript
const validator = new PipelineValidator({
  isAvailable: (op) => providers.has(op),
  getEstimatedCost: (op) => 0.01,
  getEstimatedDuration: (op) => 5000,
});

const result = validator.validate(definition);
if (!result.valid) {
  result.errors.forEach(e => console.error(e));
}
result.warnings.forEach(w => console.warn(w));
```

### LLM-Judge Quality Gate

```typescript
const executor = new PipelineExecutor({
  providers: [new MockProvider()],
  llmJudgeFn: async (prompt, artifact) => {
    const response = await callLLM(prompt, artifact.uri);
    return { pass: response.score >= 7, reasoning: response.explanation, score: response.score };
  },
});

// Step with llm-judge:
{
  id: "generate",
  operation: "image.generate",
  inputs: { prompt: "..." },
  config: {},
  qualityGate: {
    type: "llm-judge",
    config: { prompt: "Rate image quality from 1-10", timeout: 30000 },
    action: "retry",
    maxRetries: 2,
  },
}
```

### Event Bus Usage

```typescript
const bus = createEventBus<{ kind: "pipeline:complete"; pipelineId: string; artifacts: string[] }>();

bus.on("pipeline:complete", (event) => {
  console.log(`Pipeline ${event.pipelineId} done with ${event.artifacts.length} artifacts`);
});

// Await an event
const completed = await bus.await("pipeline:complete", (e) => e.pipelineId === "my-pipeline", 60000);
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Abstract provider base class and router
- [`@reaatech/media-pipeline-mcp-pipeline`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline) — Pipeline templates, variants, batches, ratios
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence (local, S3, GCS)
- [`@reaatech/media-pipeline-mcp-resilience`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-resilience) — Circuit breaker and retry policies
- [`@reaatech/media-pipeline-mcp-security`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security) — Auth, RBAC, rate limiting, audit logging
- [`@reaatech/media-pipeline-mcp-observability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-observability) — Tracing, metrics, structured logging

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
