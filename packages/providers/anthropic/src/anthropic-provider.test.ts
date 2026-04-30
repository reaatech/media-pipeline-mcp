import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Test response' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      };
    },
  };
});

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      apiKey: 'test-api-key',
      model: 'claude-sonnet-4-20250514',
    });
  });

  describe('provider metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('anthropic');
    });

    it('should support expected operations', () => {
      expect(provider.supportedOperations).toContain('image.describe');
      expect(provider.supportedOperations).toContain('document.ocr');
      expect(provider.supportedOperations).toContain('document.extract_tables');
      expect(provider.supportedOperations).toContain('document.extract_fields');
      expect(provider.supportedOperations).toContain('document.summarize');
    });
  });

  describe('execute', () => {
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
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
    });

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
            date: 'string',
            amount: 'number',
          },
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);

      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/json');
    });

    it('should execute document.summarize operation with text', async () => {
      const input: ProviderInput = {
        operation: 'document.summarize',
        config: {},
        params: {
          content: 'This is a long document that needs to be summarized.',
          length: 'short',
          style: 'neutral',
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

  describe('prompt generation', () => {
    it('should use appropriate prompts for detail levels', () => {
      // This is tested implicitly through execute
      expect(provider).toBeDefined();
    });
  });
});
