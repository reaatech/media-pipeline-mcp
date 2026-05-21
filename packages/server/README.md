# @reaatech/media-pipeline-mcp-server

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-server.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

MCP server that exposes 35+ media operations via the Model Context Protocol over StreamableHTTP transport. Orchestrates provider routing, storage, security, cost tracking, pipeline execution, quality gates, webhooks, streaming progress, batch pipelines, real-time STT, 3D mesh generation, and multi-tenant key management.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-server
# or
pnpm add @reaatech/media-pipeline-mcp-server
```

## Feature Overview

### Core Features

- **35+ MCP tools** — image generation/editing, audio TTS/STT, video generation, document extraction, pipeline execution, quality gates, cost tracking, 3D mesh generation, and real-time STT streaming
- **StreamableHTTP transport** — MCP protocol compliance with JSON-RPC 2.0 routing via `@modelcontextprotocol/sdk`
- **Provider auto-detection** — env-var-based provider instantiation (`OPENAI_API_KEY`, `STABILITY_API_KEY`, etc.) with automatic fallback to MockProvider
- **Multi-provider routing** — operation-based provider selection with primary/fallback, cheapest-acceptable, fastest, and first-success strategies
- **Cost tracking** — daily/monthly/per-pipeline budget limits with alert thresholds (ok → warning → critical → exceeded)
- **Pipeline engine integration** — execute multi-step pipeline definitions with artifact passing, variable interpolation, and quality gates
- **Quality gate evaluation** — LLM-judge, threshold, dimension-check, loudness, safety, and custom gates within pipelines or standalone
- **CLI binary** — `media-pipeline-mcp` command to start the server
- **Authentication & RBAC** — JWT-based auth and API key validation with fine-grained permissions
- **Rate limiting** — per-client and per-operation rate limiting with configurable burst sizes
- **Input validation** — Zod schema validation on all tool inputs

### Phase 2 Features (F1–F21)

| Feature | ID | Description |
|---------|----|-------------|
| Idempotency | F1 | SHA-256 body hashing with in-flight conflict detection, completed replay, and failed replay. Uses `_meta.idempotencyKey` for safe retries. |
| Budget Caps | F4 | Pre-flight cost estimation; blocks operations exceeding daily, monthly, or per-pipeline budget limits. |
| Pipeline Estimation | F5 | Dry-run cost and duration estimation via `media.pipeline.estimate` / `pipeline.estimate` using per-provider `estimateCost()`. |
| Streaming Progress | F6 | MCP `$/progress` notifications with throttled progress events (step milestones, cost accrual, budget warnings). |
| Webhooks | F7 | Outbound event subscriptions and inbound provider callbacks (Replicate, Fal, Deepgram) with HMAC signature verification. |
| Provider Routing | F8 | Advanced routing strategies: `cheapest-acceptable`, `fastest`, `first-success` with multi-candidate decision making. |
| Variants | F9 | Execute multiple prompt/model variants in parallel and LLM-judge the best result. |
| Ratio Fan-out | F11 | Single prompt → multiple aspect ratio renders in one step. |
| Context Resolution | F13 | Interpolate `{{run.}}` and `{{step.}}` variables from pipeline run context. |
| Loudness Gate | F14 | Two-pass EBU R128 loudness measurement and normalization via ffmpeg. |
| Batch Pipelines | F15 | Execute pipelines from CSV, JSONL, or inline data sources with `{{row.field}}` interpolation, concurrency control, and per-row budget limits. |
| Safety Gate | F16 | Default-on safety moderation gate on all moderable operations. |
| Provenance (C2PA) | F17 | C2PA manifest signing with model ingredient assertions and upstream artifact references. |
| Multi-Tenant | F18 | Per-tenant key vault resolution, budget caps, provider allow-lists, and artifact prefix isolation via `TenantScopedArtifactStore`. |
| MCP Resources | F19 | Artifacts exposed as MCP resources with `resources/list_changed` notifications for subscribe-based refresh. |
| STT Streaming | F20 | Real-time WebSocket STT via Deepgram with interim results, speaker diarization, and URL/inline sources. |
| 3D Mesh Generation | F21 | Text-to-3D and image-to-3D mesh generation (GLB, FBX, OBJ, USDZ, PLY) via Meshy/Luma providers. |

## Quick Start

### CLI

```bash
# Start with auto-detected providers
export OPENAI_API_KEY=sk-...
export STABILITY_API_KEY=sk-...
export DEEPGRAM_API_KEY=...
npx @reaatech/media-pipeline-mcp-server start

