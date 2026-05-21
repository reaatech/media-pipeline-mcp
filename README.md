# @reaatech/media-pipeline-mcp

[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.22-orange)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/test-vitest-green)](https://vitest.dev/)
[![Coverage](https://img.shields.io/badge/coverage-%3E90%25-brightgreen)](https://github.com/reaatech/media-pipeline-mcp)

> **Production-grade MCP server for chainable media operations — image generation, audio processing, video generation, document extraction, and 3D mesh generation. 28 packages. 10 providers. 21 Phase 2 features. > 90% test coverage across 1,800+ tests.**

An MCP server that exposes AI media operations as chainable MCP tools with artifact passing, quality gates, cost discipline, smart routing, multi-tenancy, and C2PA provenance signing.

---

## Why media-pipeline-mcp?

AI agents need media as output — hero images, voiceovers, captioned video, extracted tables, 3D models. Wiring this up yourself means stitching together 8 provider SDKs, building retry logic, tracking costs, caching results, and managing queue depth. This monorepo gives you all of that as 30+ MCP tools, ready to chain into pipelines with per-step quality gates, cost estimates, and idempotent resume.

Phase 2 adds the features that make this production-ready: budget caps, content-addressed cache, smart provider routing, CSV batch generation, default-on safety moderation, and C2PA provenance signing.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   AI Client     │────▶│  media-pipeline  │────▶│   Providers     │
│  (Claude, etc)  │     │      -mcp        │     │ (Stability,     │
└─────────────────┘     │     Server       │     │  Replicate,     │
                        │                  │     │  OpenAI, etc)   │
                        │  ┌────────────┐  │     └─────────────────┘
                        │  │  Pipeline  │  │              ▲
                        │  │   Engine   │  │              │
                        │  └────────────┘  │              │
                        │  ┌────────────┐  │              │
                        │  │  Quality   │  │──────────────┘
                        │  │   Gates    │  │
                        │  └────────────┘  │
                        │  ┌────────────┐  │
                        │  │  Storage   │  │
                        │  │  Layer     │  │
                        │  └────────────┘  │
                        └──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   ┌────────────┐     ┌──────────────┐     ┌──────────────┐
   │  Security  │     │ Persistence  │     │Observability │
   │  + KeyVault│     │ (State+Cost) │     │ (OTel+Prom)  │
   └────────────┘     └──────────────┘     └──────────────┘
```

Data flows: [ARCHITECTURE.md](./ARCHITECTURE.md) covers pipeline execution, artifact passing, event bus, state store, and provider routing in depth.

---

## Features

### Pipeline Engine
- **Chainable pipelines** — compose multi-step media workflows with `{{step.output}}` references
- **Resumable execution** — persist state to pause and resume across process boundaries (F3)
- **Idempotency keys** — identical calls return cached response without re-billing (F1)
- **Content-addressed cache** — `hash(model + prompt + seed + params)` skips re-execution (F2)
- **Budget caps** — per-run and per-tenant cost enforcement with streaming cancellation (F4)
- **Dry-run estimation** — `pipeline.estimate` returns per-step cost bands before spending (F5)
- **Streaming progress** — MCP `$/progress` notifications with coalescing and backpressure (F6)
- **Webhook delivery** — inbound (provider callback) and outbound (caller notification) with HMAC signing (F7)
- **Smart routing** — `first-success`, `cheapest-acceptable`, and `fastest` strategies across providers (F8)
- **A/B variants** — fan out N variants, judge with LLM/CLIP/rules, surface the winner (F9)
- **Aspect-ratio fan-out** — one prompt → 1:1, 9:16, 16:9 with smart-crop fallback (F11)
- **Voice & style context** — define voices and visual styles at pipeline scope, reference by name (F13)
- **CSV batch generation** — one call, hundreds of artifacts, per-row failure isolation (F15)

### Quality & Safety
- **Quality gates** — LLM-judge, threshold, dimension-check, custom, and loudness evaluators between steps
- **Safety moderation** — default-on gate for every moderable operation (F16)
- **Loudness normalization** — two-pass ffmpeg loudnorm with YouTube/Spotify/podcast presets (F14)

### Enterprise
- **Multi-tenant key vault** — per-tenant provider keys via AWS Secrets Manager, GCP Secret Manager, or env (F18)
- **C2PA provenance** — tamper-evident manifests for every generative artifact (F17)
- **Authentication** — JWT and API key with RBAC permissions
- **Rate limiting** — token bucket per-client with configurable RPM and burst
- **Audit logging** — structured JSON events with optional SIEM export (Splunk, Datadog, SumoLogic)
- **Circuit breaker** — automatic failure detection and half-open recovery for provider calls

### Operations
- **30+ MCP tools** — image generation/editing, audio TTS/STT, video generation, document extraction, 3D mesh generation
- **10 providers** — Stability AI, Replicate, OpenAI, ElevenLabs, Deepgram, Anthropic, Google Cloud, Fal.ai, ComfyUI, Ollama
- **Real-time STT** — WebSocket streaming to Deepgram with interim transcripts (F20)
- **Subtitle pipeline** — STT → SRT/VTT/ASS → optional burn-in (F12)

### Observability
- **OpenTelemetry tracing** — spans for every pipeline step, provider call, and gate evaluation
- **Prometheus metrics** — counters, histograms, and gauges for cost, latency, and throughput
- **Structured logging** — JSON logs with `runId`, `tenantId`, `stepId`, `idempotencyKey`
- **Cost reporting** — per-run, per-tenant, and per-provider cost aggregation
- **MCP resources** — artifacts exposed as first-class MCP resource URIs (F19)

### Infrastructure
- **Multi-backend storage** — local filesystem, AWS S3, and Google Cloud Storage
- **State persistence** — in-memory and Redis-backed pipeline state store with optimistic locking
- **Docker & cloud ready** — single-command Docker deployment, AWS ECS Fargate, and GCP Cloud Run
- **Content-addressed artifact cache** — per-provider deterministic param normalization

---

## Installation

### Using published packages

All packages are published under `@reaatech` and can be installed individually:

```bash
# Core pipeline engine
pnpm add @reaatech/media-pipeline-mcp-core

# MCP server (includes CLI + 30+ tools)
pnpm add @reaatech/media-pipeline-mcp-server

# Provider SDKs
pnpm add @reaatech/media-pipeline-mcp-openai
pnpm add @reaatech/media-pipeline-mcp-stability
pnpm add @reaatech/media-pipeline-mcp-replicate
pnpm add @reaatech/media-pipeline-mcp-fal
pnpm add @reaatech/media-pipeline-mcp-elevenlabs
pnpm add @reaatech/media-pipeline-mcp-deepgram
pnpm add @reaatech/media-pipeline-mcp-anthropic
pnpm add @reaatech/media-pipeline-mcp-google

# Local providers (zero API cost)
pnpm add @reaatech/media-pipeline-mcp-ollama
pnpm add @reaatech/media-pipeline-mcp-comfyui

# 3D generation
pnpm add @reaatech/media-pipeline-mcp-meshy
pnpm add @reaatech/media-pipeline-mcp-luma

# Infrastructure packages
pnpm add @reaatech/media-pipeline-mcp-provider-core
pnpm add @reaatech/media-pipeline-mcp-storage
pnpm add @reaatech/media-pipeline-mcp-pipeline
pnpm add @reaatech/media-pipeline-mcp-security
pnpm add @reaatech/media-pipeline-mcp-resilience
pnpm add @reaatech/media-pipeline-mcp-observability
pnpm add @reaatech/media-pipeline-mcp-persistence
pnpm add @reaatech/media-pipeline-mcp-cost
pnpm add @reaatech/media-pipeline-mcp-keyvault
pnpm add @reaatech/media-pipeline-mcp-provenance

# Operation packages
pnpm add @reaatech/media-pipeline-mcp-image-edit
pnpm add @reaatech/media-pipeline-mcp-video-gen
pnpm add @reaatech/media-pipeline-mcp-audio-gen
pnpm add @reaatech/media-pipeline-mcp-doc-extraction
```

### Local development

```bash
git clone https://github.com/reaatech/media-pipeline-mcp.git
cd media-pipeline-mcp
pnpm install        # install all workspace dependencies
pnpm build          # build all packages
pnpm test           # run the full test suite (1,800+ tests)
pnpm lint           # lint and check formatting
pnpm typecheck      # type-check without emitting
```

---

## Quick Start

Start the MCP server with provider auto-detection:

```bash
# Set provider credentials
export OPENAI_API_KEY=sk-...
export STABILITY_API_KEY=sk-...

# Start the server
npx @reaatech/media-pipeline-mcp-server start
# → Server listening on http://0.0.0.0:8080
```

Or run a pipeline programmatically:

```typescript
import { MCPServer, loadConfig } from "@reaatech/media-pipeline-mcp-server";

const config = loadConfig();
const server = new MCPServer(config);
await server.start();
```

Connect from an MCP client and run a pipeline:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-app", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8080"));
await client.connect(transport);

// Dry-run: estimate costs first
const estimate = await client.callTool({
  name: "media.pipeline.estimate",
  arguments: {
    pipeline: {
      id: "product-photo",
      steps: [
        {
          id: "generate",
          operation: "image.generate",
          inputs: { prompt: "Professional product photo of a sneaker" },
          config: { model: "sd3", dimensions: "1024x1024" },
          qualityGate: {
            type: "llm-judge",
            config: { prompt: "Does this look professional?", model: "gpt-4o-mini" },
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
    },
  },
});
console.log(`Estimated cost: $${estimate.totalUsdLow} – $${estimate.totalUsdHigh}`);

// Execute with a budget cap
const result = await client.callTool({
  name: "media.pipeline.run",
  arguments: {
    pipeline: { /* same pipeline definition */ },
    budget: { maxUsd: 0.20, onExceed: "abort" },
  },
});

console.log(result.status);     // "completed"
console.log(result.cost_usd);   // ~0.012
console.log(result.artifacts);  // 2 artifacts
```

---

## Packages

Twenty-eight packages organized by layer:

### Core

| Package | npm | Description |
|---------|-----|-------------|
| [`core`](./packages/core) | `@reaatech/media-pipeline-mcp-core` | Pipeline engine, types, errors, event bus, quality gates, mock provider |
| [`provider-core`](./packages/provider-core) | `@reaatech/media-pipeline-mcp-provider-core` | Abstract base provider, router strategies, cache infrastructure |
| [`pipeline`](./packages/pipeline) | `@reaatech/media-pipeline-mcp-pipeline` | Pipeline operations, batch executor, variants, ratios, context, gates |

### Providers

| Package | npm | Operations |
|---------|-----|------------|
| [`openai`](./packages/openai) | `@reaatech/media-pipeline-mcp-openai` | `image.generate`, `image.describe`, `audio.tts`, `audio.stt` |
| [`stability`](./packages/stability) | `@reaatech/media-pipeline-mcp-stability` | `image.generate` (SD3, SDXL, SD1.5) |
| [`replicate`](./packages/replicate) | `@reaatech/media-pipeline-mcp-replicate` | `image.upscale`, `image.remove_background`, `image.inpaint`, `audio.isolate`, `video.generate`, `video.image_to_video` |
| [`fal`](./packages/fal) | `@reaatech/media-pipeline-mcp-fal` | `image.generate`, `video.generate`, `video.image_to_video` |
| [`elevenlabs`](./packages/elevenlabs) | `@reaatech/media-pipeline-mcp-elevenlabs` | `audio.tts` |
| [`deepgram`](./packages/deepgram) | `@reaatech/media-pipeline-mcp-deepgram` | `audio.stt`, `audio.diarize` |
| [`anthropic`](./packages/anthropic) | `@reaatech/media-pipeline-mcp-anthropic` | `image.describe`, `document.ocr`, `document.extract_tables`, `document.extract_fields`, `document.summarize` |
| [`google`](./packages/google) | `@reaatech/media-pipeline-mcp-google` | `document.ocr`, `document.extract_tables`, `document.extract_fields`, `image.describe` |
| [`ollama`](./packages/ollama) | `@reaatech/media-pipeline-mcp-ollama` | `text.complete`, `embedding.generate`, `image.describe` (zero-cost local) |
| [`comfyui`](./packages/comfyui) | `@reaatech/media-pipeline-mcp-comfyui` | `image.generate`, `image.edit`, `video.generate` (zero-cost local) |
| [`meshy`](./packages/meshy) | `@reaatech/media-pipeline-mcp-meshy` | `mesh.generate` (text-to-3D, image-to-3D) |
| [`luma`](./packages/luma) | `@reaatech/media-pipeline-mcp-luma` | `mesh.generate` (text-to-3D via Genie) |

### Operations

| Package | npm | Description |
|---------|-----|-------------|
| [`image-edit`](./packages/image-edit) | `@reaatech/media-pipeline-mcp-image-edit` | Resize, crop, composite, inpaint, background removal |
| [`video-gen`](./packages/video-gen) | `@reaatech/media-pipeline-mcp-video-gen` | Video generation, frame extraction, subtitles, ffmpeg wrapper |
| [`audio-gen`](./packages/audio-gen) | `@reaatech/media-pipeline-mcp-audio-gen` | TTS, STT, diarization, source separation, music, stream transcribe |
| [`doc-extraction`](./packages/doc-extraction) | `@reaatech/media-pipeline-mcp-doc-extraction` | OCR, table extraction, field extraction, summarization |

### Infrastructure

| Package | npm | Description |
|---------|-----|-------------|
| [`server`](./packages/server) | `@reaatech/media-pipeline-mcp-server` | MCP server, CLI, tool registry, idempotency, streaming, webhooks, tenant context |
| [`storage`](./packages/storage) | `@reaatech/media-pipeline-mcp-storage` | Artifact persistence (local, S3, GCS) |
| [`persistence`](./packages/persistence) | `@reaatech/media-pipeline-mcp-persistence` | Pipeline state store (in-memory + Redis) with optimistic locking |
| [`cost`](./packages/cost) | `@reaatech/media-pipeline-mcp-cost` | Cost ledger with micro-USD precision and tenant-scoped queries |
| [`keyvault`](./packages/keyvault) | `@reaatech/media-pipeline-mcp-keyvault` | Multi-tenant API key vault (AWS, GCP, env, in-memory) |
| [`provenance`](./packages/provenance) | `@reaatech/media-pipeline-mcp-provenance` | C2PA content provenance signing for AI-generated media |
| [`security`](./packages/security) | `@reaatech/media-pipeline-mcp-security` | Auth (JWT/API key), RBAC, rate limiting, audit logging |
| [`resilience`](./packages/resilience) | `@reaatech/media-pipeline-mcp-resilience` | Circuit breaker and retry with exponential backoff |
| [`observability`](./packages/observability) | `@reaatech/media-pipeline-mcp-observability` | OpenTelemetry tracing, Prometheus metrics, structured logging, cost reporting |

---

## Supported Operations

47 operations across 6 domains, exposed as MCP tools:

| Category | Operations |
|----------|------------|
| **Image** | `generate`, `generate.batch`, `upscale`, `remove_background`, `inpaint`, `describe`, `resize`, `crop`, `composite`, `image_to_image` |
| **Audio** | `tts`, `stt`, `diarize`, `isolate`, `music`, `sound_effect`, `transcribeStream` |
| **Video** | `generate`, `image_to_video`, `extract_frames`, `extract_audio`, `subtitle` |
| **Document** | `ocr`, `extract_tables`, `extract_fields`, `summarize` |
| **Mesh** | `generate` (text-to-3D, image-to-3D via Meshy and Luma) |
| **Pipeline** | `define`, `run`, `estimate`, `status`, `resume`, `cancel`, `subscribe`, `templates`, `batch`, `batch.status`, `batch.retry`, `batch.cancel` |
| **Management** | `artifact.get`, `artifact.list`, `artifact.delete`, `providers.list`, `providers.health`, `quality_gate.evaluate`, `costs.summary` |

---

## Quality Gates

| Type | Description | Use Case |
|------|-------------|----------|
| `llm-judge` | LLM evaluates output quality against a rubric | Subjective quality: "Does this look professional?" |
| `threshold` | Numeric comparisons on artifact metadata | Min/max dimensions, file size limits |
| `dimension-check` | Verify output dimensions match expectations | Format validation: "Is this exactly 1024×1024?" |
| `custom` | User-provided evaluation function | Programmatic or domain-specific checks |
| `loudness` | Measure and normalize audio to broadcast spec | YouTube, Spotify, podcast LUFS targets |
| `safety` | Content moderation (default-on for generative ops) | NSFW, violence, CSAM detection |

Gates support three actions: `fail` (halt pipeline), `retry` (re-execute step up to `maxRetries`), and `warn` (log and continue).

---

## Examples

Runnable examples in the [`examples/`](./examples/) directory:

| Example | Features | Description |
|---------|----------|-------------|
| [`01-dry-run-then-execute`](./examples/01-dry-run-then-execute.ts) | F4, F5 | Estimate pipeline costs before spending; abort on budget exceed |
| [`02-cheapest-routing-with-fallback`](./examples/02-cheapest-routing-with-fallback.ts) | F8, F2 | Smart provider routing across 3 candidates with cache-hit rebate |
| [`03-ab-variants-with-judge`](./examples/03-ab-variants-with-judge.ts) | F9 | Fan out 4 variants, judge by LLM and rule, surface winner |
| [`04-resumable-long-running`](./examples/04-resumable-long-running.ts) | F1, F3 | Resume a failed pipeline without re-paying for completed steps |
| [`05-batch-1000-blog-heroes`](./examples/05-batch-1000-blog-heroes/) | F15, F4 | CSV-driven batch generation with per-row budget and retry |
| [`06-aspect-ratio-fanout`](./examples/06-aspect-ratio-fanout.ts) | F11 | One prompt → 1:1, 9:16, 16:9 with smart-crop fallback |
| [`07-voice-style-narration`](./examples/07-voice-style-narration-with-burned-captions.ts) | F12, F13, F14 | Voice refs, style refs, loudness normalization, burned captions |
| [`12-safety-gate-default-on`](./examples/12-safety-gate-default-on.ts) | F16 | Default-on safety moderation with explicit opt-out |
| [`product-photo-pipeline`](./examples/product-photo-pipeline.ts) | — | Classic generate → upscale → remove background pipeline |
| [`standalone-tool-calls`](./examples/standalone-tool-calls.ts) | — | Use media tools directly without pipeline orchestration |
| [`podcast-clip-pipeline`](./examples/podcast-clip-pipeline.ts) | — | Multi-step audio pipeline (TTS → STT → diarize) |
| [`document-intake-pipeline`](./examples/document-intake-pipeline.ts) | — | OCR → extract tables → extract fields → summarize |
| [`agent-mesh-integration`](./examples/agent-mesh-integration.ts) | — | Agent-driven pipeline with provider health checks |

---

## Configuration

The server is configured via environment variables:

```bash
# Provider credentials (auto-detected — only set what you need)
OPENAI_API_KEY=sk-...
STABILITY_API_KEY=sk-...
REPLICATE_API_KEY=r8_...
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=sk-ant_...
FAL_API_KEY=...
GOOGLE_PROJECT_ID=my-gcp-project

# Server
PORT=8080
HOST=0.0.0.0
LOG_LEVEL=info

# Storage (default: local)
STORAGE_TYPE=local
# STORAGE_TYPE=s3       # For S3: set S3_BUCKET, S3_REGION
# STORAGE_TYPE=gcs      # For GCS: set GCS_BUCKET

# Security
AUTH_ENABLED=false
JWT_SECRET=your-secret-key
API_KEYS=key1,key2,key3

# Rate limiting & Budget
RATE_LIMIT_RPM=60
BUDGET_DAILY_LIMIT=100
BUDGET_MONTHLY_LIMIT=2000

# Webhooks
REPLICATE_WEBHOOK_SECRET=...
FAL_WEBHOOK_SECRET=...
DEEPGRAM_WEBHOOK_SECRET=...

# Local providers (zero-cost)
OLLAMA_BASE_URL=http://localhost:11434
COMFYUI_BASE_URL=http://localhost:8188

# Feature flags (defaults for Phase 2)
FEATURE_ROUTING=false
FEATURE_CONTENT_CACHE=false
FEATURE_RESUMABLE_PIPELINES=false
FEATURE_WEBHOOKS=false
FEATURE_STREAMING=false
FEATURE_VARIANTS=false
FEATURE_BATCH=false
FEATURE_MULTI_TENANT=false
FEATURE_PROVENANCE=false
FEATURE_MCP_RESOURCES=false
FEATURE_STT_STREAM=false
```

---

## Documentation

| Document | Content |
|----------|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, package boundaries, data flows |
| [PHASE2_DEV_PLAN.md](./PHASE2_DEV_PLAN.md) | Complete Phase 2 specification — 21 features, types, test matrices |
| [DEV_PLAN.md](./DEV_PLAN.md) | Development checklist organized by shippable phases |
| [AGENTS.md](./AGENTS.md) | Agent development guide with pipeline configuration and provider setup |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development setup, conventional commits, adding providers |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deployment patterns (Docker, AWS, GCP, Cloud Run) |
| [COMPLIANCE.md](./COMPLIANCE.md) | Compliance, certifications, and regulatory requirements |
| [SECURITY.md](./SECURITY.md) | Security controls, vulnerability reporting, and RBAC |
| [docs/TOOL_CATALOG.md](./docs/TOOL_CATALOG.md) | Complete MCP tool reference (47 tools) |
| [docs/QUALITY_GATES.md](./docs/QUALITY_GATES.md) | Quality gate configuration guide |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.8 (strict mode) |
| Runtime | Node.js ≥ 18 |
| Package manager | pnpm 10 (workspaces) |
| Build | tsup + Turborepo |
| Lint & format | Biome |
| Testing | Vitest (1,800+ tests, > 90% coverage) |
| Validation | Zod |
| Transport | MCP StreamableHTTP (JSON-RPC 2.0) |
| Persistence | In-memory / Redis |
| Tracing | OpenTelemetry |
| Versioning | Changesets |

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow:

1. Fork the repo, create a feature branch
2. Write code with tests (`vitest`), lint with `biome`
3. Run `pnpm lint && pnpm typecheck && pnpm test` before committing
4. Use [Conventional Commits](https://www.conventionalcommits.org/)
5. Open a PR

Coding conventions and project guidance live in [AGENTS.md](./AGENTS.md).

---

## License

[MIT](./LICENSE) © [Rick Somers](https://reaatech.com)
