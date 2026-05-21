# @reaatech/media-pipeline-mcp-ollama

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-ollama.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-ollama)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Local Ollama provider for the media pipeline framework. Supports text completion, embedding generation, and image description via any Ollama model at zero API cost. Ideal as an LLM-judge backend for variant evaluation in quality gates.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-ollama
# or
pnpm add @reaatech/media-pipeline-mcp-ollama
```

## Feature Overview

- **Zero API cost** — all inference runs on your own hardware
- **Text completion** — generate text with any Ollama model using `/api/generate`
- **Embedding generation** — produce vector embeddings via `/api/embeddings`
- **Image description** — describe images using multimodal models (e.g. LLaVA, llama3.2-vision)
- **Auto-pull** — optionally pull missing models automatically before first use
- **Streaming support** — operations declare streaming capability for progress tracking
- **Configurable timeout** — adjustable request timeout per operation

## Quick Start

```typescript
import { OllamaProvider } from "@reaatech/media-pipeline-mcp-ollama";

const provider = new OllamaProvider({
  baseUrl: "http://localhost:11434",
  defaultModel: "llama3.2",
});

// Text completion
const textResult = await provider.execute({
  operation: "text.complete",
  params: {
    prompt: "Write a haiku about cherry blossoms",
    temperature: 0.7,
    max_tokens: 100,
  },
  config: {},
});

console.log(textResult.data.toString()); // The generated haiku
console.log(textResult.metadata.model); // "llama3.2"

// Embedding generation
const embedResult = await provider.execute({
  operation: "embedding.generate",
  params: {
    input: "What is the meaning of life?",
    model: "nomic-embed-text",
  },
  config: {},
});

const embedding = JSON.parse(embedResult.data.toString());
console.log(embedResult.metadata.dimensions); // e.g. 768

// Image description (requires multimodal model)
const descResult = await provider.execute({
  operation: "image.describe",
  params: {
    artifact_data: imageBuffer,
    model: "llama3.2-vision",
    prompt: "Describe this image in detail.",
  },
  config: {},
});

console.log(descResult.data.toString()); // Image description
```

With auto-pull enabled:

```typescript
const provider = new OllamaProvider({
  baseUrl: "http://localhost:11434",
  autoPull: true,     // Pull models automatically if not present
  defaultModel: "llama3.2",
});
```

## Supported Operations

| Operation | Ollama API Endpoint | Description |
|-----------|-------------------|-------------|
| `text.complete` | `/api/generate` | Text generation with prompt, system message, temperature, and max token control |
| `embedding.generate` | `/api/embeddings` | Generate vector embeddings for text input |
| `image.describe` | `/api/generate` | Describe images using multimodal vision models |

## Configuration

```typescript
interface OllamaConfig {
  baseUrl?: string;        // Default: "http://localhost:11434"
  defaultModel?: string;   // Default: "llama3.2"
  timeoutMs?: number;      // Default: 120000 (2 min)
  headers?: Record<string, string>;  // Custom HTTP headers
  autoPull?: boolean;      // Default: false — auto-pull missing models
}
```

## API Reference

### `OllamaProvider`

Main provider class extending `MediaProvider`.

| Member | Type | Description |
|--------|------|-------------|
| `supportedOperations` | `string[]` | `['text.complete', 'embedding.generate', 'image.describe']` |
| `supportsStreaming` | `Set<string>` | `{'text.complete', 'embedding.generate'}` |
| `supportsWebhooks` | `boolean` | `false` — Ollama has no outbound webhooks |
| `healthCheck()` | `Promise<ProviderHealth>` | Checks `/api/tags` endpoint |
| `estimateCost()` | `Promise<CostEstimate>` | Always returns `{ costUsd: 0 }` |
| `execute(input)` | `Promise<ProviderOutput>` | Routes to `textComplete`, `embeddingGenerate`, or `imageDescribe` |

### `createOllamaProvider(config?)`

Factory function that returns a new `OllamaProvider` instance.

### `OllamaConfig`

Configuration interface (see Configuration section above).

## Text Completion Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | — | Input text prompt (required) |
| `model` | `string` | Provider default | Model name to use |
| `system` | `string` | — | System prompt |
| `temperature` | `number` | — | Sampling temperature |
| `max_tokens` | `number` | — | Maximum output tokens |
| `stream` | `boolean` | `false` | Streaming mode (use `supportsStreaming` metadata) |

## Embedding Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input` | `string` | — | Text to embed (required) |
| `model` | `string` | Provider default | Embedding model name |

## Image Description Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `artifact_data` | `Buffer` | — | Image data buffer (required) |
| `model` | `string` | `"llama3.2-vision"` | Multimodal model name |
| `prompt` | `string` | `"Describe this image in detail."` | Custom description prompt |
| `detail` | `string` | `"detailed"` | Detail level metadata |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `text.complete` | $0.00 (local) |
| `embedding.generate` | $0.00 (local) |
| `image.describe` | $0.00 (local) |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
