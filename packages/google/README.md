# @reaatech/media-pipeline-mcp-google

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-google.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Google Cloud provider for the media pipeline framework. Uses Document AI for production-grade OCR, table extraction, and structured field extraction, plus Vertex AI Gemini for vision-based image description. Supports per-page cost tracking and document byte hashing for cache efficiency.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-google
# or
pnpm add @reaatech/media-pipeline-mcp-google
```

## Feature Overview

- Document AI OCR with plain text, structured JSON, or markdown output
- Document AI table extraction with structural parsing (headers + body rows)
- Document AI field extraction with configurable JSON schema and type coercion
- Vertex AI Gemini image description at three detail levels
- Page-level confidence scores on OCR output
- Streaming support for Gemini image description (`supportsStreaming`)
- SHA-256 hashing of document bytes in cache keys
- Service account JSON key file authentication

## Quick Start

```typescript
import { GoogleProvider } from "@reaatech/media-pipeline-mcp-google";

const provider = new GoogleProvider({
  projectId: "my-gcp-project",
  location: "us",
  documentAiProcessorId: "abc123def456",
  geminiModel: "gemini-1.5-pro",
});

// OCR a scanned document
const text = await provider.execute({
  operation: "document.ocr",
  params: { image_data: docBuffer, output_format: "markdown", mime_type: "image/png" },
  config: {},
});

// Extract tables from a financial report
const tables = await provider.execute({
  operation: "document.extract_tables",
  params: { image_data: reportBuffer, output_format: "json", mime_type: "application/pdf" },
  config: {},
});
console.log(JSON.parse(tables.data.toString())); // Array of { headers, rows }

// Extract structured fields from a form
const fields = await provider.execute({
  operation: "document.extract_fields",
  params: {
    image_data: formBuffer,
    field_schema: { name: "string", date: "date", amount: "number", approved: "boolean" },
    mime_type: "image/png",
  },
  config: {},
});

// Describe an image with Gemini
const description = await provider.execute({
  operation: "image.describe",
  params: { image_data: photoBuffer, detail_level: "structured", mime_type: "image/jpeg" },
  config: {},
});
```

## Supported Operations

| Operation | Service | Default Model | Description |
|-----------|---------|---------------|-------------|
| `document.ocr` | Document AI | Processor ID | Text extraction with page-level confidence |
| `document.extract_tables` | Document AI | Form Parser | Table extraction as markdown or JSON arrays |
| `document.extract_fields` | Document AI | Entity Extractor | Schema-driven field extraction with type coercion |
| `image.describe` | Vertex AI | `gemini-1.5-pro` | Vision-based image description |

## Configuration Parameters

### `document.ocr`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `output_format` | `string` | `"plain_text"` | Output format: `plain_text`, `structured_json`, `markdown` |
| `mime_type` | `string` | `"image/png"` | Document MIME type |

### `document.extract_tables`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `output_format` | `string` | `"markdown"` | Output format: `markdown`, `json` |
| `mime_type` | `string` | `"image/png"` | Document MIME type |

### `document.extract_fields`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Document image as raw buffer |
| `field_schema` | `Record<string, string>` | *required* | Schema mapping field names to types (`string`, `number`, `date`, `boolean`) |
| `mime_type` | `string` | `"image/png"` | Document MIME type |

### `image.describe`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Image as raw buffer |
| `detail_level` | `string` | `"detailed"` | Description detail: `brief`, `detailed`, `structured` |
| `mime_type` | `string` | `"image/png"` | Image MIME type |

## API Reference

### `GoogleProvider`

```typescript
class GoogleProvider extends MediaProvider {
  constructor(config: GoogleProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `GoogleProviderConfig`

```typescript
interface GoogleProviderConfig {
  projectId: string;                  // GCP project ID (required)
  location?: string;                  // Default: "us" for Document AI, "us-central1" for Vertex AI
  documentAiProcessorId?: string;     // Document AI processor ID
  geminiModel?: string;               // Default: "gemini-1.5-pro"
  keyFile?: string;                   // Path to service account JSON key file
  timeout?: number;                   // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineGoogleProvider } from "@reaatech/media-pipeline-mcp-google";

const provider = defineGoogleProvider({
  projectId: "my-gcp-project",
  documentAiProcessorId: "abc123",
});
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates connectivity by calling `getProcessor` on the configured Document AI processor |
| `estimateCost(input)` | `CostEstimate` | Returns fixed per-page/per-image cost from pricing table |
| `execute(input)` | `ProviderOutput` | Routes to Document AI or Vertex AI based on operation type |

### Non-Retryable Errors

The provider classifies these errors as non-retryable: permission denied, invalid credentials, project not found, processor not found, quota exceeded.

### Type Coercion for Field Extraction

Fields extracted via `document.extract_fields` are coerced to the types specified in the schema:

| Schema Type | Conversion |
|-------------|-----------|
| `string` | Pass-through |
| `number` | `parseFloat()` with fallback to `0` |
| `boolean` | Matches `"true"` / `"yes"` (case-insensitive) |
| `date` | Parsed to ISO 8601 string |

## Cost Estimation

| Operation | Cost |
|-----------|------|
| `document.ocr` | $0.001 / page |
| `document.extract_tables` | $0.01 / page |
| `document.extract_fields` | $0.01 / page |
| `image.describe` | $0.0025 / image |

Costs are fixed per-operation rates from `pricing.json`. Gemini description costs are per-image without token-based metering at the provider level.

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `prompt`, `model`, `system`, `generationConfig`, `temperature`, `top_p`, `top_k`, `max_output_tokens`, `seed`, `document_data` (SHA-256 hashed), `processor_id`, `mime_type`

**Non-deterministic parameters:** `request_id`

Document bytes are hashed with SHA-256 during normalization so cache keys for Document AI operations remain compact. Gemini operations include `seed` as a deterministic parameter — providing a fixed seed enables reproducible outputs and cache hits.

## Health Check

The health check calls `getProcessor` on the configured Document AI processor to validate GCP credentials and connectivity. Returns `{ healthy: true, latency: <ms> }` on success, or `{ healthy: false, error: "<message>" }` on failure. If no `documentAiProcessorId` is configured, the check still passes if client construction succeeds.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_PROJECT_ID` | GCP project ID |
| `GOOGLE_LOCATION` | GCP location for Document AI / Vertex AI |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | Document AI processor ID |
| `GOOGLE_GEMINI_MODEL` | Gemini model override |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account JSON path |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-anthropic`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic) — Alternative document extraction provider (Claude Sonnet)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