# Server listening on http://0.0.0.0:8080
```

### With Feature Flags

```bash
# Enable Phase 2 features
FEATURE_WEBHOOKS=true \
FEATURE_STREAMING=true \
FEATURE_BATCH=true \
FEATURE_STT_STREAM=true \
npx @reaatech/media-pipeline-mcp-server start
```

### Programmatic

```typescript
import { MCPServer, loadConfig } from "@reaatech/media-pipeline-mcp-server";

const config = loadConfig();
const server = new MCPServer(config);
await server.start();

// Graceful shutdown
process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
```

## API Reference

### `MCPServer`

Main server class that orchestrates all components. Wraps an MCP `Server` from `@modelcontextprotocol/sdk`.

```typescript
class MCPServer {
  constructor(config: ServerConfig);

  start(): Promise<void>;
  stop(): Promise<void>;

  getAuthMiddleware(): AuthMiddleware | undefined;
  getRateLimiter(): RateLimiter | undefined;
  getCostTracker(): CostTracker;
}
```

### `ServerConfig`

Top-level configuration object. Validated at runtime with Zod.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | `number` | `8080` | HTTP listen port |
| `host` | `string` | `"0.0.0.0"` | Listen address |
| `logLevel` | `"error" \| "warn" \| "info" \| "debug"` | `"info"` | Log verbosity |
| `storage` | `StorageConfig` | `{ type: "local" }` | Storage backend (local, s3, gcs) |
| `providers` | `ProviderConfig[]` | auto-detected | Provider configurations |
| `auth` | `AuthConfig` | — | Authentication config |
| `rateLimit` | `RateLimitConfig` | — | Rate limiting config |
| `budget` | `BudgetConfig` | — | Cost budget limits |
| `features` | `FeaturesConfig` | — | Feature flags (see below) |
| `webhookBaseUrl` | `string` | — | Base URL for outbound webhook callbacks |
| `pipelineStateStore` | `PipelineStateStore` | — | Persistent pipeline state store |
| `costLedger` | `CostLedger` | — | Persistent cost ledger |
| `eventBus` | `EventBus<PipelineEvent>` | — | Event bus for streaming/webhooks |
| `provenanceConfig` | `ProvenanceConfig` | — | C2PA provenance signing config |
| `multiTenant` | `MultiTenantConfig` | — | Multi-tenant key vault + resolver |

### `loadConfig(env?)`

Loads configuration from environment variables with sensible defaults and full validation.

```typescript
function loadConfig(env?: NodeJS.ProcessEnv): ServerConfig;
```

### `validateConfig(config)`

Validates a raw config object against the server schema.

```typescript
function validateConfig(config: unknown): ServerConfig;
```

### `FeaturesConfig`

Feature flags control which Phase 2 capabilities are active. All default to `false` except `idempotency`, `budgetCaps`, `dryRun`, `runContext`, and `safetyGate`.

| Flag | Default | Description |
|------|---------|-------------|
| `idempotency` | `true` | F1: Idempotent retries with body hash |
| `contentCache` | `false` | Content-based result caching |
| `resumablePipelines` | `false` | Resume gated pipelines |
| `budgetCaps` | `true` | F4: Budget pre-flight checks |
| `dryRun` | `true` | F5: Pipeline cost estimation |
| `streaming` | `false` | F6: MCP progress notifications |
| `webhooks` | `false` | F7: Outbound/inbound webhooks |
| `routing` | `false` | F8: Advanced provider routing |
| `variants` | `false` | F9: Variant fan-out + judging |
| `subtitles` | `false` | Subtitle pipeline support |
| `runContext` | `true` | F13: `{{run.}}` interpolation |
| `batch` | `false` | F15: Batch pipeline execution |
| `safetyGate` | `true` | F16: Default safety moderation |
| `provenance` | `false` | F17: C2PA provenance signing |
| `mcpResources` | `false` | F19: Artifact MCP resources |
| `multiTenant` | `false` | F18: Multi-tenant isolation |
| `sttStream` | `false` | F20: Real-time STT streaming |

### `CostTracker`

Tracks all operation costs with daily/monthly/per-pipeline aggregation and budget enforcement.

```typescript
class CostTracker {
  constructor(budgetConfig?: BudgetConfig);

