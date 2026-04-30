# @reaatech/media-pipeline-mcp-server

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-server.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

MCP server that exposes all media operations via the Model Context Protocol over StreamableHTTP transport. Orchestrates providers, storage, security, cost tracking, and pipeline execution through 30+ MCP tools.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-server
# or
pnpm add @reaatech/media-pipeline-mcp-server
```

## Feature Overview

- **30+ MCP tools** — image generation/editing, audio TTS/STT, video generation, document extraction, pipeline execution, quality gates, and cost tracking
- **StreamableHTTP transport** — MCP protocol compliance with JSON-RPC 2.0 routing
- **Provider auto-detection** — env-var-based provider instantiation (`OPENAI_API_KEY`, `STABILITY_API_KEY`, etc.) with auto-fallback to MockProvider
- **Provider routing** — primary/fallback routing with `executeWithFallback` for resilience
- **Cost tracking** — daily/monthly/per-pipeline budget limits with alert thresholds
- **Pipeline engine integration** — executes pipeline definitions via core `PipelineExecutor`
- **Quality gate evaluation** — LLM-judge, threshold, dimension-check, and custom gates within pipelines or standalone
- **CLI binary** — `media-pipeline-mcp` command to start the server

## Quick Start

```bash
# Start the server
export OPENAI_API_KEY=sk-...
export STABILITY_API_KEY=sk-...
npx @reaatech/media-pipeline-mcp-server start
# Server listening on http://0.0.0.0:8080
```

### Or programmatically:

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

```typescript
class MCPServer {
  constructor(config: ServerConfig);
  start(): Promise<void>;
  stop(): Promise<void>;
  getProviderRegistry(): ProviderRegistry;
  getCostTracker(): CostTracker;
}
```

### `ServerConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `port` | `number` | `8080` | HTTP listen port |
| `host` | `string` | `"0.0.0.0"` | Listen address |
| `logLevel` | `string` | `"info"` | Log level |
| `storage` | `StorageConfig` | `{ type: "local" }` | Storage backend config |
| `providers` | `ProviderConfig[]` | auto-detected | Provider configurations |
| `auth` | `AuthConfig` | — | Authentication config |
| `rateLimit` | `RateLimitConfig` | — | Rate limiting config |
| `budget` | `BudgetConfig` | — | Cost budget limits |

### MCP Tools

#### Image Operations

| Tool | Description |
|------|-------------|
| `image.generate` | Generate an image from a text prompt |
| `image.generate.batch` | Generate multiple images from prompt variations |
| `image.upscale` | Upscale an image to higher resolution |
| `image.remove_background` | Remove background from an image |
| `image.inpaint` | Inpaint or edit parts of an image |
| `image.describe` | Generate a text description of an image |
| `image.resize` | Resize an image to new dimensions |
| `image.crop` | Crop an image to a specific region |
| `image.composite` | Composite overlay one image onto another |
| `image.image_to_image` | Transform an existing image based on a text prompt |

#### Audio Operations

| Tool | Description |
|------|-------------|
| `audio.tts` | Convert text to speech |
| `audio.stt` | Transcribe audio to text |
| `audio.diarize` | Identify speakers in audio |
| `audio.isolate` | Isolate specific audio stems |
| `audio.music` | Generate music from a text prompt |
| `audio.sound_effect` | Generate a sound effect from a text prompt |

#### Video Operations

| Tool | Description |
|------|-------------|
| `video.generate` | Generate a video from a text prompt |
| `video.image_to_video` | Animate an image into a video |
| `video.extract_frames` | Extract frames from a video |
| `video.extract_audio` | Extract audio track from a video |

#### Document Operations

| Tool | Description |
|------|-------------|
| `document.ocr` | Extract text from document images |
| `document.extract_tables` | Extract tables from documents |
| `document.extract_fields` | Extract structured fields from documents |
| `document.summarize` | Summarize document content |

#### Pipeline Operations

| Tool | Description |
|------|-------------|
| `media.pipeline.define` | Validate and preview a pipeline definition |
| `media.pipeline.run` | Execute a pipeline definition |
| `media.pipeline.status` | Check pipeline status |
| `media.pipeline.resume` | Resume a gated/failed pipeline |
| `media.pipeline.templates` | List pre-built pipeline templates |

#### Other Tools

