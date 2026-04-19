---
agent_id: "media-pipeline-mcp"
display_name: "Media Pipeline MCP"
version: "0.1.0"
description: "MCP server for media processing pipeline orchestration"
type: "mcp"
confidence_threshold: 0.9
---

# media-pipeline-mcp — Agent Development Guide

## What this is

This document defines how to build, configure, and deploy AI agents that use the `media-pipeline-mcp` server for media operations. It covers pipeline configuration, provider setup, quality gates, and integration patterns for creating chainable media workflows.

**Target audience:** Engineers building AI agents that need media generation, editing, and processing capabilities through MCP tools, platform teams integrating media pipelines into multi-agent systems, and SREs deploying media infrastructure at scale.

---

## Architecture Overview

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
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Pipeline Engine** | `packages/core/` | Sequential step execution with artifact passing |
| **Provider Framework** | `packages/providers/` | Unified interface for all media providers |
| **Storage Layer** | `packages/storage/` | Artifact persistence (local, S3, GCS) |
| **Quality Gates** | `packages/core/quality-gates/` | Output validation between steps |
| **MCP Server** | `packages/server/` | Tool registration and HTTP transport |
| **Cost Tracker** | `packages/core/cost-tracker/` | Per-call cost recording and aggregation |

---

## Skill System

Skills represent the atomic capabilities of media-pipeline-mcp. Each skill corresponds to a media operation or pipeline capability.

### Available Skills

| Skill ID | File | Description |
|----------|------|-------------|
| `pipeline-execution` | `skills/pipeline-execution/skill.md` | Execute pipeline definitions with artifact passing |
| `quality-gates` | `skills/quality-gates/skill.md` | Quality gate evaluation (LLM-judge, threshold, dimension-check) |
| `artifact-management` | `skills/artifact-management/skill.md` | Artifact storage, retrieval, and lifecycle |
| `provider-management` | `skills/provider-management/skill.md` | Provider registration, health checks, routing |
| `cost-tracking` | `skills/cost-tracking/skill.md` | Per-call cost recording and aggregation |
| `image-generation` | `skills/image-generation/skill.md` | Text-to-image, image-to-image operations |
| `image-editing` | `skills/image-editing/skill.md` | Upscale, background removal, inpaint, resize, crop |
| `audio-generation` | `skills/audio-generation/skill.md` | TTS, music generation, sound effects |
| `audio-transcription` | `skills/audio-transcription/skill.md` | STT, transcription, diarization |
| `video-generation` | `skills/video-generation/skill.md` | Text-to-video, image-to-video |
| `document-extraction` | `skills/document-extraction/skill.md` | OCR, table extraction, field extraction |
| `pipeline-templates` | `skills/pipeline-templates/skill.md` | Pre-built pipeline templates |

---

## MCP Integration

The server exposes MCP tools for media operations. All tools follow the MCP protocol with StreamableHTTP transport.

### Tool Categories

#### Image Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `image.generate` | Generate an image from a text prompt | `{ prompt: string, negative_prompt?: string, dimensions?: string, aspect_ratio?: string, style_preset?: string, seed?: number, num_outputs?: number, model?: string }` |
| `image.generate.batch` | Generate multiple images from prompt variations | `{ prompts: string[], negative_prompt?: string, dimensions?: string, aspect_ratio?: string, style_preset?: string, num_variations?: number }` |
| `image.upscale` | Upscale an image to higher resolution | `{ artifact_id: string, scale: "2x" \| "4x" \| "8x", model?: string }` |
| `image.remove_background` | Remove background from an image | `{ artifact_id: string, output_format?: "png" \| "webp" }` |
| `image.inpaint` | Inpaint or edit parts of an image | `{ artifact_id: string, mask_artifact_id?: string, prompt: string, negative_prompt?: string }` |
| `image.describe` | Generate a text description of an image | `{ artifact_id: string, detail?: "brief" \| "detailed" \| "structured" }` |
| `image.resize` | Resize an image to new dimensions | `{ artifact_id: string, dimensions: string, fit?: "cover" \| "contain" \| "fill" }` |
| `image.crop` | Crop an image to a specific region | `{ artifact_id: string, x: number, y: number, width: number, height: number }` |
| `image.composite` | Composite overlay one image onto another | `{ base_artifact_id: string, overlay_artifact_id: string, position?: string, opacity?: number, blend_mode?: string }` |
| `image.image_to_image` | Transform an existing image based on a text prompt | `{ artifact_id: string, prompt: string, negative_prompt?: string, strength?: number, dimensions?: string, seed?: number }` |