  canAfford(cost: number, pipelineId?: string): boolean;
  getBudgetStatus(pipelineId?: string): BudgetStatus;
  record(record: CostRecord): void;
  getSummary(): CostSummary;
  getRecords(): CostRecord[];
  getPipelineCost(pipelineId: string): number;
  getOperationCost(operation: string): number;
  getProviderCost(provider: string): number;
  reset(): void;
}
```

#### `BudgetConfig`

| Property | Type | Description |
|----------|------|-------------|
| `dailyLimit` | `number` | Daily cost limit in USD |
| `monthlyLimit` | `number` | Monthly cost limit in USD |
| `perPipelineLimit` | `number` | Per-pipeline limit in USD |
| `alertThreshold` | `number` | Fraction of limit to trigger alert (0–1, default: 0.9) |

#### Budget Alert Levels

| Level | Meaning |
|-------|---------|
| `ok` | Below 75% of alert threshold |
| `warning` | At or above 75% of alert threshold |
| `critical` | At or above the alert threshold |
| `exceeded` | At or above the limit — new operations blocked |

### `ProviderRegistry`

Manages registered providers and routes operations to the first provider that supports them.

```typescript
class ProviderRegistry {
  register(provider: Provider): void;
  getProvider(operation: string): Provider | undefined;
  getProviderByName(name: string): Provider | undefined;
  getAllProviders(): Provider[];
  getHealthStatus(): ProviderHealthStatus[];
  checkHealth(providerName: string): Promise<ProviderHealthStatus>;
  checkAllHealth(): Promise<ProviderHealthStatus[]>;
  isAvailable(operation: string): boolean;
}
```

### `ProviderFactory`

Creates provider instances from configuration with environment variable and key vault resolution.

```typescript
function createProvider(config: ProviderConfig, keyVault?: KeyVault): Promise<Provider | null>;
function createProviders(configs: ProviderConfig[], keyVault?: KeyVault): Promise<Provider[]>;
```

#### Auto-Detected Provider Env Vars

| Env Var | Provider Class | Operations |
|---------|---------------|------------|
| `STABILITY_API_KEY` | `StabilityProvider` | image.generate, image.inpaint |
| `OPENAI_API_KEY` | `OpenAIProvider` | image.generate, audio.tts, audio.stt, image.describe |
| `REPLICATE_API_KEY` | `ReplicateProvider` | image.generate, image.upscale, image.remove_background, video.generate |
| `FAL_API_KEY` | `FalProvider` | image.generate, image.upscale, image.remove_background |
| `ELEVENLABS_API_KEY` | `ElevenLabsProvider` | audio.tts |
| `DEEPGRAM_API_KEY` | `DeepgramProvider` | audio.stt, audio.diarize |
| `ANTHROPIC_API_KEY` | `AnthropicProvider` | image.describe, document.ocr, document.extract_tables, document.extract_fields, document.summarize |
| `GOOGLE_PROJECT_ID` | `GoogleProvider` | document.ocr, document.extract_tables, document.extract_fields, image.describe |

### `IdempotencyMiddleware`

Prevents duplicate pipeline executions using SHA-256 body hashing. Supports in-flight conflict detection, completed result replay, and failed result replay.

```typescript
class IdempotencyMiddleware {
  constructor(options: IdempotencyMiddlewareOptions);
  extractIdempotencyKey(args: Record<string, unknown>): string | undefined;
  extractProgressToken(args: Record<string, unknown>): string | undefined;
  wrap<TArgs, TResult>(handler: (args: TArgs, runId: string) => Promise<TResult>): (args: TArgs) => Promise<TResult>;
}
```

#### `InMemoryIdempotencyStore`

Default in-memory store. Replace with a persistent store (DynamoDB, Redis, Postgres) for production.

```typescript
class InMemoryIdempotencyStore implements IdempotencyStore {
  get(key: string): Promise<IdempotencyEntry | undefined>;
  set(entry: IdempotencyEntry): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### `StreamingBridge`

Bridges pipeline events to MCP `$/progress` notifications. Supports configurable throttling and event taxonomy normalisation.

```typescript
class StreamingBridge {
  constructor(eventBus: EventBus<PipelineEvent>, throttleMs?: number);
  subscribe(runId: string, progressToken: string, onProgress?: (n: ProgressNotification) => void): void;
  unsubscribe(progressToken: string): void;
  unsubscribeAll(): void;
}
```

### `ToolRegistry`

Manages the full catalog of MCP tools with input validation and operation-to-tool mapping.

```typescript
class ToolRegistry {
  getTool(name: string): ToolDefinition | undefined;
  getToolForOperation(operation: string): ToolDefinition | undefined;
  getAllTools(): ToolDefinition[];
  getToolsByCategory(category: string): ToolDefinition[];
  getSupportedOperations(): string[];
  toMCPTools(): Tool[];  // MCP SDK-compatible tool list
  isOperationSupported(operation: string): boolean;
  validateInput(toolName: string, input: Record<string, unknown>): { valid: boolean; errors: string[] };
}
```

### `PipelineEstimator`

Interface for pipeline cost/duration estimation.

```typescript
interface PipelineEstimator {
  estimate(pipeline: PipelineDefinition): Promise<PipelineEstimate>;
}

function handlePipelineEstimate(
  estimator: PipelineEstimator,
  args: { pipeline: PipelineDefinition },
): Promise<{ content: { type: string; text: string }[]; estimate: PipelineEstimate; success: boolean }>;
```

## MCP Tools

### Image Operations

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `image.generate` | Generate an image from a text prompt | `prompt` |
| `image.generate.batch` | Generate multiple images from prompt variations | `prompts` |
| `image.upscale` | Upscale an image to higher resolution (2x/4x/8x) | `artifact_id`, `scale` |
| `image.remove_background` | Remove background from an image (png/webp) | `artifact_id` |
| `image.inpaint` | Inpaint or edit parts of an image | `artifact_id`, `prompt` |
| `image.describe` | Generate a text description of an image | `artifact_id` |
| `image.resize` | Resize an image to new dimensions (cover/contain/fill) | `artifact_id`, `dimensions` |
| `image.crop` | Crop an image to a specific region | `artifact_id`, `x`, `y`, `width`, `height` |
| `image.composite` | Composite overlay one image onto another | `base_artifact_id`, `overlay_artifact_id` |
| `image.image_to_image` | Transform an image based on a text prompt | `artifact_id`, `prompt` |
| `mesh.generate` | Generate a 3D mesh from text or image (F21) | — |

### Audio Operations

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `audio.tts` | Convert text to speech | `text` |
| `audio.stt` | Transcribe audio to text | `artifact_id` |
| `audio.diarize` | Identify speakers in audio | `artifact_id` |
| `audio.isolate` | Isolate specific audio stems (vocals/instruments/drums/bass) | `artifact_id`, `target` |
| `audio.music` | Generate music from a text prompt | `prompt` |
| `audio.sound_effect` | Generate a sound effect from a text prompt | `prompt` |
| `audio.transcribeStream` | Real-time STT streaming via WebSocket (F20) | `source` |

### Video Operations

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `video.generate` | Generate a video from a text prompt | `prompt` |
| `video.image_to_video` | Animate an image into a video | `artifact_id` |
| `video.extract_frames` | Extract frames from a video at intervals or timestamps | `artifact_id` |
| `video.extract_audio` | Extract audio track from a video (mp3/wav/aac) | `artifact_id` |
| `video.subtitle` | Generate subtitles via STT with optional burn-in | `artifactId` |

### Document Operations

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `document.ocr` | Extract text from document images (plain_text/structured_json/markdown) | `artifact_id` |
| `document.extract_tables` | Extract tables from documents (markdown/json) | `artifact_id` |
| `document.extract_fields` | Extract structured fields from documents with a schema | `artifact_id`, `field_schema` |
| `document.summarize` | Summarize document content (short/medium/long/detailed) | `artifact_id` |

### Pipeline Operations

| Tool | Spec Alias | Description | Required Params |
|------|-----------|-------------|-----------------|
| `media.pipeline.run` | `pipeline.execute` | Execute a pipeline definition | `pipeline` |
| `media.pipeline.status` | `pipeline.status` | Check pipeline run status | `pipeline_id` |
| `media.pipeline.resume` | `pipeline.resume` | Resume a gated or failed pipeline by run ID | `runId` |
| `media.pipeline.cancel` | `pipeline.cancel` | Cancel a running pipeline | `pipeline_id` |
| `media.pipeline.estimate` | `pipeline.estimate` | Dry-run cost and duration estimate | `pipeline` |
| `media.pipeline.subscribe` | `pipeline.subscribe` | Subscribe to pipeline events via webhook | `pipeline_id`, `url`, `events` |
| `media.pipeline.define` | — | Validate and preview a pipeline without executing | `pipeline` |
| `media.pipeline.templates` | `pipeline.templates` | List pre-built pipeline templates | — |
| `media.pipeline.batch` | `pipeline.batch` | Execute batch pipelines from CSV/JSONL/inline data | `pipeline`, `source` |
| `media.pipeline.batch.status` | `pipeline.batch.status` | Check batch execution status | `batchId` |
| `media.pipeline.batch.retry` | `pipeline.batch.retry` | Retry failed rows in a batch | `batchId` |
| `media.pipeline.batch.cancel` | `pipeline.batch.cancel` | Cancel a running batch execution | `batchId` |

### Other Tools

| Tool | Description | Required Params |
|------|-------------|-----------------|
| `media.artifact.get` | Retrieve artifact metadata by ID | `artifact_id` |
| `media.artifact.list` | List artifacts with optional prefix filter and limit | — |
| `media.artifact.delete` | Delete an artifact by ID | `artifact_id` |
| `media.providers.list` | List configured providers and health status | — |
| `media.providers.health` | Check health of a specific provider | `provider_id` |
| `quality_gate.evaluate` | Evaluate an artifact against a quality gate | `artifact_id`, `gate` |
| `media.costs.summary` | Get running cost totals by operation and provider | — |

## Usage Patterns

### Pipeline Execution

```jsonc
// POST to /tools/call with MCP protocol
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.run",
    "arguments": {
      "pipeline": {
        "id": "product-photo",
        "steps": [
          {
            "id": "generate",
            "operation": "image.generate",
            "inputs": { "prompt": "Professional product photo of a white sneaker" },
            "config": { "model": "sd3", "dimensions": "1024x1024" },
            "qualityGate": {
              "type": "llm-judge",
              "config": { "prompt": "Does this look professional?", "model": "gpt-4o-mini" },
              "action": "retry",
              "maxRetries": 2
            }
          },
          {
            "id": "upscale",
            "operation": "image.upscale",
            "inputs": { "artifact_id": "{{generate.output}}" },
            "config": { "scale": "4x" }
          },
          {
            "id": "remove_bg",
            "operation": "image.remove_background",
            "inputs": { "artifact_id": "{{upscale.output}}" }
          }
        ]
      }
    }
  }
}
```

Response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "success": true,
    "content": [{ "type": "text", "text": "Pipeline 'product-photo' completed with status: completed\nDuration: 12.3s\nCost: $0.0280\nArtifacts: 3" }],
    "pipeline_id": "product-photo",
    "status": "completed",
    "artifacts": [
      { "id": "image-generate-1716300000000", "type": "image", "uri": "s3://bucket/...", "sourceStep": "generate" },
      { "id": "image-upscale-1716300010000", "type": "image", "uri": "s3://bucket/...", "sourceStep": "upscale" },
      { "id": "image-remove_background-1716300020000", "type": "image", "uri": "s3://bucket/...", "sourceStep": "remove_bg" }
    ],
    "cost_usd": 0.028,
    "duration_ms": 12300
  }
}
```

### Pipeline with Idempotency

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.run",
    "arguments": {
      "_meta": {
        "idempotencyKey": "order-1234567",
        "progressToken": "stream-xyz"
      },
      "pipeline": {
        "id": "product-photo",
        "steps": [ /* ... */ ]
      }
    }
  }
}
```

