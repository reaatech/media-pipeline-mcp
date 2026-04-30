# @reaatech/media-pipeline-mcp-deepgram

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-deepgram.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Deepgram provider for the media pipeline framework. Supports speech-to-text transcription and speaker diarization using the Nova-2 model.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-deepgram
# or
pnpm add @reaatech/media-pipeline-mcp-deepgram
```

## Quick Start

```typescript
import { DeepgramProvider } from "@reaatech/media-pipeline-mcp-deepgram";

const provider = new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! });

// Transcribe audio
const transcript = await provider.execute("audio.stt", {
  params: { artifact_id: "audio-123", language: "en" },
  config: { smart_format: true },
});

// Diarize speakers
const speakers = await provider.execute("audio.diarize", {
  params: { artifact_id: "meeting-456" },
  config: { num_speakers: 2 },
});

console.log(speakers.metadata.speakerCount); // 2
console.log(speakers.metadata.segments.length); // Array of speaker-labeled utterances
```

## Supported Operations

| Operation | Model | Description |
|-----------|-------|-------------|
| `audio.stt` | Nova-2 | Speech-to-text with smart formatting and optional diarization |
| `audio.diarize` | Nova-2 | Speaker identification with labeled segments and confidence scores |

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `smart_format` | `boolean` | `false` | Auto-format dates, numbers, punctuation |
| `language` | `string` | `"en"` | Language code |
| `diarize` | `boolean` | `false` | Enable speaker diarization (STT operation) |
| `num_speakers` | `number` | — | Expected speaker count (diarize operation) |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `audio.stt` | $0.0059 / minute |
| `audio.diarize` | $0.0059 / minute |

## Configuration

```typescript
interface DeepgramProviderConfig {
  apiKey: string;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative STT provider (Whisper)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
