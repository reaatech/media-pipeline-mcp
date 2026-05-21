# @reaatech/media-pipeline-mcp-doc-extraction

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-doc-extraction.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-doc-extraction)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Document extraction operations — OCR, table extraction, structured field extraction, and content summarization — via provider delegation to vision-capable LLMs with automatic fallback chains.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-doc-extraction
# or
pnpm add @reaatech/media-pipeline-mcp-doc-extraction
```

## Feature Overview

- **OCR (Optical Character Recognition)** — extract text from document images and PDFs in plain text, markdown, or structured JSON formats
- **Table extraction** — extract tables from documents as markdown tables or structured JSON with headers and rows
- **Field extraction** — schema-driven extraction of typed fields (string, number, date, boolean, array) from documents
- **Content summarization** — summarize document content in multiple lengths (short, medium, long) and styles (bullet-points, paragraph, executive)
- **Multi-provider routing** — operation-based lookup with preferred provider selection
- **Automatic fallback** — falls back to `image.describe` capable providers when document-specific providers are unavailable (Google → Anthropic → OpenAI vision)
- **Provider-agnostic** — works with Anthropic, Google Document AI, OpenAI, and any conformant provider

## Quick Start

```typescript
import { createDocumentExtractionOperations } from "@reaatech/media-pipeline-mcp-doc-extraction";
import { GoogleProvider } from "@reaatech/media-pipeline-mcp-google";
import { AnthropicProvider } from "@reaatech/media-pipeline-mcp-anthropic";

const ops = createDocumentExtractionOperations(artifactRegistry, storage);

// Register providers
ops.registerProvider("google", new GoogleProvider({
  projectId: "my-gcp-project",
  documentAiProcessorId: "processor-id",
}));
ops.registerProvider("anthropic", new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
}));

// Extract text from a document image
const text = await ops.ocr({
  artifactId: "scan-123",
  format: "markdown",
  language: "en",
});

// Extract tables from a scanned report
const tables = await ops.extractTables({
  artifactId: "report-456",
  outputFormat: "json",
});

// Extract typed fields using a schema
const fields = await ops.extractFields({
  artifactId: "invoice-789",
  fields: [
    { name: "invoice_number", type: "string", description: "The invoice number" },
    { name: "invoice_date", type: "date", description: "The invoice date" },
    { name: "total", type: "number", description: "The total amount" },
    { name: "is_paid", type: "boolean", description: "Whether the invoice is paid" },
    { name: "line_items", type: "array", description: "Line items" },
  ],
});

// Summarize a long document
const summary = await ops.summarize({
  artifactId: "article-101",
  length: "medium",
  style: "executive",
});
```

## API Reference

### `createDocumentExtractionOperations(artifactRegistry, storage)`

Factory function that creates a `DocumentExtractionOperations` instance.

```typescript
function createDocumentExtractionOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): DocumentExtractionOperations;
```

### `DocumentExtractionOperations`

Main class providing all document extraction and summarization capabilities. Operations delegate to registered providers based on operation type with automatic fallback chains.

```typescript
class DocumentExtractionOperations {
  constructor(artifactRegistry: ArtifactRegistry, storage: ArtifactStore);

  registerProvider(name: string, provider: MediaProvider): void;

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
  artifactId: string;                  // ID of the document image or PDF
  format?: "plain-text" | "structured-json" | "markdown";  // Output format (default: "plain-text")
  language?: string;                   // Language code (e.g., "en", "es")
  provider?: string;                   // Force specific provider
}
```

#### `TableExtractionConfig`

```typescript
interface TableExtractionConfig {
  artifactId: string;                  // ID of the document image or PDF
  outputFormat?: "markdown" | "json";  // Output format (default: "markdown")
  provider?: string;                   // Force specific provider
}
```

#### `FieldExtractionConfig`

```typescript
interface FieldSchema {
  name: string;                        // Field name
  type: "string" | "number" | "date" | "boolean" | "array";  // Field type
  description?: string;                // Human-readable description
}

interface FieldExtractionConfig {
  artifactId: string;                  // ID of the document, text, or image artifact
  fields: FieldSchema[];               // Schema of fields to extract
  provider?: string;                   // Force specific provider
}
```

#### `SummarizeConfig`

```typescript
interface SummarizeConfig {
  artifactId: string;                                       // ID of the document
  length?: "short" | "medium" | "long";                     // Summary length (default: "medium")
  style?: "bullet-points" | "paragraph" | "executive";      // Summary style (default: "paragraph")
  provider?: string;                                         // Force specific provider
}
```

## Usage Patterns

### OCR with Different Output Formats

```typescript
// Plain text (default)
const plainText = await ops.ocr({
  artifactId: "doc-1",
  format: "plain-text",
  language: "en",
});

