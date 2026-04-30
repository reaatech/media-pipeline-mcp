# @reaatech/media-pipeline-mcp

[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)

> Chainable media operations with quality gates as MCP tools.

An MCP server that exposes AI media operations — image generation, editing, audio processing, video generation, and document extraction — as chainable MCP tools with artifact passing and quality gates between steps.

## Features

- **Chainable pipelines** — compose multi-step media workflows with artifact passing via `{{step.output}}` references
- **Quality gates** — LLM-judge, threshold, dimension-check, and custom evaluators between pipeline steps with retry/fail/warn actions
- **30+ MCP tools** — image generation/editing, audio TTS/STT, video generation, document extraction, pipeline orchestration
- **8 providers** — Stability AI, Replicate, OpenAI, ElevenLabs, Deepgram, Anthropic, Google Cloud, and Fal.ai
- **Multi-backend storage** — local filesystem, AWS S3, and Google Cloud Storage for artifact persistence
- **Enterprise security** — API key and JWT authentication, RBAC, token bucket rate limiting, and SIEM audit logging
- **Resilience patterns** — circuit breaker and retry with exponential backoff for provider calls
- **Observability** — OpenTelemetry tracing, Prometheus metrics, structured JSON logging, and cost reporting
- **Docker & cloud ready** — single-command Docker deployment, AWS ECS Fargate, and GCP Cloud Run support

## Installation

### Using the packages

Packages are published under the `@reaatech` scope and can be installed individually:

```bash
# Core pipeline engine
pnpm add @reaatech/media-pipeline-mcp

# MCP server (includes CLI)
pnpm add @reaatech/media-pipeline-mcp-server

# Storage layer
pnpm add @reaatech/media-pipeline-mcp-storage

# Provider SDKs

pnpm add @reaatech/media-pipeline-mcp-openai
pnpm add @reaatech/media-pipeline-mcp-stability
pnpm add @reaatech/media-pipeline-mcp-replicate
pnpm add @reaatech/media-pipeline-mcp-elevenlabs
pnpm add @reaatech/media-pipeline-mcp-deepgram
pnpm add @reaatech/media-pipeline-mcp-anthropic
pnpm add @reaatech/media-pipeline-mcp-google
pnpm add @reaatech/media-pipeline-mcp-fal

# Enterprise features
pnpm add @reaatech/media-pipeline-mcp-security
pnpm add @reaatech/media-pipeline-mcp-resilience
pnpm add @reaatech/media-pipeline-mcp-observability
```

### Contributing

```bash
# Clone the repository
git clone https://github.com/reaatech/media-pipeline-mcp.git
cd media-pipeline-mcp

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run the test suite
pnpm test

# Run linting
pnpm lint
```

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

// Call pipeline via MCP tool
const result = await server.toolRegistry.handle("media.pipeline.run", {
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
});

