# Document Extraction

## Capability

OCR, table extraction, field extraction, and document summarization using vision models (Google Document AI, Anthropic Claude, OpenAI GPT-4o) for processing images of documents, PDFs, and structured forms.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `document.ocr` | `{ artifact_id: string, output_format?: 'plain_text' \| 'structured_json' \| 'markdown', language?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `document.extract_tables` | `{ artifact_id: string, output_format?: 'markdown' \| 'json', page_number?: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `document.extract_fields` | `{ artifact_id: string, field_schema: object, page_number?: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `document.summarize` | `{ artifact_id: string, length?: 'short' \| 'medium' \| 'long' \| 'detailed', style?: string, language?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |

## Usage Examples

### Example 1: OCR on document image

**Tool call:**
```json
{
  "artifact_id": "artifact-doc-image",
  "output_format": "structured",
  "language": "en"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-ocr-text",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-ocr-text.json",
    "mimeType": "application/json",
    "metadata": {
      "page_count": 1,
      "language": "en",
      "confidence": 0.97,
      "word_count": 342,
      "blocks": [
        {
          "type": "heading",
          "text": "INVOICE",
          "confidence": 0.99,
          "bounding_box": { "x": 100, "y": 50, "width": 200, "height": 40 }
        },
        {
          "type": "paragraph",
          "text": "Invoice Number: INV-2024-001",
          "confidence": 0.98,
          "bounding_box": { "x": 50, "y": 120, "width": 300, "height": 20 }
        }
      ]
    }
  },
  "cost_usd": 0.015,
  "duration_ms": 4500
}
```

### Example 2: Extract tables from document

**Tool call:**
```json
{
  "artifact_id": "artifact-spreadsheet-image",
  "output_format": "markdown"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-table-md",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-table-md.md",
    "mimeType": "text/markdown",
    "metadata": {
      "table_count": 1,
      "tables": [
        {
          "headers": ["Product", "Quantity", "Price", "Total"],
          "rows": [
            ["Widget A", "10", "$25.00", "$250.00"],
            ["Widget B", "5", "$30.00", "$150.00"],
            ["Widget C", "3", "$45.00", "$135.00"]
          ],
          "row_count": 3,
          "column_count": 4
        }
      ]
    }
  },
  "cost_usd": 0.02,
  "duration_ms": 6500
}
```

### Example 3: Extract structured fields

**Tool call:**
```json
{
  "artifact_id": "artifact-invoice",
  "schema": [
    { "name": "invoice_number", "type": "string", "description": "The invoice number" },
    { "name": "invoice_date", "type": "date", "description": "The invoice date" },
    { "name": "total_amount", "type": "number", "description": "The total amount due" },
    { "name": "vendor_name", "type": "string", "description": "The vendor company name" },
    { "name": "customer_name", "type": "string", "description": "The customer name" }
  ]
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-extracted-fields",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-extracted-fields.json",
    "mimeType": "application/json",
    "metadata": {
      "fields": {
        "invoice_number": "INV-2024-001",
        "invoice_date": "2024-01-15",
        "total_amount": 535.00,
        "vendor_name": "Acme Supplies Inc.",
        "customer_name": "John Smith"
      },
      "confidence": {
        "invoice_number": 0.99,
        "invoice_date": 0.97,
        "total_amount": 0.98,
        "vendor_name": 0.95,
        "customer_name": 0.93
      }
    }
  },
  "cost_usd": 0.03,
  "duration_ms": 8500
}
```

### Example 4: Summarize document

**Tool call:**
```json
{
  "artifact_id": "artifact-long-document",
  "length": "short",
  "style": "bullet points",
  "language": "en"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-summary",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-summary.txt",
    "mimeType": "text/plain",
    "metadata": {
      "original_word_count": 5420,
      "summary_word_count": 125,
      "compression_ratio": 0.023,
      "language": "en",
      "style": "bullet points"
    }
  },
  "cost_usd": 0.025,
  "duration_ms": 7200
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback |
| `DOCUMENT_UNREADABLE` | Document quality too low or corrupted | Return error, suggest improving quality |
| `LANGUAGE_NOT_SUPPORTED` | Requested language not available | List supported languages |
| `SCHEMA_INVALID` | Field extraction schema is malformed | Return validation errors |
| `TIMEOUT` | Processing exceeded timeout | Fail with actionable error |

## Security Considerations

- **PII detection** — Automatic detection and optional redaction of personal information
- **Document retention** — Configurable retention policies for processed documents
- **Access control** — Restrict access to sensitive documents
- **Data encryption** — Encrypt documents at rest and in transit

## Performance Characteristics

| Metric | Target |
|--------|--------|
| OCR (1 page) | 2-5s |
| Table extraction (1 table) | 3-8s |
| Field extraction (5 fields) | 4-10s |
| Summarization (1000 words) | 3-7s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCUMENT_EXTRACTION_DEFAULT_PROVIDER` | `google_docai` | Default document processing provider |
| `DOCUMENT_EXTRACTION_DEFAULT_LANGUAGE` | `en` | Default language for OCR |
| `DOCUMENT_EXTRACTION_TIMEOUT_MS` | `60000` | Timeout for document processing |
| `DOCUMENT_EXTRACTION_MAX_PAGES` | `100` | Maximum pages per document |
| `DOCUMENT_EXTRACTION_PII_REDACTION` | `false` | Auto-redact PII in outputs |

## Testing

```typescript
describe('document-extraction', () => {
  it('should perform OCR on document image', async () => {
    const docArtifact = await createTestArtifact('image', { mimeType: 'image/png' });

    const result = await extractOCR({
      artifact_id: docArtifact.id,
      output_format: 'structured',
      language: 'en'
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.word_count).toBeGreaterThan(0);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should extract tables from document', async () => {
    const docArtifact = await createTestArtifact('image');

    const result = await extractTables({
      artifact_id: docArtifact.id,
      output_format: 'markdown'
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.table_count).toBeGreaterThan(0);
  });

  it('should extract structured fields from form', async () => {
    const docArtifact = await createTestArtifact('image');

    const result = await extractFields({
      artifact_id: docArtifact.id,
      schema: [
        { name: 'name', type: 'string', description: 'Person name' },
        { name: 'email', type: 'string', description: 'Email address' },
        { name: 'age', type: 'number', description: 'Age in years' }
      ]
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.fields).toBeDefined();
    expect(result.artifact.metadata.fields.name).toBeDefined();
  });

  it('should summarize document', async () => {
    const docArtifact = await createTestArtifact('text', { word_count: 5000 });

    const result = await summarizeDocument({
      artifact_id: docArtifact.id,
      length: 'short',
      style: 'bullet points'
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.summary_word_count).toBeLessThan(result.artifact.metadata.original_word_count);
  });

  it('should handle multi-page documents', async () => {
    const docArtifact = await createTestArtifact('image', { page_count: 5 });

    const result = await extractOCR({
      artifact_id: docArtifact.id,
      output_format: 'structured'
    });

    expect(result.artifact.metadata.page_count).toBe(5);
  });

  it('should use fallback provider on failure', async () => {
    const mockGoogle = { ocr: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockClaude = { ocr: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await ocrWithFallback({ artifact_id: 'test' }, {
      primary: mockGoogle,
      fallbacks: [mockClaude]
    });

    expect(result.artifact).toBeDefined();
  });
});