// Markdown with headings preserved
const markdown = await ops.ocr({
  artifactId: "doc-1",
  format: "markdown",
});
console.log(markdown.metadata.confidence); // 0.95
console.log(markdown.metadata.pageCount);  // 3

// Structured JSON with metadata
const structured = await ops.ocr({
  artifactId: "doc-1",
  format: "structured-json",
});
// Returns JSON with text, confidence, and language fields
const parsed = JSON.parse((await storage.get(structured.id)).data.toString());
console.log(parsed.text);
console.log(parsed.confidence);
```

### Table Extraction in Multiple Formats

```typescript
// Markdown table format
const mdTables = await ops.extractTables({
  artifactId: "report-123",
  outputFormat: "markdown",
});
// Returns markdown table: | Header 1 | Header 2 |\n|----------|----------|\n| Value A  | Value B  |
console.log(mdTables.metadata.tableCount);  // 1
console.log(mdTables.metadata.rowCount);    // 15

// JSON table format
const jsonTables = await ops.extractTables({
  artifactId: "report-123",
  outputFormat: "json",
});
// Returns structured JSON with headers and rows arrays
console.log(jsonTables.metadata.columnCount);  // 3
```

### Schema-Driven Field Extraction

```typescript
const fields = await ops.extractFields({
  artifactId: "invoice-123",
  fields: [
    { name: "invoice_number", type: "string", description: "Invoice number" },
    { name: "invoice_date", type: "date", description: "Date of invoice" },
    { name: "due_date", type: "date", description: "Payment due date" },
    { name: "vendor_name", type: "string", description: "Vendor company name" },
    { name: "vendor_tax_id", type: "string", description: "VAT/GST/Tax ID" },
    { name: "subtotal", type: "number", description: "Subtotal before tax" },
    { name: "tax", type: "number", description: "Tax amount" },
    { name: "total", type: "number", description: "Total including tax" },
    { name: "is_paid", type: "boolean", description: "Payment status" },
    { name: "line_items", type: "array", description: "List of line items" },
  ],
});

const extracted = JSON.parse(
  (await storage.get(fields.id)).data.toString()
);
// {
//   "invoice_number": "INV-2024-001",
//   "invoice_date": "2024-01-15",
//   "total": 1499.99,
//   "is_paid": true,
//   ...
// }
// Missing or unparseable fields are null in the output

console.log(fields.metadata.fieldCount);         // 10
console.log(fields.metadata.extractedFields);    // ["invoice_number", "invoice_date", ...]
```

### Summarization with Style Options

```typescript
// Short bullet-point summary
const short = await ops.summarize({
  artifactId: "report-123",
  length: "short",
  style: "bullet-points",
});

// Medium paragraph summary (default)
const medium = await ops.summarize({
  artifactId: "report-123",
  length: "medium",
  style: "paragraph",
});

// Long executive summary for decision-makers
const long = await ops.summarize({
  artifactId: "report-123",
  length: "long",
  style: "executive",
});

console.log(long.metadata.compressionRatio);  // 0.15 (15% of original)
console.log(long.metadata.originalLength);    // byte count of input
```

### Provider Fallback Chain

Operations automatically try the best-fit provider first, then fall back:

1. Document-specific providers (Google Document AI, Anthropic Claude) for OCR/extraction
2. Falls back to `image.describe` capable providers (OpenAI GPT-4 Vision) if document providers are unavailable

```typescript
const ops = createDocumentExtractionOperations(artifactRegistry, storage);

// Register multiple providers — operations route intelligently
ops.registerProvider("google", new GoogleProvider({
  projectId: "my-gcp-project",
  documentAiProcessorId: "processor-id",
}));
ops.registerProvider("anthropic", new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
}));
ops.registerProvider("openai", new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
}));

// Force a specific provider
const result = await ops.ocr({
  artifactId: "doc-1",
  provider: "anthropic",  // explicitly use Anthropic Claude
});

// Without provider specified, uses best available:
// - document.ocr → tries Google, then Anthropic, then OpenAI vision
// - document.extract_fields → same fallback chain
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and interfaces
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-anthropic`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-anthropic) — Document extraction via Claude
- [`@reaatech/media-pipeline-mcp-google`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-google) — Document extraction via Document AI
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Vision-based fallback via GPT-4

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
