import type { ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';

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

    it('should execute image.describe with default params', async () => {
      const input: ProviderInput = {
        operation: 'image.describe',
        config: {},
        params: { image_data: Buffer.from('test') },
      };

      const result = await provider.execute(input);
      expect(result.mimeType).toBe('text/plain');
    });

    it('should execute image.describe with structured detail', async () => {
      const input: ProviderInput = {
        operation: 'image.describe',
        config: {},
        params: { image_data: Buffer.from('test'), detail_level: 'structured' },
      };

      const result = await provider.execute(input);
      expect(result.mimeType).toBe('text/plain');
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

    it('should execute document.ocr with markdown format', async () => {
      const input: ProviderInput = {
        operation: 'document.ocr',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'markdown' },
      };

      const result = await provider.execute(input);
      expect(result.mimeType).toBe('text/markdown');
    });

    it('should execute document.ocr with structured_json format', async () => {
      const input: ProviderInput = {
        operation: 'document.ocr',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'structured_json' },
      };

      const result = await provider.execute(input);
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

    it('should execute document.extract_tables with json format', async () => {
      const input: ProviderInput = {
        operation: 'document.extract_tables',
        config: {},
        params: { image_data: Buffer.from('test'), output_format: 'json' },
      };

      const result = await provider.execute(input);
      expect(result.mimeType).toBe('application/json');
    });

    it('should execute document.extract_fields operation', async () => {
      const input: ProviderInput = {
        operation: 'document.extract_fields',
        config: {},
        params: {
          image_data: Buffer.from('test-image'),
          field_schema: { name: 'string', date: 'string', amount: 'number' },
          mime_type: 'image/png',
        },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('application/json');
    });

    it('should execute document.summarize with text', async () => {
      const input: ProviderInput = {
        operation: 'document.summarize',
        config: {},
        params: { content: 'This is a long document.', length: 'short', style: 'neutral' },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
      expect(result.mimeType).toBe('text/plain');
    });

    it('should execute document.summarize with image data', async () => {
      const input: ProviderInput = {
        operation: 'document.summarize',
        config: {},
        params: { image_data: Buffer.from('test'), length: 'long', style: 'formal' },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
    });

    it('should execute document.summarize with detailed length', async () => {
      const input: ProviderInput = {
        operation: 'document.summarize',
        config: {},
        params: { content: 'doc', length: 'detailed' },
      };

      const result = await provider.execute(input);
      expect(result.data).toBeDefined();
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
    it('should return health status', async () => {
      const health = await provider.healthCheck();
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('latency');
    });

    it('should return unhealthy on error', async () => {
      const failingProvider = new AnthropicProvider({ apiKey: '' });
      const mockClient = failingProvider['client'];
      mockClient.messages.create = vi.fn().mockRejectedValue(new Error('Auth failed'));

      const health = await failingProvider.healthCheck();
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
        operation: 'image.describe',
        params: { model: 'claude-sonnet-4-20250514' },
        config: {},
      });
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('should fallback to default cost when entry not found', async () => {
      const result = await provider.estimateCost({
        operation: 'document.ocr',
        params: { model: 'unknown-model' },
        config: {},
      });
      expect(result.costUsd).toBe(0.01);
    });
  });

  describe('getDescribePrompt', () => {
    it('should return brief prompt', () => {
      const prompt = (
        provider as unknown as { getDescribePrompt(format: string): string }
      ).getDescribePrompt('brief');
      expect(prompt).toContain('1-2 sentences');
    });

    it('should return detailed prompt', () => {
      const prompt = (
        provider as unknown as { getDescribePrompt(format: string): string }
      ).getDescribePrompt('detailed');
      expect(prompt).toContain('detailed description');
    });

    it('should return structured prompt', () => {
      const prompt = (
        provider as unknown as { getDescribePrompt(format: string): string }
      ).getDescribePrompt('structured');
      expect(prompt).toContain('structured description');
    });

    it('should default to detailed for unknown level', () => {
      const prompt = (
        provider as unknown as { getDescribePrompt(format: string): string }
      ).getDescribePrompt('unknown');
      expect(prompt).toContain('detailed');
    });
  });

  describe('getOCRPrompt', () => {
    it('should return plain_text prompt', () => {
      expect(
        (provider as unknown as { getOCRPrompt(format: string): string }).getOCRPrompt(
          'plain_text',
        ),
      ).toContain('Extract all text');
    });

    it('should return structured_json prompt', () => {
      expect(
        (provider as unknown as { getOCRPrompt(format: string): string }).getOCRPrompt(
          'structured_json',
        ),
      ).toContain('structured JSON');
    });

    it('should return markdown prompt', () => {
      expect(
        (provider as unknown as { getOCRPrompt(format: string): string }).getOCRPrompt('markdown'),
      ).toContain('markdown');
    });

    it('should default to plain_text for unknown format', () => {
      expect(
        (provider as unknown as { getOCRPrompt(format: string): string }).getOCRPrompt('unknown'),
      ).toContain('Extract all text');
    });
  });

  describe('isNonRetryableError', () => {
    it('should identify authentication error', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('Authentication failed'),
        ),
      ).toBe(true);
    });

    it('should identify invalid api key', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('invalid api key'),
        ),
      ).toBe(true);
    });

    it('should identify permission denied', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('permission denied'),
        ),
      ).toBe(true);
    });

    it('should identify insufficient credits', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('insufficient credits'),
        ),
      ).toBe(true);
    });

    it('should identify content filtering', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('content filtering'),
        ),
      ).toBe(true);
    });

    it('should identify policy violation', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('policy violation'),
        ),
      ).toBe(true);
    });

    it('should allow retry for network error', () => {
      expect(
        (provider as unknown as { isNonRetryableError(e: Error): boolean }).isNonRetryableError(
          new Error('network timeout'),
        ),
      ).toBe(false);
    });
  });

  describe('index exports', () => {
    it('should export all expected symbols', async () => {
      const mod = await import('./index.js');
      expect(mod.AnthropicProvider).toBeDefined();
      expect(mod.defineAnthropicProvider).toBeDefined();
    });
  });

  describe('lookupCost', () => {
    it('should calculate cost from pricing for known operation', async () => {
      const cost = await (
        provider as unknown as {
          lookupCost(
            input: {
              operation: string;
              params: Record<string, unknown>;
              config: Record<string, unknown>;
            },
            usage: { input_tokens: number; output_tokens: number },
          ): Promise<number>;
        }
      ).lookupCost(
        { operation: 'image.describe', params: {}, config: {} },
        { input_tokens: 1000, output_tokens: 500 },
      );
      expect(cost).toBeGreaterThan(0);
    });

    it('should use default rates for unknown operation', async () => {
      const cost = await (
        provider as unknown as {
          lookupCost(
            input: {
              operation: string;
              params: Record<string, unknown>;
              config: Record<string, unknown>;
            },
            usage: { input_tokens: number; output_tokens: number },
          ): Promise<number>;
        }
      ).lookupCost(
        { operation: 'unknown', params: {}, config: {} },
        { input_tokens: 1000, output_tokens: 500 },
      );
      expect(cost).toBeGreaterThan(0);
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('AnthropicProvider.cacheConfig (F2)', () => {
  it('drops metadata (non-deterministic) and trims prompt/system whitespace', () => {
    const out = AnthropicProvider.cacheConfig.normalize({
      prompt: '  what is   2+2 ',
      system: '  you are   helpful ',
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      metadata: { user_id: 'should-not-appear' },
    });
    expect(out).toEqual({
      prompt: 'what is 2+2',
      system: 'you are helpful',
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
    });
  });

  it('declares metadata as non-deterministic per the plan F2 table', () => {
    expect(AnthropicProvider.cacheConfig.nonDeterministicParams).toContain('metadata');
  });
});
