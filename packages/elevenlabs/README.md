# @reaatech/media-pipeline-mcp-elevenlabs

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-elevenlabs.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-elevenlabs)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

ElevenLabs provider for the media pipeline framework. Supports high-quality text-to-speech with voice selection, speed control, and fine-grained voice tuning.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-elevenlabs
# or
pnpm add @reaatech/media-pipeline-mcp-elevenlabs
```

## Quick Start

```typescript
import { ElevenLabsProvider } from "@reaatech/media-pipeline-mcp-elevenlabs";

const provider = new ElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! });

const audio = await provider.execute("audio.tts", {
  params: {
    text: "Welcome to our media pipeline. This audio was generated with ElevenLabs.",
    voice: "Rachel",
    speed: 1.0,
  },
  config: {
    format: "mp3",
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.0,
  },
});

console.log(audio.mimeType); // "audio/mpeg"
console.log(audio.metadata.duration_est_seconds); // ~5.0
```

## Supported Operations

| Operation | Description |
|-----------|-------------|
| `audio.tts` | Text-to-speech with voice customization |

## Voice Selection

Named voices: `"Rachel"`, `"Josh"`, `"Daniel"`, `"Charlotte"`, plus custom voice IDs.

## Voice Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `stability` | `number` | `0.5` | Voice stability (0–1) |
| `similarity_boost` | `number` | `0.75` | Speaker similarity boost (0–1) |
| `style` | `number` | `0.0` | Style exaggeration (0–1) |

## Supported Output Formats

`mp3`, `wav`, `ogg`, `flac`, `aac`

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `audio.tts` | $0.0003 / character |

## Configuration

```typescript
interface ElevenLabsProviderConfig {
  apiKey: string;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative TTS provider

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