Idempotency behaviors:
- **First call** → executes the pipeline, stores result
- **Duplicate call (same body)** → returns stored result instantly, no re-execution
- **Concurrent call** → throws `IdempotencyConflictError('in-flight')`
- **Mismatched body** → throws `IdempotencyConflictError('body-mismatch')`
- **Prior failure** → re-throws the stored error

### Pipeline Resume

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.resume",
    "arguments": {
      "runId": "run-1716300000000-abc123",
      "fromStepId": "upscale"
    }
  }
}
```

Resumes a pipeline from the point of failure/gate. Pass `fromStepId` to resume from a specific step.

### Pipeline Estimate

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.estimate",
    "arguments": {
      "pipeline": {
        "id": "product-photo",
        "steps": [
          {
            "id": "generate",
            "operation": "image.generate",
            "inputs": { "prompt": "..." },
            "config": { "model": "sd3", "dimensions": "1024x1024" }
          }
        ]
      }
    }
  }
}
```

Returns a `PipelineEstimate` with per-step cost ranges, total min/max cost, estimated duration, router spread warnings, and variable-output-size notes.

### Batch Pipeline

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.batch",
    "arguments": {
      "pipeline": {
        "id": "bulk-product-photos",
        "steps": [
          {
            "id": "generate",
            "operation": "image.generate",
            "inputs": { "prompt": "{{row.prompt}}" },
            "config": { "dimensions": "1024x1024" }
          }
        ]
      },
      "source": {
        "type": "inline",
        "rows": [
          { "prompt": "White sneaker on clean white background" },
          { "prompt": "Red running shoe on gym floor" },
          { "prompt": "Blue dress shoe on wooden surface" }
        ]
      },
      "concurrency": 2,
      "onRowFailure": "continue",
      "perRunBudget": { "maxUsd": 0.05, "onExceed": "abort" }
    }
  }
}
```

Batch operations:
- `media.pipeline.batch.status` — check batch progress (completed/failed/in-flight counts)
- `media.pipeline.batch.retry` — retry failed or specific rows
- `media.pipeline.batch.cancel` — cancel a running batch

### Webhook Subscription

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.subscribe",
    "arguments": {
      "runId": "run-1716300000000-abc123",
      "webhookUrl": "https://my-app.com/webhooks/media-pipeline",
      "events": ["run-completed", "run-failed", "step-completed"],
      "secret": "my-hmac-secret"
    }
  }
}
```

