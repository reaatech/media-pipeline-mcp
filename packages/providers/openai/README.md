# @reaatech/media-pipeline-mcp-openai

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-openai.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

OpenAI provider for the media pipeline framework. Supports image generation (DALL-E 3), image description (GPT-4o Vision), text-to-speech (TTS-1), and speech-to-text (Whisper-1).

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-openai
# or
pnpm add @reaatech/media-pipeline-mcp-openai
```

## Quick Start

```typescript
import { OpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

// Generate an image
const image = await provider.execute("image.generate", {
  params: { prompt: "A futuristic city skyline at sunset" },
  config: { size: "1024x1024", quality: "hd", style: "vivid" },
});

// Describe an image
const description = await provider.execute("image.describe", {
  params: { artifact_id: "img-123", detail: "detailed" },
  config: {},
});

// Text to speech
const audio = await provider.execute("audio.tts", {
  params: { text: "Hello, welcome to our service", voice: "alloy", speed: 1.0 },
  config: { format: "mp3" },
});

// Speech to text
const transcript = await provider.execute("audio.stt", {
  params: { artifact_id: "audio-456" },
  config: { language: "en" },
});
```

## Supported Operations

| Operation | Model | Description |
|-----------|-------|-------------|
| `image.generate` | DALL-E 3 | Text-to-image generation with size/quality/style options |
| `image.describe` | GPT-4o Vision | Image description at brief, detailed, or structured levels |
| `audio.tts` | TTS-1 | Text-to-speech with voice and speed control |
| `audio.stt` | Whisper-1 | Speech-to-text transcription with verbose JSON output |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `image.generate` | $0.04 / image |
| `image.describe` | $0.01 / description |
| `audio.tts` | $0.015 / request |
| `audio.stt` | $0.006 / minute |

## Configuration

```typescript
interface OpenAIConfig {
  apiKey: string;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
