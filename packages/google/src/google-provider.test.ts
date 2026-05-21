import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from './google-provider.js';

const mockProcessDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    document: {
      text: 'Extracted text from document',
      textConfidence: 0.95,
      pages: [
        {
          blocks: [
            {
              paragraphs: [
                { words: [{ symbols: [{ text: 'Hello' }, { text: ' ' }, { text: 'World' }] }] },
              ],
            },
          ],
          tables: [
            {
              headerRows: [
                {
                  cells: [
                    { layout: { textAnchor: { text: 'Name' } } },
                    { layout: { textAnchor: { text: 'Age' } } },
                  ],
                },
              ],
              bodyRows: [
                {
                  cells: [
                    { layout: { textAnchor: { text: 'Alice' } } },
                    { layout: { textAnchor: { text: '30' } } },
                  ],
                },
              ],
            },
          ],
          formFields: [
            {
              fieldName: { textAnchor: { text: 'name' } },
              fieldValue: { textAnchor: { text: 'John Doe' } },
            },
          ],
        },
      ],
    },
  }),
);

const mockGetProcessor = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockPredict = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    predictions: [{ content: 'A beautiful sunset over mountains' }],
  }),
);

vi.mock('@google-cloud/documentai', () => {
  return {
    DocumentProcessorServiceClient: class MockDocumentProcessorServiceClient {
      processDocument = mockProcessDocument;
      getProcessor = mockGetProcessor;
    },
  };
});