If `secret` is omitted, the server mints one and returns it so the caller can verify outbound HMAC signatures.

### Quality Gate Evaluation (Standalone)

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "quality_gate.evaluate",
    "arguments": {
      "artifact_id": "img-123",
      "gate": {
        "type": "llm-judge",
        "config": {
          "prompt": "Is this image appropriate for commercial use? Rate 1-10.",
          "model": "gpt-4o-mini"
        },
        "action": "fail"
      }
    }
  }
}
```

### Response Format

All tool responses follow a consistent format:

```jsonc
// Success
{
  "success": true,
  "content": [{ "type": "text", "text": "Operation completed successfully.\n..." }],
  "pipeline_id": "my-pipeline",
  "status": "completed",
  "artifacts": [{ "id": "artifact-123", "type": "image", "uri": "s3://...", "sourceStep": "step1" }],
  "cost_usd": 0.014,
  "duration_ms": 4523
}

// Error
{
  "success": false,
  "error": "Artifact not found: invalid-id"
}
```

## Webhook Configuration

### Outbound Webhooks

Outbound webhooks deliver pipeline events to subscriber URLs. Configure via `media.pipeline.subscribe` tool or programmatically.

Events dispatched: `run-created`, `run-started`, `run-completed`, `run-failed`, `run-suspended`, `run-resumed`, `step-started`, `step-completed`, `step-failed`, `step-gated`, `step-cached`, `step-progress`.

```typescript
// Programmatic subscription
import { SubscriptionManager, WebhookDeliveryService } from "@reaatech/media-pipeline-mcp-server";