#### Audio Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `audio.tts` | Convert text to speech | `{ text: string, voice?: string, speed?: number, output_format?: "mp3" \| "wav" \| "opus" }` |
| `audio.stt` | Transcribe audio to text | `{ artifact_id: string, language?: string, diarize?: boolean }` |
| `audio.diarize` | Identify speakers in audio | `{ artifact_id: string, num_speakers?: number }` |
| `audio.isolate` | Isolate specific audio stems | `{ artifact_id: string, target: "vocals" \| "instruments" \| "drums" \| "bass" }` |
| `audio.music` | Generate music from a text prompt | `{ prompt: string, duration?: number, instrumental?: boolean, style?: string, tempo?: number, format?: "mp3" \| "wav" \| "ogg" }` |
| `audio.sound_effect` | Generate a sound effect from a text prompt | `{ prompt: string, duration?: number, format?: "mp3" \| "wav" \| "ogg" }` |

#### Video Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `video.generate` | Generate a video from a text prompt | `{ prompt: string, duration?: number, aspect_ratio?: string, style?: string }` |
| `video.image_to_video` | Animate an image into a video | `{ artifact_id: string, motion_prompt?: string, duration?: number }` |
| `video.extract_frames` | Extract frames from a video | `{ artifact_id: string, interval?: number, timestamps?: number[] }` |
| `video.extract_audio` | Extract audio track from a video | `{ artifact_id: string, format?: "mp3" \| "wav" \| "aac" }` |

#### Document Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `document.ocr` | Extract text from document images | `{ artifact_id: string, output_format?: "plain_text" \| "structured_json" \| "markdown" }` |
| `document.extract_tables` | Extract tables from documents | `{ artifact_id: string, output_format?: "markdown" \| "json" }` |
| `document.extract_fields` | Extract structured fields from documents | `{ artifact_id: string, field_schema: object }` |
| `document.summarize` | Summarize document content | `{ artifact_id: string, length?: "short" \| "medium" \| "long" \| "detailed", style?: string }` |

#### Pipeline Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `media.pipeline.define` | Validate and preview a pipeline definition | `{ pipeline: PipelineDefinition }` |
| `media.pipeline.run` | Execute a pipeline definition | `{ pipeline: PipelineDefinition \| string }` |
| `media.pipeline.status` | Check pipeline status | `{ pipeline_id: string }` |
| `media.pipeline.resume` | Resume a gated/failed pipeline | `{ pipeline_id: string, action: 'retry' \| 'skip' \| 'abort' }` |
| `media.pipeline.templates` | List pre-built pipeline templates | `{}` |

#### Artifact Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `media.artifact.get` | Retrieve artifact by ID | `{ artifact_id: string }` |
| `media.artifact.list` | List artifacts | `{ prefix?: string, limit?: number }` |
| `media.artifact.delete` | Delete artifact | `{ artifact_id: string }` |

#### Provider Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `media.providers.list` | List configured providers and health | `{}` |
| `media.providers.health` | Check provider health | `{ provider_id: string }` |

#### Quality Gate Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `quality_gate.evaluate` | Evaluate an artifact against a quality gate | `{ artifact_id: string, gate: QualityGate }` |

#### Cost Operations

| Tool | Description | Input Schema |
|------|-------------|--------------|
| `media.costs.summary` | Get running cost totals | `{}` |

### Request/Response Format

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "request-123",
  "method": "tools/call",
  "params": {
    "name": "media.pipeline.run",
    "arguments": {
      "pipeline": {
        "id": "my-pipeline",
        "steps": [
          {
            "id": "step1",
            "operation": "image.generate",
            "inputs": { "prompt": "A sunset over mountains" },
            "config": { "model": "sd3", "dimensions": "1024x1024" }
          }
        ]
      }
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "request-123",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Pipeline completed successfully. Artifacts: artifact-123, artifact-456"
      }
    ],
    "pipeline_id": "my-pipeline",
    "status": "completed",
    "artifacts": [
      {
        "id": "artifact-123",
        "type": "image",
        "uri": "s3://bucket/artifacts/artifact-123.png",
        "sourceStep": "step1"
      }
    ],
    "cost_usd": 0.014,
    "duration_ms": 4523
  }
}
```

### Error Response Format

All tool responses follow a standard format. On success, the response includes `{ success: true }`. On error, the response includes `{ success: false, error: "error message" }`:

```json
{
  "jsonrpc": "2.0",
  "id": "request-123",
  "result": {
    "success": true,
    "content": [{ "type": "text", "text": "Operation completed" }]
  }
}
```

Error response:
```json
{
  "jsonrpc": "2.0",
  "id": "request-123",
  "result": {
    "success": false,
    "error": "Artifact not found: invalid-id"
  }
}
```

---

## Pipeline Configuration

### Pipeline Definition Schema

```typescript
interface PipelineDefinition {
  id: string;
  steps: PipelineStep[];
}

