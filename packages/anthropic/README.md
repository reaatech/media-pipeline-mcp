# @reaatech/media-pipeline-mcp-anthropic

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-anthropic.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Anthropic provider for the media pipeline framework. Leverages Claude Sonnet's vision-capable models for image description, OCR, table extraction, structured field extraction, and document summarization. Supports streaming token-by-token responses across all text-shaped operations.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-anthropic
# or
pnpm add @reaatech/media-pipeline-mcp-anthropic
```

## Feature Overview

- Vision-based image description at three detail levels (brief, detailed, structured)
- Document OCR with plain text, structured JSON, or markdown output
- Table extraction from documents in markdown or JSON formats
- Structured field extraction with configurable JSON schema
- Document summarization with adjustable length and style
- Streaming support for all operations (`supportsStreaming`)
- Per-token cost tracking via `usage.input_tokens` / `usage.output_tokens`

## Quick Start

```typescript
import { AnthropicProvider } from "@reaatech/media-pipeline-mcp-anthropic";

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Describe an image
const description = await provider.execute({
  operation: "image.describe",
  params: { image_data: imageBuffer, detail_level: "detailed", mime_type: "image/png" },
  config: {},
});

// OCR a scanned document
const text = await provider.execute({
  operation: "document.ocr",
  params: { image_data: docBuffer, output_format: "markdown", mime_type: "image/png" },
  config: {},
});

// Extract structured fields from an invoice
const fields = await provider.execute({
  operation: "document.extract_fields",
  params: {
    image_data: invoiceBuffer,
    field_schema: { invoice_number: "string", date: "date", total_amount: "number", vendor_name: "string" },
    mime_type: "image/png",
  },
  config: {},
});
```

## Supported Operations

| Operation | Default Model | Description | Output Options |
|-----------|---------------|-------------|----------------|
| `image.describe` | `claude-sonnet-4-20250514` | Vision-based image analysis | `brief` / `detailed` / `structured` |
| `document.ocr` | `claude-sonnet-4-20250514` | Text extraction from document images | `plain_text` / `structured_json` / `markdown` |
| `document.extract_tables` | `claude-sonnet-4-20250514` | Table extraction with structural parsing | `markdown` / `json` |
| `document.extract_fields` | `claude-sonnet-4-20250514` | Schema-driven field extraction | JSON matching provided schema |
| `document.summarize` | `claude-sonnet-4-20250514` | Content summarization with style control | `short` / `medium` / `long` / `detailed` |

## Configuration Parameters

### `image.describe`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `detail_level` | `string` | `"detailed"` | Description detail: `brief`, `detailed`, `structured` |
| `mime_type` | `string` | `"image/png"` | Image MIME type (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) |

### `document.ocr`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `output_format` | `string` | `"plain_text"` | Output format: `plain_text`, `structured_json`, `markdown` |
| `mime_type` | `string` | `"image/png"` | Image MIME type |

### `document.extract_tables`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `output_format` | `string` | `"markdown"` | Output format: `markdown`, `json` |
| `mime_type` | `string` | `"image/png"` | Image MIME type |

### `document.extract_fields`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `field_schema` | `Record<string, string>` | *required* | JSON schema mapping field names to types (`string`, `number`, `date`, `boolean`) |
| `mime_type` | `string` | `"image/png"` | Image MIME type |

### `document.summarize`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | `string` | — | Plain text content to summarize (used if no `image_data`) |
| `image_data` | `Buffer` | — | Document image as raw buffer (optional, for image-based docs) |
| `length` | `string` | `"medium"` | Summary length: `short` (1-2 sentences), `medium` (1 paragraph), `long` (2-3 paragraphs), `detailed` |
| `style` | `string` | `"neutral"` | Writing style |
| `mime_type` | `string` | `"image/png"` | Image MIME type (when using `image_data`) |

## API Reference

### `AnthropicProvider`

```typescript
class AnthropicProvider extends MediaProvider {
  constructor(config: AnthropicProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `AnthropicProviderConfig`

```typescript
interface AnthropicProviderConfig {
  apiKey: string;       // Anthropic API key
  model?: string;       // Default: "claude-sonnet-4-20250514"
  maxTokens?: number;   // Default: 4096
  timeout?: number;     // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineAnthropicProvider } from "@reaatech/media-pipeline-mcp-anthropic";

const provider = defineAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API connectivity by creating a minimal message |
| `estimateCost(input)` | `CostEstimate` | Estimates cost based on operation, model, and estimated token usage |
| `execute(input)` | `ProviderOutput` | Runs the requested operation and returns output with metadata |

### Non-Retryable Errors

The provider classifies these errors as non-retryable: authentication failed, invalid API key, permission denied, insufficient credits, content filtering, policy violation.

## Cost Estimation

### Token Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| `claude-sonnet-4-20250514` | $3.00 | $15.00 |
| `claude-3-5-sonnet-20241022` | $3.00 | $15.00 |

### Per-Operation Estimates

| Operation | Est. Input Tokens | Est. Output Tokens | Est. Cost |
|-----------|-------------------|-------------------|-----------|
| `image.describe` | 1,200 | 300 | ~$0.0081 |
| `document.ocr` | 800 | 300 | ~$0.0069 |
| `document.extract_tables` | 800 | 300 | ~$0.0069 |
| `document.extract_fields` | 800 | 300 | ~$0.0069 |
| `document.summarize` | 800 | 300 | ~$0.0069 |

Actual cost varies with token usage and model selection. Costs are computed from `usage.input_tokens` and `usage.output_tokens` returned by the API.

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters for intelligent response caching.

**Deterministic parameters:** `prompt`, `model`, `system`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `image_data`, `image_url`, `document_data`

**Non-deterministic parameters:** `metadata`, `user_id`

The `normalize()` function trims whitespace, collapses spaces, and drops non-deterministic fields so that equivalent requests produce matching cache keys. Image bytes are not hashed separately; the image content itself forms part of the deterministic key set.

## Health Check

The health check sends a lightweight message creation request (`max_tokens: 10`) to the Anthropic API to verify connectivity and API key validity. Returns `{ healthy: true, latency: <ms> }` on success or `{ healthy: false, error: "<message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative vision provider (GPT-4o)
- [`@reaatech/media-pipeline-mcp-google`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google) — Alternative document extraction provider (Document AI)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
