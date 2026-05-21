# @reaatech/media-pipeline-mcp-deepgram

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-deepgram.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Deepgram provider for the media pipeline framework. Provides speech-to-text transcription with smart formatting and speaker diarization using the Nova-2 model. Supports native streaming via WebSocket frames and HMAC-signed webhook callbacks for async batch operations.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-deepgram
# or
pnpm add @reaatech/media-pipeline-mcp-deepgram
```

## Feature Overview

- Speech-to-text transcription with Nova-2 (word-level timestamps, confidence scores)
- Speaker diarization with labeled utterances and segment metadata
- Smart formatting: auto-capitalization, punctuation, number/date normalization
- Language detection and multi-language support
- Streaming support for both operations (`supportsStreaming`)
- Webhook support for async callbacks (`supportsWebhooks`)
- SHA-256 hashing of raw audio in cache keys to avoid storing multi-megabyte buffers

## Quick Start

```typescript
import { DeepgramProvider } from "@reaatech/media-pipeline-mcp-deepgram";

const provider = new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! });

// Transcribe audio to text
const result = await provider.execute({
  operation: "audio.stt",
  params: { audio_data: audioBuffer, language: "en", diarize: true },
  config: {},
});
console.log(JSON.parse(result.data.toString()).transcript);

// Diarize speakers in an audio recording
const speakers = await provider.execute({
  operation: "audio.diarize",
  params: { audio_data: meetingAudioBuffer, language: "en" },
  config: {},
});
const output = JSON.parse(speakers.data.toString());
console.log(`Found ${output.speakers} speakers across ${output.segments.length} segments`);
```

## Supported Operations

| Operation | Default Model | Description | Output Format |
|-----------|---------------|-------------|---------------|
| `audio.stt` | `nova-2` | Speech-to-text with smart formatting, timestamps, and optional diarization | JSON with `transcript`, `confidence`, `segments` |
| `audio.diarize` | `nova-2` | Speaker identification with labeled utterances, start/end times, and confidence | JSON with `speakers` count and per-speaker `segments` |

## Configuration Parameters

### `audio.stt`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_data` | `Buffer` | *required* | Raw audio data buffer |
| `language` | `string` | `"en"` | BCP-47 language code |
| `model` | `string` | `"nova-2"` | Model ID (`nova-2`, `whisper`) |
| `diarize` | `boolean` | `false` | Enable speaker diarization in STT output |

### `audio.diarize`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_data` | `Buffer` | *required* | Raw audio data buffer |
| `language` | `string` | `"en"` | BCP-47 language code |
| `model` | `string` | `"nova-2"` | Model ID |

## API Reference

### `DeepgramProvider`

```typescript
class DeepgramProvider extends MediaProvider {
  constructor(config: DeepgramProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `DeepgramProviderConfig`

```typescript
interface DeepgramProviderConfig {
  apiKey: string;
  models?: {
    stt?: string;      // Default: "nova-2"
    diarize?: string;  // Default: "nova-2"
  };
  timeout?: number;    // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineDeepgramProvider } from "@reaatech/media-pipeline-mcp-deepgram";

const provider = defineDeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by fetching project info from the Deepgram API |
| `estimateCost(input)` | `CostEstimate` | Estimates cost based on audio size (bytes / 960KB per minute) and model per-minute rate |
| `execute(input)` | `ProviderOutput` | Runs STT or diarization, returns JSON output with transcript/segments metadata |

### Non-Retryable Errors

The provider classifies these errors as non-retryable: authentication failed, invalid API key, permission denied, insufficient credits, unsupported model, invalid audio format.

## Cost Estimation

### Per-Minute Pricing

| Model | Operation | Cost / Minute |
|-------|-----------|---------------|
| `nova-2` | `audio.stt` | $0.0059 |
| `nova-2` | `audio.diarize` | $0.0079 |
| `whisper` | `audio.stt` | $0.0040 |

Cost is estimated by converting the audio buffer size to minutes (using 960KB/min as an approximation), then multiplying by the per-minute rate.

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `audio_data` (SHA-256 hashed), `audio_url`, `model`, `language`, `diarize`, `punctuate`, `smart_format`, `utterances`, `detect_topics`, `detect_entities`, `redact`

**Non-deterministic parameters:** `request_id`

Raw audio bytes are hashed with SHA-256 during normalization so cache keys remain compact. All boolean-style feature flags are coerced to booleans for consistent matching.

## Health Check

The health check sends a GET request to `https://api.deepgram.com/v1/projects` using the configured API key. Returns `{ healthy: true, latency: <ms> }` if the API responds with 2xx, or `{ healthy: false, error: "<message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative STT provider (Whisper-1)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
