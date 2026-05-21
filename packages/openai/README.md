# @reaatech/media-pipeline-mcp-openai

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-openai.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

OpenAI provider for the media pipeline framework. Supports image generation (DALL-E 3), vision-based image description (GPT-4o), text-to-speech (TTS-1), and speech-to-text transcription (Whisper-1). Fully self-contained using only the OpenAI REST API — no SDK dependency required.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-openai
# or
pnpm add @reaatech/media-pipeline-mcp-openai
```

## Feature Overview

- DALL-E 3 image generation with quality (standard/hd), size, and style control
- GPT-4o / GPT-4o-mini vision-based image description at three detail levels
- TTS-1 text-to-speech with voice selection and speaking speed
- Whisper-1 speech-to-text with verbose JSON output and optional language hint
- Streaming support for TTS, text completion, and image description (`supportsStreaming`)
- Organization and project header support for multi-tenant OpenAI accounts
- Base URL override for custom endpoints and proxies
- Per-operation cost estimation with size and quality multipliers

## Quick Start

```typescript
import { OpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

// Generate an image
const image = await provider.execute({
  operation: "image.generate",
  params: { prompt: "A futuristic city skyline at sunset", dimensions: "1024x1024", quality: "standard", style: "vivid" },
  config: {},
});

// Describe an image
const description = await provider.execute({
  operation: "image.describe",
  params: { artifact_data: imageBuffer, detail_level: "detailed", mime_type: "image/png" },
  config: {},
});

// Text to speech
const audio = await provider.execute({
  operation: "audio.tts",
  params: { text: "Hello, welcome to our service", voice: "alloy", speed: 1.0, output_format: "mp3" },
  config: {},
});

// Speech to text
const transcript = await provider.execute({
  operation: "audio.stt",
  params: { audio_data: audioBuffer, language: "en" },
  config: {},
});
```

## Supported Operations

| Operation | Default Model | Description | Output Format |
|-----------|---------------|-------------|---------------|
| `image.generate` | `dall-e-3` | Text-to-image with size/quality/style options | PNG image buffer |
| `image.describe` | `gpt-4o` | Vision-based image description at brief, detailed, or structured levels | Plain text |
| `audio.tts` | `tts-1` | Text-to-speech with voice and speed control | Audio bytes (mp3, wav, opus) |
| `audio.stt` | `whisper-1` | Speech-to-text transcription with verbose JSON output | JSON with `text` and `segments` |

## Configuration Parameters

### `image.generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Text description of the desired image |
| `dimensions` | `string` | `"1024x1024"` | Image size: `1024x1024`, `1024x1792`, `1792x1024` |
| `quality` | `string` | `"standard"` | Image quality: `standard` or `hd` |
| `style` | `string` | `"vivid"` | Image style: `vivid` or `natural` |
| `num_outputs` | `number` | `1` | Number of images to generate |

### `image.describe`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifact_data` | `Buffer` | *required* | Image as raw buffer |
| `detail_level` | `string` | `"detailed"` | Description detail: `brief`, `detailed`, `structured` |
| `mime_type` | `string` | `"image/png"` | Image MIME type |

### `audio.tts`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | `string` | *required* | Text to convert to speech |
| `voice` | `string` | `"alloy"` | Voice: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `speed` | `number` | `1.0` | Speaking speed (0.25 to 4.0) |
| `output_format` | `string` | `"mp3"` | Audio format: `mp3`, `wav`, `opus` |

### `audio.stt`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_data` | `Buffer` | *required* | Audio data as raw buffer |
| `language` | `string` | — | Optional BCP-47 language code hint |

## API Reference

### `OpenAIProvider`

```typescript
class OpenAIProvider extends MediaProvider {
  constructor(config: OpenAIConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `OpenAIConfig`

```typescript
interface OpenAIConfig {
  apiKey: string;          // OpenAI API key (required)
  organization?: string;   // Optional org ID for multi-org accounts
  project?: string;        // Optional project ID for scoped access
  baseUrl?: string;        // Default: "https://api.openai.com/v1"
}
```

### Factory Function

```typescript
import { createOpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";

const provider = createOpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by listing available models |
| `estimateCost(input)` | `CostEstimate` | Estimates cost per operation with size/quality multipliers |
| `execute(input)` | `ProviderOutput` | Routes to DALL-E, GPT-4o, TTS-1, or Whisper-1 based on operation |

### Non-Retryable Errors

Non-retryable errors are determined by OpenAI HTTP status codes. The provider relies on the base class retry logic for transient failures.

## Cost Estimation

### DALL-E 3 Image Generation

| Quality | Size | Cost |
|---------|------|------|
| `standard` | 1024×1024 | $0.04 |
| `standard` | 1024×1792 / 1792×1024 | $0.08 |
| `hd` | 1024×1024 | $0.08 |
| `hd` | 1024×1792 / 1792×1024 | $0.12 |

### GPT-4o Image Description

| Model | Input (per 1K tokens) | Output (per 1K tokens) |
|-------|----------------------|------------------------|
| `gpt-4o` | $0.0025 | $0.01 |
| `gpt-4o-mini` | $0.00015 | $0.0006 |

### TTS-1 Text-to-Speech

| Model | Cost (per 1M chars) |
|-------|---------------------|
| `tts-1` | $15.00 |
| `tts-1-hd` | $30.00 |

### Whisper-1 Speech-to-Text

| Model | Cost (per minute) |
|-------|-------------------|
| `whisper-1` | $0.006 |

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `prompt`, `model`, `size`, `quality`, `style`, `text`, `voice`, `speed`

**Non-deterministic parameters:** `n`, `response_format`, `user`, `output_format`, `num_outputs`, `style_preset`, `dimensions`, `artifact_data`, `mime_type`, `detail`, `detail_level`, `audio_data`, `language`

The `normalize()` function trims/collapses whitespace in `prompt` and `text`, normalizes `dimensions` → `size` and `style_preset` → `style` for consistent cache keying. Image and audio binary data are deliberately excluded from deterministic params since identical media files will produce equivalent descriptions/transcriptions.

## Health Check

The health check sends a GET request to `{baseUrl}/models` using the configured API key and optional organization/project headers. Returns `{ healthy: true, latency: <ms> }` on 2xx response, or `{ healthy: false, error: "HTTP <status>: <message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Alternative image generation provider (SD3)
- [`@reaatech/media-pipeline-mcp-deepgram`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram) — Alternative STT provider (Nova-2)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
