# @reaatech/media-pipeline-mcp-doc-extraction

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-doc-extraction.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-doc-extraction)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Document extraction operations including OCR, table extraction, structured field extraction, and document summarization via provider delegation to vision-capable LLMs.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-doc-extraction
# or
pnpm add @reaatech/media-pipeline-mcp-doc-extraction
```

## Quick Start

```typescript
import { createDocumentExtractionOperations } from "@reaatech/media-pipeline-mcp-doc-extraction";

const ops = createDocumentExtractionOperations();

// Extract text from a document
const text = await ops.ocr({
  artifact_id: "doc-123",
  output_format: "markdown",
});

// Extract tables
const tables = await ops.extractTables({
  artifact_id: "doc-456",
  output_format: "json",
});

// Extract structured fields
const fields = await ops.extractFields({
  artifact_id: "invoice-789",
  field_schema: {
    invoice_number: "string",
    date: "date",
    total: "number",
    line_items: "array",
  },
});

// Summarize content
const summary = await ops.summarize({
  artifact_id: "article-101",
  length: "medium",
  style: "paragraph",
});
```

## Supported Operations

| Operation | Description | Output Options |
|-----------|-------------|----------------|
| `ocr` | Extract text from document images | `plain_text` / `structured_json` / `markdown` |
| `extractTables` | Extract tables from documents | `markdown` / `json` |
| `extractFields` | Extract structured fields with schema | JSON with typed values |
| `summarize` | Summarize document content | `short` / `medium` / `long` with style options |

## API Reference

### `createDocumentExtractionOperations`

```typescript
function createDocumentExtractionOperations(): DocumentExtractionOperations;
```

### `DocumentExtractionOperations`

```typescript
class DocumentExtractionOperations {
  setProviders(providers: Provider[]): void;

  ocr(config: OCRConfig): Promise<Artifact>;
  extractTables(config: TableExtractionConfig): Promise<Artifact>;
  extractFields(config: FieldExtractionConfig): Promise<Artifact>;
  summarize(config: SummarizeConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `OCRConfig`

```typescript
interface OCRConfig {
  artifact_id: string;
  output_format?: "plain_text" | "structured_json" | "markdown";
}
```

#### `TableExtractionConfig`

```typescript
interface TableExtractionConfig {
  artifact_id: string;
  output_format?: "markdown" | "json";
}
```

#### `FieldExtractionConfig`

```typescript
interface FieldExtractionConfig {
  artifact_id: string;
  field_schema: FieldSchema;
}

// Schema definition with typed fields
interface FieldSchema {
  [fieldName: string]: "string" | "number" | "date" | "boolean" | "array";
}
```

#### `SummarizeConfig`

```typescript
interface SummarizeConfig {
  artifact_id: string;
  length?: "short" | "medium" | "long" | "detailed";
  style?: string;            // "bullet-points", "paragraph", "executive"
}
```

## Usage Patterns

### OCR with Different Output Formats

```typescript
// Plain text
const plainText = await ops.ocr({ artifact_id: "doc-1", output_format: "plain_text" });

// Markdown with formatting preserved
const markdown = await ops.ocr({ artifact_id: "doc-1", output_format: "markdown" });

// Structured JSON with metadata
const structured = await ops.ocr({ artifact_id: "doc-1", output_format: "structured_json" });
console.log(structured.metadata.pages); // 3
console.log(structured.metadata.confidence); // 0.95
```

### Table Extraction

```typescript
// Markdown table format
const mdTables = await ops.extractTables({
  artifact_id: "report-123",
  output_format: "markdown",
});
// Returns: | Header 1 | Header 2 |\n|----------|----------|\n| Value A  | Value B  |

// JSON table format
const jsonTables = await ops.extractTables({
  artifact_id: "report-123",
  output_format: "json",
});
// Returns: { headers: [...], rows: [[...], [...]] }
console.log(jsonTables.metadata.tableCount); // 2
console.log(jsonTables.metadata.rowCount); // 15
```

### Schema-Driven Field Extraction

```typescript
const fields = await ops.extractFields({
  artifact_id: "invoice-123",
  field_schema: {
    invoice_number: "string",
    invoice_date: "date",
    due_date: "date",
    vendor_name: "string",
    vendor_tax_id: "string",
    subtotal: "number",
    tax: "number",
    total: "number",
    is_paid: "boolean",
    line_items: "array",
  },
});

console.log(fields.metadata.extracted);
// {
//   invoice_number: "INV-2024-001",
//   invoice_date: "2024-01-15",
//   total: 1499.99,
//   is_paid: true,
//   ...
// }
// Missing/unparseable fields are null
```

### Summarization Options

```typescript
// Short bullet-point summary
const short = await ops.summarize({
  artifact_id: "report-123",
  length: "short",
  style: "bullet-points",
});

// Detailed paragraph summary
const detailed = await ops.summarize({
  artifact_id: "report-123",
  length: "detailed",
  style: "paragraph",
});

console.log(detailed.metadata.compressionRatio); // 0.15 (15% of original length)
```

### Provider Fallback Chain

The operations automatically try the best-fit provider first:
1. Document-specific providers (Anthropic, Google) for OCR/extraction
2. Falls back to `image.describe` capable providers if document providers unavailable

```typescript
import { AnthropicProvider } from "@reaatech/media-pipeline-mcp-anthropic";
import { GoogleProvider } from "@reaatech/media-pipeline-mcp-google";

const ops = createDocumentExtractionOperations();
ops.setProviders([
  new GoogleProvider({ projectId: "my-project", documentAiProcessorId: "abc" }),
  new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
]);

// Google handles document-specific ops, Anthropic handles describe
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-anthropic`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic) — Document extraction via Claude
- [`@reaatech/media-pipeline-mcp-google`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google) — Document extraction via Document AI

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