vi.mock('@google-cloud/aiplatform', () => {
  return {
    PredictionServiceClient: class MockPredictionServiceClient {
      predict = mockPredict;
    },
  };
});

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GoogleProvider({
      projectId: 'test-project',
      location: 'us',
      documentAiProcessorId: 'test-processor',
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('google');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('document.ocr');
      expect(provider.supportedOperations).toContain('document.extract_tables');
      expect(provider.supportedOperations).toContain('document.extract_fields');
      expect(provider.supportedOperations).toContain('image.describe');
    });

    it('should use keyFile when provided', () => {
      const p = new GoogleProvider({ projectId: 'p', keyFile: '/path/to/key.json' });
      expect(p['clientOptions'].keyFilename).toBe('/path/to/key.json');
    });
  });

  describe('execute', () => {
    it('should execute document.ocr with plain_text format', async () => {
      const result = await provider.execute({
        operation: 'document.ocr',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          output_format: 'plain_text',
          mime_type: 'image/png',
        },
      });

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('text/plain');
    });

    it('should execute document.ocr with structured_json format', async () => {
      const result = await provider.execute({
        operation: 'document.ocr',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'structured_json' },
      });

      expect(result.mimeType).toBe('application/json');
    });

    it('should execute document.ocr with markdown format', async () => {
      const result = await provider.execute({
        operation: 'document.ocr',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'markdown' },
      });

      expect(result.mimeType).toBe('text/markdown');
    });

    it('should execute document.extract_tables', async () => {
      const result = await provider.execute({
        operation: 'document.extract_tables',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'markdown' },
      });

      expect(result.mimeType).toBe('text/markdown');
    });

    it('should execute document.extract_tables with json', async () => {
      const result = await provider.execute({
        operation: 'document.extract_tables',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'json' },
      });

      expect(result.mimeType).toBe('application/json');
    });

    it('should execute document.extract_fields', async () => {
      const result = await provider.execute({
        operation: 'document.extract_fields',
        config: {},
        params: {
          image_data: Buffer.from('test'),
          field_schema: { name: 'string', date: 'date', amount: 'number' },
        },
      });

      expect(result.mimeType).toBe('application/json');
    });

    it('should execute image.describe', async () => {
      const result = await provider.execute({
        operation: 'image.describe',
        config: {},
        params: { image_data: Buffer.from('test'), detail_level: 'detailed' },
      });

      expect(result.mimeType).toBe('text/plain');
    });

    it('should execute image.describe with brief detail', async () => {
      const result = await provider.execute({
        operation: 'image.describe',
        config: {},
        params: { image_data: Buffer.from('test'), detail_level: 'brief' },
      });

      expect(result.mimeType).toBe('text/plain');
    });

    it('should throw error for unsupported operation', async () => {
      await expect(
        provider.execute({
          operation: 'unknown.operation' as unknown as string,
          config: {},
          params: {},
        }),
      ).rejects.toThrow('Unsupported operation');
    });
  });

  describe('healthCheck', () => {
    it('should return healthy when processor exists', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health).toHaveProperty('latency');
    });

    it('should return healthy when no processor ID configured', async () => {
      const p = new GoogleProvider({ projectId: 'test-project' });
      const health = await p.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('should return unhealthy on error', async () => {
      mockGetProcessor.mockRejectedValueOnce(new Error('Not found'));
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  describe('estimateCost', () => {
    it('should return zero for unknown operation', async () => {
      const result = await provider.estimateCost({ operation: 'unknown', params: {}, config: {} });
      expect(result.costUsd).toBe(0);
    });

    it('should estimate cost for known operation', async () => {
      const result = await provider.estimateCost({
        operation: 'document.ocr',
        params: {},
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });
  });

  describe('formatAsMarkdown', () => {
    it('should format document text as markdown', () => {
      const doc = {
        pages: [
          {
            blocks: [
              {
                paragraphs: [
                  {
                    words: [{ symbols: [{ text: 'Hello' }] }, { symbols: [{ text: 'World' }] }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const md = (
        provider as unknown as { formatAsMarkdown(doc: Record<string, unknown>): string }
      ).formatAsMarkdown(doc);
      expect(md).toBe('Hello World');
    });

    it('should return empty string for empty document', () => {
      expect(
        (
          provider as unknown as { formatAsMarkdown(doc: Record<string, unknown>): string }
        ).formatAsMarkdown({}),
      ).toBe('');

      expect(
        (
          provider as unknown as { formatAsMarkdown(doc: Record<string, unknown>): string }
        ).formatAsMarkdown({ pages: [{ blocks: [] }] }),
      ).toBe('');
    });
  });

  describe('extractTablesFromDocument and tableToMarkdown', () => {
    it('should extract tables and convert to markdown', () => {
      const doc = {
        pages: [
          {
            tables: [
              {
                headerRows: [
                  {
                    cells: [
                      { layout: { textAnchor: { text: 'A' } } },
                      { layout: { textAnchor: { text: 'B' } } },
                    ],
                  },
                ],
                bodyRows: [
                  {
                    cells: [
                      { layout: { textAnchor: { text: '1' } } },
                      { layout: { textAnchor: { text: '2' } } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const tables = (
        provider as unknown as {
          extractTablesFromDocument(
            doc: Record<string, unknown>,
          ): Array<{ headers: string[]; rows: string[][] }>;
        }
      ).extractTablesFromDocument(doc);
      expect(tables).toHaveLength(1);
      expect(tables[0].headers).toEqual(['A', 'B']);

      const md = (
        provider as unknown as {
          tableToMarkdown(table: { headers: string[]; rows: string[][] }): string;
        }
      ).tableToMarkdown(tables[0]);
      expect(md).toContain('| A | B |');
      expect(md).toContain('| 1 | 2 |');
    });
  });

  describe('extractFieldsFromDocument', () => {
    it('should extract and convert fields by type', () => {
      const doc = {
        pages: [
          {
            formFields: [
              {
                fieldName: { textAnchor: { text: 'name' } },
                fieldValue: { textAnchor: { text: 'John' } },
              },
              {
                fieldName: { textAnchor: { text: 'age' } },
                fieldValue: { textAnchor: { text: '25' } },
              },
              {
                fieldName: { textAnchor: { text: 'active' } },
                fieldValue: { textAnchor: { text: 'true' } },
              },
              {
                fieldName: { textAnchor: { text: 'start_date' } },
                fieldValue: { textAnchor: { text: '2024-01-15' } },
              },
            ],
          },
        ],
      };
      const schema = { name: 'string', age: 'number', active: 'boolean', start_date: 'date' };
      const extracted = (
        provider as unknown as {
          extractFieldsFromDocument(
            doc: Record<string, unknown>,
            schema: Record<string, string>,
          ): Record<string, unknown>;
        }
      ).extractFieldsFromDocument(doc, schema);
      expect(extracted.name).toBe('John');
      expect(extracted.age).toBe(25);
      expect(extracted.active).toBe(true);
      expect(extracted.start_date).toBeDefined();
    });

    it('should return null for missing fields', () => {
      const doc = { pages: [{ formFields: [] }] };
      const extracted = (
        provider as unknown as {
          extractFieldsFromDocument(
            doc: Record<string, unknown>,
            schema: Record<string, string>,
          ): Record<string, unknown>;
        }
      ).extractFieldsFromDocument(doc, { missing: 'string' });
      expect(extracted.missing).toBeNull();
    });
  });

  describe('convertType', () => {
    it('should convert to number', () => {
      expect(
        (provider as unknown as { convertType(value: string, type: string): unknown }).convertType(
          '42',
          'number',
        ),
      ).toBe(42);
    });

    it('should convert to boolean', () => {
      expect(
        (provider as unknown as { convertType(value: string, type: string): unknown }).convertType(
          'true',
          'boolean',
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { convertType(value: string, type: string): unknown }).convertType(
          'yes',
          'boolean',
        ),
      ).toBe(true);
    });

    it('should convert to date', () => {
      const result = (
        provider as unknown as { convertType(value: string, type: string): unknown }
      ).convertType('2024-01-15', 'date');
      expect(result).toContain('2024');
    });

    it('should default to string', () => {
      expect(
        (provider as unknown as { convertType(value: string, type: string): unknown }).convertType(
          'hello',
          'string',
        ),
      ).toBe('hello');
    });
  });

  describe('getDescribePrompt', () => {
    it('should return brief prompt', () => {
      expect(
        (provider as unknown as { getDescribePrompt(format: string): string }).getDescribePrompt(
          'brief',
        ),
      ).toContain('1-2 sentences');
    });

    it('should return structured prompt', () => {
      expect(
        (provider as unknown as { getDescribePrompt(format: string): string }).getDescribePrompt(
          'structured',
        ),
      ).toContain('structured');
    });

    it('should default to detailed', () => {
      expect(
        (provider as unknown as { getDescribePrompt(format: string): string }).getDescribePrompt(
          'unknown',
        ),
      ).toContain('detailed');
    });
  });

  describe('isNonRetryableError', () => {
    it('should detect non-retryable errors', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('permission denied'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid credentials'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('project not found'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('processor not found'),
        ),
      ).toBe(true);
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('quota exceeded'),
        ),
      ).toBe(true);
    });

    it('should allow retry for transient errors', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('network timeout'),
        ),
      ).toBe(false);
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.GoogleProvider).toBeDefined();
    expect(mod.defineGoogleProvider).toBeDefined();
  });
});

describe('GoogleProvider.cacheConfig (F2)', () => {
  it('hashes document_data into document_sha256 so DocAI cache keys stay compact', () => {
    const out = GoogleProvider.cacheConfig.normalize({
      document_data: Buffer.from('pdf-bytes'),
      processor_id: 'projects/x/locations/us/processors/p1',
      mime_type: 'application/pdf',
    });
    expect(typeof out.document_sha256).toBe('string');
    expect((out.document_sha256 as string).length).toBe(64);
    expect(out).not.toHaveProperty('document_data');
    expect(out.processor_id).toBe('projects/x/locations/us/processors/p1');
  });

  it('honors explicit `seed` for Gemini determinism', () => {
    const out = GoogleProvider.cacheConfig.normalize({
      prompt: '  hi ',
      model: 'gemini-1.5-pro',
      seed: 42,
    });
    expect(out).toEqual({ prompt: 'hi', model: 'gemini-1.5-pro', seed: 42 });
  });
});