interface PipelineStep {
  id: string;
  operation: string;              // e.g. 'image.generate', 'image.upscale'
  inputs: Record<string, string>; // param name → artifact ID or literal
  config: Record<string, unknown>;
  qualityGate?: QualityGate;
}

interface QualityGate {
  type: 'llm-judge' | 'threshold' | 'dimension-check' | 'custom';
  config: Record<string, unknown>;
  action: 'fail' | 'retry' | 'warn';
  maxRetries?: number;
}
```

### Example: Product Photo Pipeline

```json
{
  "id": "product-photo",
  "steps": [
    {
      "id": "generate",
      "operation": "image.generate",
      "inputs": {
        "prompt": "Professional product photo of a white sneaker on a clean background"
      },
      "config": {
        "model": "sd3",
        "dimensions": "1024x1024",
        "negative_prompt": "blurry, low quality"
      },
      "qualityGate": {
        "type": "llm-judge",
        "config": {
          "prompt": "Does this image look like a professional product photo? Is the product clearly visible?",
          "model": "gpt-4o-mini"
        },
        "action": "retry",
        "maxRetries": 2
      }
    },
    {
      "id": "upscale",
      "operation": "image.upscale",
      "inputs": {
        "artifact_id": "{{generate.output}}"
      },
      "config": {
        "scale": "4x",
        "model": "real-esrgan"
      }
    },
    {
      "id": "remove_bg",
      "operation": "image.remove_background",
      "inputs": {
        "artifact_id": "{{upscale.output}}"
      }
    }
  ]
}
```

### Variable Interpolation

Use `{{step_id.output}}` to reference outputs from previous steps:

```json
{
  "id": "social-media-kit",
  "steps": [
    {
      "id": "generate",
      "operation": "image.generate",
      "inputs": { "prompt": "A modern logo for a tech startup" },
      "config": { "dimensions": "1024x1024" }
    },
    {
      "id": "resize_square",
      "operation": "image.resize",
      "inputs": { "artifact_id": "{{generate.output}}" },
      "config": { "dimensions": "1080x1080" }
    },
    {
      "id": "resize_story",
      "operation": "image.resize",
      "inputs": { "artifact_id": "{{generate.output}}" },
      "config": { "dimensions": "1080x1920" }
    },
    {
      "id": "resize_banner",
      "operation": "image.resize",
      "inputs": { "artifact_id": "{{generate.output}}" },
      "config": { "dimensions": "1500x500" }
    }
  ]
}
```

---

## Provider Configuration

### Config File Structure

Providers are configured via environment variables and the `providers` array in config:

```typescript
// Environment variables
STABILITY_API_KEY=sk_...
REPLICATE_API_KEY=r8_...
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
GOOGLE_PROJECT_ID=my-gcp-project
GOOGLE_LOCATION=us-central1
GOOGLE_DOCUMENT_AI_PROCESSOR_ID=processor-id
GOOGLE_GEMINI_MODEL=gemini-1.5-pro
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

// Provider operations are mapped via the providers config
// Providers are auto-discovered from the operations they support
```

### Provider Routing

The system routes operations to providers based on:
1. Provider capabilities (which operations it supports)
2. Provider availability and health
3. Cost and performance considerations

Supported operations per provider:
- **Stability**: `image.generate`
- **Replicate**: `image.upscale`, `image.remove_background`, `image.inpaint`, `audio.isolate`, `video.generate`, `video.image_to_video`
- **OpenAI**: `image.generate`, `image.describe`, `audio.tts`, `audio.stt`
- **ElevenLabs**: `audio.tts`
- **Deepgram**: `audio.stt`, `audio.diarize`
- **Google**: `document.ocr`, `document.extract_tables`, `document.extract_fields`, `image.describe`
- **Anthropic**: `image.describe`, `document.ocr`, `document.extract_tables`, `document.extract_fields`, `document.summarize`
- **Fal**: `image.generate`, `image.upscale`, `image.remove_background`, `video.generate`, `video.image_to_video`

### Health Checks

Provider health is monitored via `/health/providers`:

```bash
# Check all providers
curl http://localhost:8080/health/providers

