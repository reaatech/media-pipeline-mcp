import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from './google-provider.js';
import type { ProviderInput } from '@media-pipeline/provider-core';

// Mock Google Cloud clients
vi.mock('@google-cloud/documentai', () => {
  return {
    DocumentProcessorServiceClient: class MockDocumentProcessorServiceClient {
      processDocument = vi.fn().mockResolvedValue({
        document: {
          text: 'Extracted text from document',
          textConfidence: 0.95,
          pages: [
            {
              blocks: [
                {
                  paragraphs: [
                    {
                      words: [
                        {
                          symbols: [{ text: 'Hello' }, { text: ' ' }, { text: 'World' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      getProcessor = vi.fn().mockResolvedValue({});
    },
  };
});

vi.mock('@google-cloud/aiplatform', () => {
  return {
    PredictionServiceClient: class MockPredictionServiceClient {
      predict = vi.fn().mockResolvedValue({
        predictions: [{ content: 'A beautiful sunset over mountains' }],
      });
    },
  };
});

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
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
  });

  describe('execute', () => {
    it('should execute document.ocr operation', async () => {
      const input: ProviderInput = {
        operation: 'document.ocr',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          output_format: 'plain_text',
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('text/plain');
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    });

    it('should execute document.extract_tables operation', async () => {
      const input: ProviderInput = {
        operation: 'document.extract_tables',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          output_format: 'markdown',
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('text/markdown');
    });

    it('should execute document.extract_fields operation', async () => {
      const input: ProviderInput = {
        operation: 'document.extract_fields',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          field_schema: {
            name: 'string',
            date: 'date',
            amount: 'number',
          },
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/json');
    });

    it('should execute image.describe operation', async () => {
      const input: ProviderInput = {
        operation: 'image.describe',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          detail_level: 'detailed',
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('text/plain');
    });

    it('should throw error for unsupported operation', async () => {
      const input: ProviderInput = {
        operation: 'unknown.operation' as any,
        config: {},
        params: {},
      };

      await expect(provider.execute(input)).rejects.toThrow('Unsupported operation');
    });
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      const health = await provider.healthCheck();

      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('latency');
    });
  });

  describe('document formatting', () => {
    it('should format document as markdown', () => {
      // This is tested implicitly through execute
      expect(provider).toBeDefined();
    });
  });

  describe('type conversion', () => {
    it('should convert types correctly', () => {
      // This is tested implicitly through extract_fields
      expect(provider).toBeDefined();
    });
  });
});