const manager = new SubscriptionManager();
const delivery = new WebhookDeliveryService();

const sub = manager.subscribe({
  pipelineId: "run-123",
  url: "https://my-app.com/hooks",
  events: ["run-completed", "run-failed"],
  secret: "hmac-key-32+chars",
});
```

### Inbound Webhooks

Inbound webhooks receive provider callbacks on `POST /webhooks/:provider/:runId`. Supported providers:

| Provider | Env Var for Secret | Purpose |
|----------|-------------------|---------|
| `replicate` | `REPLICATE_WEBHOOK_SECRET` | Async model prediction completion |
| `fal` | `FAL_WEBHOOK_SECRET` | Async fal model completion |
| `deepgram` | `DEEPGRAM_WEBHOOK_SECRET` | Batch transcription results |

Webhook signatures are verified via provider-specific HMAC before the handler auto-resumes the associated pipeline.

## Multi-Tenant Configuration

When `features.multiTenant` is enabled, every request resolves a `TenantContext` before tool dispatch:

```typescript
const config: ServerConfig = {
  features: { multiTenant: true },
  multiTenant: {
    enabled: true,
    keyVault: new AwsKeyVault(/* ... */),
    resolver: { kind: "header", headerName: "x-tenant-id" },
    defaultBudgetCaps: { dailyLimit: 50, monthlyLimit: 1000 },
  },
};
```

The resolved `TenantContext` flows through `AsyncLocalStorage` to:
- **Provider factory** — per-tenant API keys from the key vault
- **Storage** — `TenantScopedArtifactStore` prefixes all artifacts to `tenants/{tenantId}/`
- **Cost ledger** — per-tenant cost aggregation
- **Provider allow-list** — `enforceTenantPolicy` blocks unapproved providers/models
- **MCP Resources** — cross-tenant reads return `ArtifactAccessDeniedError` (403)

Tenant resolution strategies:
- `header` — reads `x-tenant-id` from HTTP headers
- `static` — fixed tenant ID from config
- Custom — supply your own resolution function

## Environment Variables

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | Log level (`error`, `warn`, `info`, `debug`) |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_TYPE` | `local` | Storage backend (`local`, `s3`, `gcs`) |
| `STORAGE_PATH` | `./artifacts` | Local storage directory |
| `STORAGE_TTL` | — | TTL in seconds for local storage |
| `STORAGE_SERVE_HTTP` | `false` | Serve artifacts via HTTP |
| `S3_BUCKET` | `media-artifacts` | S3 bucket name |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_PREFIX` | `artifacts/` | S3 key prefix |
| `GCS_BUCKET` | `media-artifacts` | GCS bucket name |
| `GCS_PREFIX` | `artifacts/` | GCS key prefix |

### Provider API Keys

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI (image, audio, vision) |
| `STABILITY_API_KEY` | Stability AI (image generation, inpainting) |
| `REPLICATE_API_KEY` | Replicate (image/video generation, upscaling) |
| `FAL_API_KEY` | Fal (image/video generation) |
| `ELEVENLABS_API_KEY` | ElevenLabs (TTS) |
| `DEEPGRAM_API_KEY` | Deepgram (STT, diarization) |
| `ANTHROPIC_API_KEY` | Anthropic (vision, document extraction) |
| `GOOGLE_PROJECT_ID` | Google Cloud project for Document AI / Vertex AI |
| `GOOGLE_LOCATION` | Google Cloud location (default: `us-central1`) |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | Document AI processor ID |
| `GOOGLE_GEMINI_MODEL` | Gemini model override for image description |
| `GOOGLE_KEY_FILE` | Google service account JSON path |
| `GOOGLE_APPLICATION_CREDENTIALS` | Standard Google credentials env var |

### Authentication & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ENABLED` | `false` | Enable JWT/API key authentication |
| `JWT_SECRET` | — | JWT signing secret (min 32 characters) |
| `API_KEYS` | — | Comma-separated API keys |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |
| `RATE_LIMIT_RPM` | `60` | Requests per minute per client |
| `RATE_LIMIT_BURST` | `10` | Burst size per client |
| `EXPENSIVE_OPS_RPM` | `10` | Rate limit for expensive operations (image/video gen, TTS) |