# Check specific provider
curl http://localhost:8080/health/providers/stability
```

---

## Storage Configuration

### Local Filesystem (Development)

```typescript
storage: {
  type: 'local',
  basePath: './artifacts',
  ttl: '24h',  // Auto-cleanup after 24 hours
  serveHttp: true,  // Serve artifacts via HTTP
  httpPort: 3001
}
```

### S3 (Production - AWS)

```typescript
storage: {
  type: 's3',
  bucket: 'my-media-artifacts',
  region: 'us-east-1',
  prefix: 'pipelines/',
  lifecycle: {
    expiration: 7  // Days before auto-deletion
  }
}
```

### GCS (Production - GCP)

```typescript
storage: {
  type: 'gcs',
  bucket: 'my-media-artifacts',
  prefix: 'pipelines/',
  lifecycle: {
    age: 7  // Days before auto-deletion
  }
}
```

---

## Quality Gates

### LLM-Judge Gate

Uses an LLM to evaluate output quality:

```json
{
  "type": "llm-judge",
  "config": {
    "prompt": "Evaluate this image on a scale of 1-10 for: relevance to prompt, visual quality, and composition. Return a JSON object with scores and a 'pass' boolean (pass if average score >= 7).",
    "model": "gpt-4o-mini",
    "timeout": 30000
  },
  "action": "retry",
  "maxRetries": 2
}
```

### Threshold Gate

Numeric checks on artifact metadata:

```json
{
  "type": "threshold",
  "config": {
    "checks": [
      { "field": "metadata.width", "operator": ">=", "value": 1024 },
      { "field": "metadata.height", "operator": ">=", "value": 1024 },
      { "field": "metadata.fileSize", "operator": "<", "value": 10485760 }
    ]
  },
  "action": "fail"
}
```

### Dimension-Check Gate

Verify output dimensions match expectations:

```json
{
  "type": "dimension-check",
  "config": {
    "expectedWidth": 1024,
    "expectedHeight": 1024,
    "tolerance": 0.05  // 5% tolerance
  },
  "action": "warn"
}
```

### Custom Gate

Custom evaluation function for specialized checks:

```json
{
  "type": "custom",
  "config": {
    "customCheckFn": "async (artifact, context) => { return { pass: true, score: 1.0 }; }"
  },
  "action": "fail"
}
```

### Standalone Quality Gate Evaluation

Use the `quality_gate.evaluate` tool to evaluate an artifact against any quality gate outside of a pipeline:

```json
{
  "name": "quality_gate.evaluate",
  "arguments": {
    "artifact_id": "my-image-123",
    "gate": {
      "type": "llm-judge",
      "config": {
        "prompt": "Is this image appropriate for commercial use?",
        "model": "gpt-4o-mini"
      },
      "action": "fail"
    }
  }
}
```

---

## Security Considerations

### Authentication

The server supports JWT-based authentication and API key validation:

```bash
# Enable authentication
AUTH_ENABLED=true
JWT_SECRET=your-secret-key

# Or with API keys
AUTH_ENABLED=true
API_KEYS=key1,key2,key3
```

**JWT Token format:**
```bash
# Include in request header
Authorization: Bearer <jwt_token>
```

**API Key format:**
```bash
# Include in request header
X-API-Key: <api_key>
```

### Authorization (RBAC)

Permissions control access to operations:

| Permission | Description |
|------------|-------------|
| `pipeline:run` | Execute pipelines |
| `pipeline:define` | Define new pipelines |
| `artifact:read` | Read artifacts |
| `artifact:write` | Write artifacts |
| `artifact:delete` | Delete artifacts |
| `cost:read` | View cost information |
| `provider:read` | View provider status |
| `admin` | Full access |

### API Key Management

- **Never** hardcode API keys in configuration files
- Use environment variables or secrets manager
- Rotate keys regularly via secrets manager integration

### PII Handling

- **Never** include personal data in prompts or artifacts
- Redact PII from logs automatically
- Use placeholder values in examples

### Rate Limiting

Rate limiting is configurable via environment variables:

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_RPM=60        # Requests per minute per client
RATE_LIMIT_BURST=10      # Burst size
EXPENSIVE_OPS_RPM=10     # Expensive operations per minute
```

