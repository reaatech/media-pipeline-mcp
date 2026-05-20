# @reaatech/media-pipeline-mcp-google

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-google.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Google Cloud provider for the media pipeline framework. Uses Document AI for OCR, table extraction, and field extraction, plus Vertex AI Gemini for image description.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-google
# or
pnpm add @reaatech/media-pipeline-mcp-google
```

## Quick Start

```typescript
import { GoogleProvider } from "@reaatech/media-pipeline-mcp-google";

const provider = new GoogleProvider({
  projectId: "my-gcp-project",
  location: "us-central1",
  documentAiProcessorId: "abc123",
});

// OCR a document
const text = await provider.execute("document.ocr", {
  params: { artifact_id: "doc-123", output_format: "markdown" },
  config: {},
});

// Extract tables
const tables = await provider.execute("document.extract_tables", {
  params: { artifact_id: "doc-456", output_format: "json" },
  config: {},
});

// Describe an image with Gemini
const description = await provider.execute("image.describe", {
  params: { artifact_id: "img-789", detail: "detailed" },
  config: { model: "gemini-1.5-pro" },
});
```

## Supported Operations

| Operation | Service | Description |
|-----------|---------|-------------|
| `document.ocr` | Document AI | Text extraction with confidence scores |
| `document.extract_tables` | Document AI | Table extraction as markdown or JSON |
| `document.extract_fields` | Document AI | Structured field extraction with type mapping |
| `image.describe` | Vertex AI Gemini | Vision-based image description |

## Configuration

```typescript
interface GoogleProviderConfig {
  projectId: string;
  location?: string;                  // Default: "us-central1"
  documentAiProcessorId?: string;
  geminiModel?: string;               // Default: "gemini-1.5-pro"
  keyFile?: string;                   // Path to service account JSON
  apiEndpoint?: string;               // Custom API endpoint
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GOOGLE_PROJECT_ID` | GCP project ID |
| `GOOGLE_LOCATION` | GCP location for Document AI / Vertex AI |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | Document AI processor ID |
| `GOOGLE_GEMINI_MODEL` | Gemini model name |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service account JSON path |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `document.ocr` | $0.001 / page |
| `document.extract_tables` | $0.01 / page |
| `document.extract_fields` | $0.01 / page |
| `image.describe` | $0.0025 / image |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-anthropic`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic) — Alternative document extraction provider (Claude)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
