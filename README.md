# media-pipeline-mcp

**Chainable media operations with quality gates as MCP tools**

A media pipeline server that exposes AI media operations (image generation, editing, audio, video, OCR) as MCP tools. The key differentiator: operations are chainable with artifact passing and quality gates between steps.

## Quick Start

```bash
# Clone and install
git clone <repo>
cd media-pipeline-mcp
pnpm install

# Copy environment template and add your provider credentials
cp .env.example .env
# Edit .env and add at least one provider configuration

# Start the server
pnpm dev

# Or use Docker
docker compose up
```

## What Can You Do?

### 1. Use Individual Tools

Call media operations directly via MCP:

```json
{
  "name": "image.generate",
  "arguments": {
    "prompt": "A sunset over mountains",
    "dimensions": "1024x1024"
  }
}
```

### 2. Chain Operations in Pipelines

Define multi-step workflows with artifact passing:

```json
{
  "id": "product-photo",
  "steps": [
    {
      "id": "generate",
      "operation": "image.generate",
      "inputs": { "prompt": "Professional product photo" },
      "config": { "dimensions": "1024x1024" }
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
```

### 3. Add Quality Gates

Validate output between steps:

```json
{
  "id": "step1",
  "operation": "image.generate",
  "inputs": { "prompt": "..." },
  "qualityGate": {
    "type": "llm-judge",
    "config": {
      "prompt": "Is this a professional product photo?",
      "model": "gpt-4o-mini"
    },
    "action": "retry",
    "maxRetries": 2
  }
}
```

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
```

## Supported Operations

| Category | Operations |
|----------|------------|
| **Image** | generate, upscale, remove_background, inpaint, describe, resize, crop, composite |
| **Audio** | tts, stt, diarize, isolate |
| **Video** | generate, image_to_video, extract_frames, extract_audio |
| **Document** | ocr, extract_tables, extract_fields, summarize |
| **Pipeline** | define, run, status, resume, templates |

## Supported Providers

| Provider | Operations | Models |
|----------|------------|--------|
| Stability AI | image.generate, image.inpaint | SD3, SDXL |
| Replicate | image.generate, image.upscale, remove_background, video.generate | Flux, Real-ESRGAN, RMBG, Kling |
| OpenAI | image.generate, audio.tts, audio.stt | DALL-E 3, TTS-1, Whisper-1 |
| ElevenLabs | audio.tts | Various voices |
| Deepgram | audio.stt, audio.diarize | Nova-2 |
| fal.ai | image.generate, image.upscale | Flux, Fast SDXL |

## Configuration

The server is configured via environment variables. Create a `.env` file or set variables directly:

```bash
# Provider credentials (at least one provider required)
STABILITY_API_KEY=sk_...
REPLICATE_API_KEY=r8_...
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=sk-ant_...
FAL_API_KEY=...

# Google provider (Document AI / Vertex AI)
GOOGLE_PROJECT_ID=my-gcp-project
GOOGLE_LOCATION=us-central1
GOOGLE_DOCUMENT_AI_PROCESSOR_ID=processor-id
GOOGLE_GEMINI_MODEL=gemini-1.5-pro
GOOGLE_KEY_FILE=/path/to/service-account.json

# Storage (default: local)
STORAGE_TYPE=local           # Options: local, s3, gcs
STORAGE_PATH=./artifacts    # Local storage path
STORAGE_TTL=86400           # TTL in seconds (optional)

# Server
PORT=8080
HOST=0.0.0.0
LOG_LEVEL=info              # Options: error, warn, info, debug

# Security (optional)
AUTH_ENABLED=false
JWT_SECRET=your-secret-key-min-32-chars
API_KEYS=key1,key2,key3     # Comma-separated API keys

# Rate Limiting (optional)
RATE_LIMIT_ENABLED=true
RATE_LIMIT_RPM=60
RATE_LIMIT_BURST=10
EXPENSIVE_OPS_RPM=10

# Budget Alerts (optional)
BUDGET_DAILY_LIMIT=100
BUDGET_MONTHLY_LIMIT=2000
BUDGET_PER_PIPELINE_LIMIT=50
BUDGET_ALERT_THRESHOLD=0.9
```

### Provider Configuration

Providers are auto-discovered from environment variables. API-key providers are enabled when their API key is present. The Google provider is enabled when `GOOGLE_PROJECT_ID` is set and should be paired with Google credentials such as `GOOGLE_KEY_FILE` or `GOOGLE_APPLICATION_CREDENTIALS`.

The server will only use providers that are fully configured. Operations fall back to the built-in mock provider only when no real providers are configured.

## Quality Gates

| Gate Type | Description | Use Case |
|-----------|-------------|----------|
| `llm-judge` | Send artifact to LLM for evaluation | Subjective quality checks |
| `threshold` | Numeric comparison on metadata | Dimension checks, file size limits |
| `dimension-check` | Verify output dimensions match expectations | Format validation |
| `custom` | User-provided validation function | Programmatic checks |

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Lint and format
pnpm lint
pnpm format

# Type check
pnpm typecheck
```

## Deployment

### Docker

```bash
docker build -t media-pipeline-mcp .
docker run -p 8080:8080 -e OPENAI_API_KEY=$OPENAI_API_KEY media-pipeline-mcp
```

### Docker Compose

```bash
docker compose up
```

### AWS ECS Fargate

```bash
cd infra/aws
terraform init
terraform apply
```

### GCP Cloud Run

```bash
gcloud run deploy media-pipeline-mcp \
  --image gcr.io/$PROJECT_ID/media-pipeline-mcp:latest \
  --platform managed \
  --region us-central1
```

## Examples

Check out the `examples/` directory for complete working examples:

- **standalone-tool-calls.ts** — Call individual media tools
- **product-photo-pipeline.ts** — Product photo pipeline with quality gates
- **podcast-clip-pipeline.ts** — Audio transcription → summary → voiceover
- **document-intake-pipeline.ts** — OCR → field extraction → validation
- **agent-mesh-integration.ts** — Multi-agent system integration

## Documentation

| Document | Description |
|----------|-------------|
| [AGENTS.md](./AGENTS.md) | Agent development guide |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture deep dive |
| [DEV_PLAN.md](./DEV_PLAN.md) | Development checklist |
| [docs/TOOL_CATALOG.md](./docs/TOOL_CATALOG.md) | Complete MCP tool reference |
| [docs/QUALITY_GATES.md](./docs/QUALITY_GATES.md) | Quality gate configuration guide |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to add providers, operations, templates |

## License

MIT