### Budget & Cost Controls

| Variable | Default | Description |
|----------|---------|-------------|
| `BUDGET_DAILY_LIMIT` | — | Daily budget limit in USD |
| `BUDGET_MONTHLY_LIMIT` | — | Monthly budget limit in USD |
| `BUDGET_PER_PIPELINE_LIMIT` | — | Per-pipeline budget limit in USD |
| `BUDGET_ALERT_THRESHOLD` | `0.9` | Alert threshold as fraction of limit (0–1) |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `FEATURE_IDEMPOTENCY` | `true` | Idempotent retries (F1) |
| `FEATURE_CONTENT_CACHE` | `false` | Content-based caching |
| `FEATURE_RESUMABLE_PIPELINES` | `false` | Resumable pipelines |
| `FEATURE_BUDGET_CAPS` | `true` | Budget pre-flight checks (F4) |
| `FEATURE_DRY_RUN` | `true` | Cost estimation (F5) |
| `FEATURE_STREAMING` | `false` | Progress notifications (F6) |
| `FEATURE_WEBHOOKS` | `false` | Inbound/outbound webhooks (F7) |
| `FEATURE_ROUTING` | `false` | Advanced provider routing (F8) |
| `FEATURE_VARIANTS` | `false` | Variant fan-out (F9) |
| `FEATURE_SUBTITLES` | `false` | Subtitle pipeline |
| `FEATURE_RUN_CONTEXT` | `true` | Run context interpolation (F13) |
| `FEATURE_BATCH` | `false` | Batch pipelines (F15) |
| `FEATURE_SAFETY_GATE` | `true` | Safety moderation gate (F16) |
| `FEATURE_PROVENANCE` | `false` | C2PA provenance (F17) |
| `FEATURE_MULTI_TENANT` | `false` | Multi-tenant isolation (F18) |
| `FEATURE_MCP_RESOURCES` | `false` | Artifact MCP resources (F19) |
| `FEATURE_STT_STREAM` | `false` | Real-time STT (F20) |

### Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry collector endpoint |
| `WEBHOOK_BASE_URL` | — | Base URL for outbound webhook callbacks |

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline engine and types
- [`@reaatech/media-pipeline-mcp-security`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security) — Auth, RBAC, rate limiting
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence (local/S3/GCS)
- [`@reaatech/media-pipeline-mcp-pipeline`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline) — Variants, ratios, batch, context resolution
- [`@reaatech/media-pipeline-mcp-keyvault`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-keyvault) — Multi-tenant key vault abstraction
- [`@reaatech/media-pipeline-mcp-provenance`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provenance) — C2PA provenance signing
- [`@reaatech/media-pipeline-mcp-persistence`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-persistence) — Persistent pipeline state store
- [`@reaatech/media-pipeline-mcp-cost`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-cost) — Cost ledger and aggregation
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — OpenAI provider
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Stability AI provider
- [`@reaatech/media-pipeline-mcp-replicate`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate) — Replicate provider
- [`@reaatech/media-pipeline-mcp-fal`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal) — Fal provider
- [`@reaatech/media-pipeline-mcp-deepgram`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram) — Deepgram provider
- [`@reaatech/media-pipeline-mcp-elevenlabs`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-elevenlabs) — ElevenLabs provider
- [`@reaatech/media-pipeline-mcp-anthropic`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic) — Anthropic provider
- [`@reaatech/media-pipeline-mcp-google`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google) — Google provider
- [`@reaatech/media-pipeline-mcp-meshy`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-meshy) — 3D mesh generation provider
- [`@reaatech/media-pipeline-mcp-luma`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-luma) — 3D/video AI provider
- [`@reaatech/media-pipeline-mcp-ollama`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-ollama) — Local LLM provider
- [`@reaatech/media-pipeline-mcp-comfyui`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-comfyui) — ComfyUI provider
- [`@reaatech/media-pipeline-mcp-audio-gen`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-audio-gen) — Audio operations
- [`@reaatech/media-pipeline-mcp-video-gen`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-video-gen) — Video operations

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