console.log(result.status); // "completed"
console.log(result.artifacts); // 2 artifacts
console.log(result.cost_usd); // ~0.012
```

## Packages

| Package | Description |
|---------|-------------|
| [`@reaatech/media-pipeline-mcp`](./packages/core) | Core pipeline engine, types, quality gates, and mock provider |
| [`@reaatech/media-pipeline-mcp-server`](./packages/server) | MCP server with 30+ tools, provider routing, and cost tracking |
| [`@reaatech/media-pipeline-mcp-storage`](./packages/storage) | Artifact persistence (local, S3, GCS) |
| [`@reaatech/media-pipeline-mcp-security`](./packages/security) | Auth (API key/JWT), RBAC, rate limiting, and audit logging |
| [`@reaatech/media-pipeline-mcp-resilience`](./packages/resilience) | Circuit breaker and retry with exponential backoff |
| [`@reaatech/media-pipeline-mcp-observability`](./packages/observability) | OpenTelemetry tracing, metrics, structured logging, cost reporting |
| **Providers** | |
| [`@reaatech/media-pipeline-mcp-provider-core`](./packages/providers/provider-core) | Abstract base class for all provider implementations |
| [`@reaatech/media-pipeline-mcp-openai`](./packages/providers/openai) | OpenAI (DALL-E 3, GPT-4o Vision, TTS-1, Whisper-1) |
| [`@reaatech/media-pipeline-mcp-stability`](./packages/providers/stability) | Stability AI (SD3, SDXL, SD1.5) |
| [`@reaatech/media-pipeline-mcp-replicate`](./packages/providers/replicate) | Replicate (Real-ESRGAN, BRIA RMBG, Demucs, Kling) |
| [`@reaatech/media-pipeline-mcp-fal`](./packages/providers/fal) | Fal.ai (Fast Flux Pro, Real-ESRGAN, Kling) |
| [`@reaatech/media-pipeline-mcp-elevenlabs`](./packages/providers/elevenlabs) | ElevenLabs (text-to-speech with voice customization) |
| [`@reaatech/media-pipeline-mcp-deepgram`](./packages/providers/deepgram) | Deepgram (Nova-2 STT and diarization) |
| [`@reaatech/media-pipeline-mcp-anthropic`](./packages/providers/anthropic) | Anthropic (Claude Vision for OCR, extraction, summarization) |
| [`@reaatech/media-pipeline-mcp-google`](./packages/providers/google) | Google Cloud (Document AI + Vertex AI Gemini) |
| **Operations** | |
| [`@reaatech/media-pipeline-mcp-pipeline`](./packages/operations/pipeline) | Pipeline template management and orchestration |
| [`@reaatech/media-pipeline-mcp-image-edit`](./packages/operations/image-edit) | Image resize, crop, composite (Sharp) + provider delegation |
| [`@reaatech/media-pipeline-mcp-video-gen`](./packages/operations/video-gen) | Video generation, frame extraction, audio extraction |
| [`@reaatech/media-pipeline-mcp-audio-gen`](./packages/operations/audio-gen) | TTS, STT, diarization, source separation, music generation |
| [`@reaatech/media-pipeline-mcp-doc-extraction`](./packages/operations/doc-extraction) | OCR, table extraction, field extraction, summarization |

## Supported Operations

| Category | Operations |
|----------|------------|
| **Image** | `generate`, `upscale`, `remove_background`, `inpaint`, `describe`, `resize`, `crop`, `composite`, `image_to_image` |
| **Audio** | `tts`, `stt`, `diarize`, `isolate`, `music`, `sound_effect` |
| **Video** | `generate`, `image_to_video`, `extract_frames`, `extract_audio` |
| **Document** | `ocr`, `extract_tables`, `extract_fields`, `summarize` |
| **Pipeline** | `define`, `run`, `status`, `resume`, `templates` |
| **Management** | `artifact.get`, `artifact.list`, `artifact.delete`, `providers.list`, `providers.health`, `quality_gate.evaluate`, `costs.summary` |

## Supported Providers

| Provider | Operations | Key Models |
|----------|------------|------------|
| **Stability AI** | `image.generate` | SD3, SDXL, SD1.5 |
| **Replicate** | `image.upscale`, `image.remove_background`, `image.inpaint`, `audio.isolate`, `video.generate`, `video.image_to_video` | Real-ESRGAN, BRIA RMBG, Stable Inpainting, Demucs, Kling |
| **OpenAI** | `image.generate`, `image.describe`, `audio.tts`, `audio.stt` | DALL-E 3, GPT-4o Vision, TTS-1, Whisper-1 |
| **ElevenLabs** | `audio.tts` | ElevenLabs TTS (Rachel, Josh, etc.) |
| **Deepgram** | `audio.stt`, `audio.diarize` | Nova-2 |
| **Anthropic** | `image.describe`, `document.ocr`, `document.extract_tables`, `document.extract_fields`, `document.summarize` | Claude Sonnet |
| **Google Cloud** | `document.ocr`, `document.extract_tables`, `document.extract_fields`, `image.describe` | Document AI, Vertex AI Gemini |
| **Fal.ai** | `image.generate`, `image.upscale`, `image.remove_background`, `video.generate`, `video.image_to_video` | Fast Flux Pro, Real-ESRGAN, Kling |

## Quality Gates

| Type | Description | Use Case |
|------|-------------|----------|
| `llm-judge` | LLM evaluates output quality against a rubric | Subjective quality: "Does this look professional?" |
| `threshold` | Numeric comparisons on artifact metadata | Min/max dimensions, file size limits |
| `dimension-check` | Verify output dimensions match expectations | Format validation: "Is this exactly 1024×1024?" |
| `custom` | User-provided evaluation function | Programmatic or domain-specific checks |

Gates support three actions: `fail` (halt pipeline), `retry` (re-execute step up to maxRetries), and `warn` (log and continue).

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
```

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — System design, package relationships, and data flows
- [`AGENTS.md`](./AGENTS.md) — Agent development guide with pipeline configuration
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — How to add providers, operations, and templates
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — Deployment guides (Docker, AWS, GCP)
- [`SECURITY.md`](./SECURITY.md) — Authentication, authorization, and security policies
- [`COMPLIANCE.md`](./COMPLIANCE.md) — Data handling, PII, and regulatory compliance
- [`docs/TOOL_CATALOG.md`](./docs/TOOL_CATALOG.md) — Complete MCP tool reference
- [`docs/QUALITY_GATES.md`](./docs/QUALITY_GATES.md) — Quality gate configuration guide

## License

[MIT](LICENSE)