### Input Validation

- All tool inputs validated with Zod schemas
- File types validated by magic bytes, not just extension
- Size limits enforced on uploads
- Artifact IDs validated for path traversal characters

### Content Safety

- Prompt screening for prohibited content
- Output moderation for NSFW detection
- Configurable safety policies per tenant

### Rate Limiting

**IMPORTANT**: Rate limiting is implemented in the server but requires HTTP-level client identification. For production:

1. Configure rate limiting at the API gateway layer
2. Ensure `X-Client-ID` header is forwarded by the gateway
3. The server's rate limiter provides per-client tracking when proper headers are available

Server-side rate limiting is available but may not work correctly without gateway-level client identification.

---

## Observability

### Structured Logging

All operations logged with structured JSON:

```json
{
  "timestamp": "2026-04-15T23:00:00Z",
  "service": "media-pipeline-mcp",
  "pipeline_id": "pipeline-123",
  "step_id": "step-1",
  "operation": "image.generate",
  "provider": "stability-ai",
  "artifact_id": "artifact-456",
  "cost_usd": 0.007,
  "duration_ms": 2345,
  "quality_gate": {
    "type": "llm-judge",
    "result": "pass"
  },
  "request_id": "req-789"
}
```

### OpenTelemetry Tracing

Every pipeline execution generates a trace:

```typescript
// Custom span attributes
span.setAttribute('media.operation', 'image.generate');
span.setAttribute('media.provider', 'stability-ai');
span.setAttribute('media.cost_usd', 0.007);
span.setAttribute('media.artifact_id', 'artifact-456');
```

### Metrics

Key metrics exposed:

| Metric | Type | Description |
|--------|------|-------------|
| `media.operation.duration_ms` | Histogram | Operation latency by type and provider |
| `media.operation.cost_usd` | Histogram | Cost per operation |
| `media.pipeline.duration_ms` | Histogram | End-to-end pipeline time |
| `media.quality_gate.pass_rate` | Gauge | Quality gate pass rate by type |
| `media.provider.error_rate` | Gauge | Provider error rate |

---

## Testing

### Unit Tests

```typescript
import { describe, it, expect } from 'vitest';
import { executePipeline } from '../src/core/pipeline-executor';
import { mockProvider } from '../src/providers/mock';

describe('pipeline-execution', () => {
  it('should execute 3-step pipeline successfully', async () => {
    const pipeline = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {}
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {}
        },
        {
          id: 'step3',
          operation: 'mock.extract',
          inputs: { artifact_id: '{{step2.output}}' },
          config: {}
        }
      ]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(3);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should halt on quality gate failure', async () => {
    const pipeline = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }] },
            action: 'fail'
          }
        }
      ]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('gated');
    expect(result.gatedStep).toBe('step1');
  });
});
```

### Integration Tests

```typescript
describe('MCP server integration', () => {
  it('should execute pipeline via MCP tool call', async () => {
    const response = await fetch('http://localhost:8080/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'tools/call',
        params: {
          name: 'media.pipeline.run',
          arguments: {
            pipeline: {
              id: 'test',
              steps: [{
                id: 'step1',
                operation: 'mock.generate',
                inputs: { prompt: 'test' },
                config: {}
              }]
            }
          }
        }
      })
    });

    const result = await response.json();
    expect(result.result.status).toBe('completed');
  });
});
```

---

