# @reaatech/media-pipeline-mcp-anthropic

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-anthropic.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Anthropic provider for the media pipeline framework. Leverages Claude Sonnet (vision-capable) for image description, OCR, table extraction, field extraction, and document summarization.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-anthropic
# or
pnpm add @reaatech/media-pipeline-mcp-anthropic
```

## Quick Start

```typescript
import { AnthropicProvider } from "@reaatech/media-pipeline-mcp-anthropic";

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Describe an image
const description = await provider.execute("image.describe", {
  params: { artifact_id: "img-123", detail: "detailed" },
  config: {},
});

// Extract text from a document
const text = await provider.execute("document.ocr", {
  params: { artifact_id: "doc-456", output_format: "markdown" },
  config: {},
});

// Extract structured fields
const fields = await provider.execute("document.extract_fields", {
  params: {
    artifact_id: "invoice-789",
    field_schema: {
      invoice_number: "string",
      date: "date",
      total_amount: "number",
      vendor_name: "string",
    },
  },
  config: {},
});

// Summarize content
const summary = await provider.execute("document.summarize", {
  params: { artifact_id: "article-101", length: "medium", style: "paragraph" },
  config: {},
});
```

## Supported Operations

| Operation | Description | Output Options |
|-----------|-------------|----------------|
| `image.describe` | Claude Vision image analysis | `brief` / `detailed` / `structured` |
| `document.ocr` | Text extraction from documents | `plain_text` / `structured_json` / `markdown` |
| `document.extract_tables` | Table extraction | `markdown` / `json` |
| `document.extract_fields` | Structured field extraction | Schema-based JSON output |
| `document.summarize` | Content summarization | `short` / `medium` / `long` / `detailed` with style options |

## Cost Estimation

| Metric | Cost |
|--------|------|
| Input tokens | $3.00 / 1M tokens |
| Output tokens | $15.00 / 1M tokens |

## Configuration

```typescript
interface AnthropicProviderConfig {
  apiKey: string;
  model?: string; // Default: claude-sonnet-4-20250514
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative vision provider (GPT-4o)
- [`@reaatech/media-pipeline-mcp-google`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google) — Alternative document extraction provider

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
