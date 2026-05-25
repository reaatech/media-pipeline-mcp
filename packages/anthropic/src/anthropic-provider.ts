import Anthropic from '@anthropic-ai/sdk';
import type {
  CostEstimate,
  PricingTable,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeout?: number;
}

export class AnthropicProvider extends MediaProvider {
  // F2: per-plan table — `prompt, model, system, all params except metadata` are
  // deterministic; `metadata` is non-det (request-tracing field).
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'model',
      'system',
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'stop_sequences',
      'image_data',
      'image_url',
      'document_data',
    ],
    nonDeterministicParams: ['metadata', 'user_id'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const normalized: Record<string, unknown> = {};
      if (inputs.prompt !== undefined)
        normalized.prompt = String(inputs.prompt).trim().replace(/\s+/g, ' ');
      if (inputs.model !== undefined) normalized.model = inputs.model;
      if (inputs.system !== undefined)
        normalized.system = String(inputs.system).trim().replace(/\s+/g, ' ');
      if (inputs.max_tokens !== undefined) normalized.max_tokens = inputs.max_tokens;
      if (inputs.temperature !== undefined) normalized.temperature = inputs.temperature;
      if (inputs.top_p !== undefined) normalized.top_p = inputs.top_p;
      if (inputs.top_k !== undefined) normalized.top_k = inputs.top_k;
      if (inputs.stop_sequences !== undefined) normalized.stop_sequences = inputs.stop_sequences;
      if (inputs.image_url !== undefined) normalized.image_url = inputs.image_url;
      return normalized;
    },
  };

  // §0.6 — anthropic streams text responses token-by-token across all text-
  // shaped operations. No native webhook surface.
  readonly supportsStreaming = new Set([
    'image.describe',
    'document.ocr',
    'document.extract_tables',
    'document.extract_fields',
    'document.summarize',
  ]);
  readonly supportsWebhooks = false;

  readonly name = 'anthropic';
  readonly supportedOperations = [
    'image.describe',
    'document.ocr',
    'document.extract_tables',
    'document.extract_fields',
    'document.summarize',
  ];

  private client: Anthropic;
  private config: AnthropicProviderConfig;

  private defaultModel = 'claude-sonnet-4-20250514';
  private defaultMaxTokens = 4096;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Simple health check - just verify we can create a message
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hello' }],
      });

      return {
        healthy: true,
        latency: Date.now() - startTime,
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  async estimateCost(input: ProviderInput): Promise<CostEstimate> {
    const opPricing = (pricing as PricingTable)[input.operation];
    if (!opPricing) {
      return { costUsd: 0, currency: 'USD' };
    }
    const model = (input.params.model as string) || this.config.model || this.defaultModel;
    const entry = opPricing[model];
    if (!entry) {
      return { costUsd: 0.01, currency: 'USD' };
    }
    const inputPerUnit = (entry.input.perUnit as number) ?? 3.0;
    const outputPerUnit = (entry.output?.perUnit as number) ?? 15.0;
    const estimatedInputTokens = input.operation === 'image.describe' ? 1200 : 800;
    const estimatedOutputTokens = 300;
    const costUsd =
      (estimatedInputTokens / 1_000_000) * inputPerUnit +
      (estimatedOutputTokens / 1_000_000) * outputPerUnit;
    return { costUsd, currency: 'USD', estimatedDurationMs: entry.expectedDurationMs };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();

    try {
      switch (input.operation) {
        case 'image.describe':
          return this.describeImage(input, startTime);
        case 'document.ocr':
          return this.performOCR(input, startTime);
        case 'document.extract_tables':
          return this.extractTables(input, startTime);
        case 'document.extract_fields':
          return this.extractFields(input, startTime);
        case 'document.summarize':
          return this.summarize(input, startTime);
        default:
          throw new Error(`Unsupported operation: ${input.operation}`);
      }
    } catch (error) {
      throw new Error(`Anthropic provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private async describeImage(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const detailLevel = (input.params.detail_level as string) || 'detailed';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    const prompt = this.getDescribePrompt(detailLevel);

    const response = await this.client.messages.create({
      model: this.config.model || this.defaultModel,
      max_tokens: this.config.maxTokens || this.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: imageData.toString('base64'),
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const description = response.content[0].type === 'text' ? response.content[0].text : '';
    const costUsd = await this.lookupCost(input, response.usage);

    return {
      data: Buffer.from(description),
      mimeType: 'text/plain',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        model: this.config.model || this.defaultModel,
        operation: input.operation,
        detailLevel,
        tokenCount: response.usage.output_tokens,
      },
    };
  }

  private async performOCR(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const outputFormat = (input.params.output_format as string) || 'plain_text';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    const prompt = this.getOCRPrompt(outputFormat);

    const response = await this.client.messages.create({
      model: this.config.model || this.defaultModel,
      max_tokens: this.config.maxTokens || this.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: imageData.toString('base64'),
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cost = await this.lookupCost(input, response.usage);

    return {
      data: Buffer.from(text),
      mimeType: outputFormat === 'markdown' ? 'text/markdown' : 'text/plain',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        model: this.config.model || this.defaultModel,
        operation: input.operation,
        outputFormat,
        tokenCount: response.usage.output_tokens,
      },
    };
  }

  private async extractTables(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const outputFormat = (input.params.output_format as string) || 'markdown';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    const prompt = `Extract all tables from this document image. Return the tables in ${outputFormat} format. If there are multiple tables, separate them with headers.`;

    const response = await this.client.messages.create({
      model: this.config.model || this.defaultModel,
      max_tokens: this.config.maxTokens || this.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: imageData.toString('base64'),
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cost = await this.lookupCost(input, response.usage);

    return {
      data: Buffer.from(text),
      mimeType: outputFormat === 'markdown' ? 'text/markdown' : 'application/json',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        model: this.config.model || this.defaultModel,
        operation: input.operation,
        outputFormat,
        tokenCount: response.usage.output_tokens,
      },
    };
  }

  private async extractFields(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const fieldSchema = input.params.field_schema as Record<string, string>;
    const mimeType = (input.params.mime_type as string) || 'image/png';

    const schemaStr = JSON.stringify(fieldSchema, null, 2);
    const prompt = `Extract the following fields from this document image. Return the result as valid JSON matching this schema:\n\n${schemaStr}\n\nOnly return the JSON object, no additional text.`;

    const response = await this.client.messages.create({
      model: this.config.model || this.defaultModel,
      max_tokens: this.config.maxTokens || this.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: imageData.toString('base64'),
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cost = await this.lookupCost(input, response.usage);

    return {
      data: Buffer.from(text),
      mimeType: 'application/json',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        model: this.config.model || this.defaultModel,
        operation: input.operation,
        tokenCount: response.usage.output_tokens,
        fields: Object.keys(fieldSchema),
      },
    };
  }

  private async summarize(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    // For text artifacts, we can process directly
    const content = input.params.content as string;
    const imageData = input.params.image_data as Buffer | undefined;
    const length = (input.params.length as string) || 'medium';
    const style = (input.params.style as string) || 'neutral';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    const lengthMap: Record<string, string> = {
      short: '1-2 sentences',
      medium: '1 paragraph',
      long: '2-3 paragraphs',
      detailed: 'comprehensive summary with key points',
    };

    const prompt = `Provide a ${lengthMap[length] || 'medium'} summary in a ${style} style.`;

    let messageContent: Anthropic.MessageParam['content'];

    if (imageData) {
      messageContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data: imageData.toString('base64'),
          },
        },
        { type: 'text', text: prompt },
      ];
    } else {
      messageContent = [{ type: 'text', text: `Document content:\n\n${content}\n\n${prompt}` }];
    }

    const response = await this.client.messages.create({
      model: this.config.model || this.defaultModel,
      max_tokens: this.config.maxTokens || this.defaultMaxTokens,
      messages: [
        {
          role: 'user',
          content: messageContent,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const costUsd = await this.lookupCost(input, response.usage);

    return {
      data: Buffer.from(text),
      mimeType: 'text/plain',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        model: this.config.model || this.defaultModel,
        operation: input.operation,
        length,
        style,
        tokenCount: response.usage.output_tokens,
      },
    };
  }

  private getDescribePrompt(detailLevel: string): string {
    const prompts: Record<string, string> = {
      brief: 'Describe this image briefly in 1-2 sentences.',
      detailed:
        'Provide a detailed description of this image, including key elements, colors, composition, and any text visible.',
      structured:
        'Analyze this image and provide a structured description with: 1) Main subject, 2) Setting/background, 3) Colors and lighting, 4) Any text or notable details.',
    };
    return prompts[detailLevel] || prompts.detailed;
  }

  private getOCRPrompt(outputFormat: string): string {
    const prompts: Record<string, string> = {
      plain_text:
        'Extract all text from this image. Return only the text content, preserving line breaks and formatting where possible.',
      structured_json:
        'Extract all text from this image and return it as a structured JSON object with fields for: title, paragraphs, lists, and any other structural elements.',
      markdown:
        'Extract all text from this image and format it as markdown, preserving headings, lists, and other formatting.',
    };
    return prompts[outputFormat] || prompts.plain_text;
  }

  private async lookupCost(
    input: ProviderInput,
    usage: { input_tokens: number; output_tokens: number },
  ): Promise<number> {
    const opPricing = (pricing as PricingTable)[input.operation];
    if (!opPricing)
      return (usage.input_tokens / 1_000_000) * 3 + (usage.output_tokens / 1_000_000) * 15;
    const model = (input.params.model as string) || this.config.model || this.defaultModel;
    const entry = opPricing[model];
    const inputPerUnit = (entry?.input.perUnit as number) ?? 3.0;
    const outputPerUnit = (entry?.output?.perUnit as number) ?? 15.0;
    return (
      (usage.input_tokens / 1_000_000) * inputPerUnit +
      (usage.output_tokens / 1_000_000) * outputPerUnit
    );
  }

  protected isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'authentication failed',
      'invalid api key',
      'permission denied',
      'insufficient credits',
      'content filtering',
      'policy violation',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineAnthropicProvider(config: AnthropicProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}