## Deployment

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | no | `8080` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen host |
| `NODE_ENV` | no | `development` | Environment name |
| `STABILITY_API_KEY` | conditional | — | Stability AI API key |
| `REPLICATE_API_KEY` | conditional | — | Replicate API key |
| `OPENAI_API_KEY` | conditional | — | OpenAI API key |
| `ELEVENLABS_API_KEY` | conditional | — | ElevenLabs API key |
| `DEEPGRAM_API_KEY` | conditional | — | Deepgram API key |
| `ANTHROPIC_API_KEY` | conditional | — | Anthropic API key |
| `GOOGLE_PROJECT_ID` | conditional | — | Google Cloud project ID for the Google provider |
| `GOOGLE_LOCATION` | no | `us-central1` | Google Cloud location for Vertex AI / Document AI |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | no | — | Document AI processor ID |
| `GOOGLE_GEMINI_MODEL` | no | — | Gemini model override for image description |
| `GOOGLE_KEY_FILE` | no | — | Google service account JSON path |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | — | Standard Google credentials env var |
| `FAL_API_KEY` | conditional | — | Fal API key |
| `STORAGE_TYPE` | no | `local` | Storage backend (local/s3/gcs) |
| `S3_BUCKET` | conditional | — | S3 bucket name |
| `S3_REGION` | no | `us-east-1` | S3 region |
| `S3_PREFIX` | no | `artifacts/` | S3 key prefix |
| `GCS_BUCKET` | conditional | — | GCS bucket name |
| `GCS_PREFIX` | no | `artifacts/` | GCS key prefix |
| `STORAGE_PATH` | no | `./artifacts` | Local storage path |
| `STORAGE_TTL` | no | — | TTL in seconds for local storage |
| `STORAGE_SERVE_HTTP` | no | `false` | Serve artifacts via HTTP |
| `AUTH_ENABLED` | no | `false` | Enable authentication |
| `JWT_SECRET` | conditional | — | JWT secret for auth |
| `API_KEYS` | conditional | — | Comma-separated API keys |
| `RATE_LIMIT_ENABLED` | no | `true` | Enable rate limiting |
| `RATE_LIMIT_RPM` | no | `60` | Requests per minute per client |
| `RATE_LIMIT_BURST` | no | `10` | Burst size |
| `EXPENSIVE_OPS_RPM` | no | `10` | Expensive operations per minute |
| `BUDGET_DAILY_LIMIT` | no | — | Daily budget limit in USD |
| `BUDGET_MONTHLY_LIMIT` | no | — | Monthly budget limit in USD |
| `BUDGET_PER_PIPELINE_LIMIT` | no | — | Per-pipeline budget limit in USD |
| `BUDGET_ALERT_THRESHOLD` | no | `0.9` | Alert threshold (0-1) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | OTel collector endpoint |
| `LOG_LEVEL` | no | `info` | Log level (error/warn/info/debug) |

### Docker

```bash
# Build
docker build -t media-pipeline-mcp .

# Run with local storage
docker run -p 8080:8080 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e STORAGE_TYPE=local \
  media-pipeline-mcp

# Run with S3 storage
docker run -p 8080:8080 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e STABILITY_API_KEY=$STABILITY_API_KEY \
  -e STORAGE_TYPE=s3 \
  -e S3_BUCKET=my-bucket \
  -e S3_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY \
  media-pipeline-mcp
```

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'
services:
  media-pipeline-mcp:
    build: .
    ports:
      - "8080:8080"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - STABILITY_API_KEY=${STABILITY_API_KEY}
      - STORAGE_TYPE=local
    volumes:
      - ./artifacts:/app/artifacts

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data

volumes:
  minio_data:
```

### AWS ECS Fargate

```bash
# Deploy to ECS
terraform -chdir=infra/aws apply

# Or manually:
aws ecs create-service \
  --cluster media-pipeline \
  --service-name media-pipeline-mcp \
  --task-definition media-pipeline-mcp:1 \
  --desired-count 1 \
  --launch-type FARGATE
```

### GCP Cloud Run

```bash
gcloud run deploy media-pipeline-mcp \
  --image gcr.io/$PROJECT_ID/media-pipeline-mcp:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars OPENAI_API_KEY=$OPENAI_API_KEY \
  --set-secrets STABILITY_API_KEY=stability-api-key:latest
```

---

## Checklist: Production Readiness

Before deploying to production:

- [ ] All required provider API keys configured
- [ ] Storage backend configured (S3 or GCS for production)
- [ ] Environment variables set (no hardcoded secrets)
- [ ] Rate limiting configured
- [ ] Cost budget alerts set up
- [ ] Observability configured (OTel, logging)
- [ ] Health checks passing
- [ ] Content safety policies configured
- [ ] TLS enabled in production
- [ ] Backup and recovery procedures documented
- [ ] Incident response runbook created
- [ ] Load testing completed
- [ ] Security scan passed (no vulnerabilities)
- [ ] Compliance requirements met (GDPR, SOC 2, etc.)

---

## References

- **ARCHITECTURE.md** — System design deep dive
- **DEV_PLAN.md** — Development checklist
- **README.md** — Quick start and overview
- **docs/TOOL_CATALOG.md** — Complete MCP tool reference
- **docs/QUALITY_GATES.md** — Quality gate configuration guide
- **MCP Specification** — https://modelcontextprotocol.io/
- **skills/** — Skill definitions for all media operations