| Tool | Description |
|------|-------------|
| `media.artifact.get` | Retrieve artifact by ID |
| `media.artifact.list` | List artifacts |
| `media.artifact.delete` | Delete artifact |
| `media.providers.list` | List configured providers and health |
| `media.providers.health` | Check provider health |
| `quality_gate.evaluate` | Evaluate an artifact against a quality gate |
| `media.costs.summary` | Get running cost totals |

### Pipeline Execution Example

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
          }
        ]
      }
    }
  }
}
```

### `ProviderRegistry`

```typescript
class ProviderRegistry {
  register(provider: Provider): void;
  getProvider(operation: string): Provider | undefined;
  getAvailability(providerId: string): ProviderAvailability;
  list(): ProviderHealthStatus[];
  getOperations(): Map<string, string>;
}
```

### `ProviderRouter`

```typescript
class ProviderRouter {
  constructor(config: ProviderRouterConfig);
  route(operation: string): Provider;
  executeWithFallback(
    operation: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<ProviderOutput>;
}
```

#### `ProviderRouterConfig`

| Property | Type | Description |
|----------|------|-------------|
| `providers` | `Provider[]` | Registered providers |
| `fallbackProvider` | `Provider` | Fallback when primary is unavailable |
| `routingStrategy` | `"first-available" \| "round-robin"` | Routing strategy (default: first-available) |

### `CostTracker`

```typescript
class CostTracker {
  record(record: CostRecord): void;
  getSummary(): CostSummary;
  getBudgetStatus(): BudgetStatus;
  checkBudget(pipelineId: string, estimatedCost: number): boolean;
}
```

#### `BudgetConfig`

| Property | Type | Description |
|----------|------|-------------|
| `dailyLimit` | `number` | Daily cost limit in USD |
| `monthlyLimit` | `number` | Monthly cost limit in USD |
| `perPipelineLimit` | `number` | Per-pipeline limit in USD |
| `alertThreshold` | `number` | Alert when fraction of limit reached (0–1, default: 0.9) |

#### Budget Statuses

| Status | Meaning |
|--------|---------|
| `ok` | Below alert threshold |
| `warning` | Above alert threshold |
| `critical` | At or above limit |
| `exceeded` | Over limit, operations blocked |

### Response Format

All tool responses follow a consistent format:

```jsonc
// Success
{
  "success": true,
  "content": [{ "type": "text", "text": "Pipeline completed. Artifacts: artifact-123" }],
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

### `ProviderFactory`

```typescript
function createProviders(configs: ProviderConfig[]): Provider[];
function createProviderRouter(config: ProviderRouterConfig): ProviderRouter;
```

Auto-detected providers (via env vars):

| Env Var | Provider Class |
|---------|---------------|
| `STABILITY_API_KEY` | `StabilityProvider` |
| `OPENAI_API_KEY` | `OpenAIProvider` |
| `REPLICATE_API_KEY` | `ReplicateProvider` |
| `FAL_API_KEY` | `FalProvider` |
| `ELEVENLABS_API_KEY` | `ElevenLabsProvider` |
| `DEEPGRAM_API_KEY` | `DeepgramProvider` |
| `ANTHROPIC_API_KEY` | `AnthropicProvider` |
| `GOOGLE_PROJECT_ID` | `GoogleProvider` |

### Provider Auto-Fallback

```typescript
import { createProviderRouter } from "@reaatech/media-pipeline-mcp-server";
import { MockProvider } from "@reaatech/media-pipeline-mcp";
import { OpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";

const router = createProviderRouter({
  providers: [new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! })],
  fallbackProvider: new MockProvider(),
  routingStrategy: "first-available",
});

// If OpenAI is unavailable, falls back to MockProvider
const output = await router.executeWithFallback("image.generate", { prompt: "test" }, {});
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HOST` | `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | Log level |
| `STORAGE_TYPE` | `local` | Storage backend |
| `AUTH_ENABLED` | `false` | Enable authentication |
| `JWT_SECRET` | — | JWT signing secret |
| `API_KEYS` | — | Comma-separated API keys |
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |
| `RATE_LIMIT_RPM` | `60` | Requests per minute |
| `BUDGET_DAILY_LIMIT` | — | Daily budget in USD |
| `BUDGET_MONTHLY_LIMIT` | — | Monthly budget in USD |
| `BUDGET_PER_PIPELINE_LIMIT` | — | Per-pipeline budget in USD |
| `BUDGET_ALERT_THRESHOLD` | `0.9` | Alert threshold |

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline engine
- [`@reaatech/media-pipeline-mcp-security`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security) — Auth, RBAC, rate limiting
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — OpenAI provider
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Stability AI provider

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
