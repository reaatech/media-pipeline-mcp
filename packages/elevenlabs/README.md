# @reaatech/media-pipeline-mcp-elevenlabs

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-elevenlabs.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-elevenlabs)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

ElevenLabs provider for the media pipeline framework. Delivers high-quality text-to-speech synthesis with configurable voice selection, speaking speed, voice stability tuning, similarity boost, and style exaggeration. Supports multiple output formats and native audio-byte streaming.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-elevenlabs
# or
pnpm add @reaatech/media-pipeline-mcp-elevenlabs
```

## Feature Overview

- High-quality TTS with `eleven_monolingual_v1`, `eleven_multilingual_v2`, and `eleven_turbo_v2` models
- Named voice selection (Rachel, Josh, Daniel, Charlotte) plus custom voice IDs
- Fine-grained voice tuning: stability (0-1), similarity boost (0-1), style exaggeration (0-1)
- Speaking speed control via SSML prosody tags
- Multiple output formats: MP3, WAV, OGG, FLAC, AAC
- Streaming support for TTS audio bytes (`supportsStreaming`)
- Character-count-based cost estimation

## Quick Start

```typescript
import { ElevenLabsProvider } from "@reaatech/media-pipeline-mcp-elevenlabs";

const provider = new ElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! });

const audio = await provider.execute({
  operation: "audio.tts",
  params: {
    text: "Welcome to our media pipeline. This audio was generated with ElevenLabs.",
    voice: "Rachel",
    speed: 1.0,
    model: "eleven_turbo_v2",
  },
  config: {},
});

// Save or pipe the audio
import { writeFileSync } from "node:fs";
writeFileSync("output.mp3", audio.data);
console.log(`Generated ${audio.metadata.characterCount} chars in ${audio.metadata.duration}s`);
```

## Supported Operations

| Operation | Default Model | Description | Output Format |
|-----------|---------------|-------------|---------------|
| `audio.tts` | `eleven_monolingual_v1` | Text-to-speech with voice and parameter control | Audio bytes in `mp3`, `wav`, `ogg`, `flac`, or `aac` |

## Configuration Parameters

### `audio.tts`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | `string` | *required* | Text to convert to speech |
| `voice` | `string` | `"Rachel"` | Voice name (`Rachel`, `Josh`, `Daniel`, `Charlotte`) or custom voice ID |
| `speed` | `number` | `1.0` | Speaking rate multiplier (uses SSML prosody) |
| `model` | `string` | `"eleven_monolingual_v1"` | TTS model ID |
| `response_format` | `string` | `"mp3"` | Output audio format: `mp3`, `wav`, `ogg`, `flac`, `aac` |

### Voice Tuning (internal defaults)

The provider applies these voice settings automatically on every request:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `stability` | `0.5` | Voice stability (0 = more variable, 1 = more consistent) |
| `similarity_boost` | `0.75` | Speaker similarity to target voice (0-1) |
| `style` | `0.0` | Style exaggeration (0-1) |
| `use_speaker_boost` | `true` | Enhance speaker clarity |

## API Reference

### `ElevenLabsProvider`

```typescript
class ElevenLabsProvider extends MediaProvider {
  constructor(config: ElevenLabsProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `ElevenLabsProviderConfig`

```typescript
interface ElevenLabsProviderConfig {
  apiKey: string;
  voices?: {
    default?: string;
    [voiceName: string]: string | undefined;
  };
  model?: string;    // Default model ID
  timeout?: number;  // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineElevenLabsProvider } from "@reaatech/media-pipeline-mcp-elevenlabs";

const provider = defineElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! });
```

### Voice Resolution Logic

Voice parameters are resolved in this order:
1. If a custom `voices` map is configured, the name is looked up there first
2. If the value starts with `voice_` or is exactly 20 characters, it's treated as a raw voice ID
3. If the name matches a built-in preset, that voice ID is used
4. Falls back to `"Rachel"`

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by fetching `/v1/voices` from the ElevenLabs API |
| `estimateCost(input)` | `CostEstimate` | Estimates cost based on text character count × per-character rate |
| `execute(input)` | `ProviderOutput` | Synthesizes audio and returns raw audio bytes with metadata |

### Non-Retryable Errors

The provider classifies these errors as non-retryable: authentication failed, invalid API key, permission denied, insufficient credits, voice not found, invalid voice ID.

## Cost Estimation

### Per-Character Pricing

| Model | Cost / Character |
|-------|-----------------|
| `eleven_turbo_v2` | $0.0002 |
| `eleven_monolingual_v1` | $0.0003 |
| `eleven_multilingual_v2` | $0.0005 |

### Example Estimates

| Text Length | Model | Est. Cost |
|------------|-------|-----------|
| 100 chars | `eleven_turbo_v2` | $0.02 |
| 100 chars | `eleven_monolingual_v1` | $0.03 |
| 500 chars | `eleven_multilingual_v2` | $0.25 |

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `text`, `voice_id`, `voice`, `model`, `voice_settings`

**Non-deterministic parameters:** (none)

The `normalize()` function trims and collapses whitespace in `text`, and preserves voice settings as-is. All parameters are deterministic, so identical text + voice + model combinations will produce matching cache keys.

## Health Check

The health check sends a GET request to `https://api.elevenlabs.io/v1/voices` using the `xi-api-key` header. Returns `{ healthy: true, latency: <ms> }` on 2xx response, or `{ healthy: false, error: "<message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative TTS provider (TTS-1)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
