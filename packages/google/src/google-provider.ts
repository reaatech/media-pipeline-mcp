import { createHash } from 'node:crypto';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';

// Minimal structural type for Document AI responses — the SDK's full type tree is large
// and we only touch a tiny subset (pages > blocks > paragraphs > words > symbols, plus tables and formFields).
interface DocumentAITextAnchor {
  textAnchor?: { text?: string };
}
interface DocumentAICell {
  layout?: DocumentAITextAnchor;
}
interface DocumentAIRow {
  cells: DocumentAICell[];
}
interface DocumentAITable {
  headerRows?: DocumentAIRow[];
  bodyRows?: DocumentAIRow[];
}
interface DocumentAIFormField {
  fieldName?: DocumentAITextAnchor;
  fieldValue?: DocumentAITextAnchor;
}
interface DocumentAISymbol {
  text?: string;
}
interface DocumentAIWord {
  symbols?: DocumentAISymbol[];
}
interface DocumentAIParagraph {
  words?: DocumentAIWord[];
}
interface DocumentAIBlock {
  paragraphs?: DocumentAIParagraph[];
}
interface DocumentAIPage {
  blocks?: DocumentAIBlock[];
  tables?: DocumentAITable[];
  formFields?: DocumentAIFormField[];
}
interface DocumentAIDocument {
  text?: string;
  textConfidence?: number;
  pages?: DocumentAIPage[];
}
interface DocumentAITableData {
  headers: string[];
  rows: string[][];
}

import type {
  CostEstimate,
  PricingTable,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

export interface GoogleProviderConfig {
  projectId: string;
  location?: string;
  documentAiProcessorId?: string;
  geminiModel?: string;
  keyFile?: string;
  timeout?: number;
}

export class GoogleProvider extends MediaProvider {
  // F2: per-plan table — Vertex Gemini is non-deterministic without an explicit
  // `seed`; cache key includes `prompt, model, generationConfig`. DocAI is
  // deterministic on (sha256(document), processorId).
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'model',
      'system',
      'generationConfig',
      'temperature',
      'top_p',
      'top_k',
      'max_output_tokens',
      'seed',
      'document_data',
      'processor_id',
      'mime_type',
    ],
    nonDeterministicParams: ['request_id'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const normalized: Record<string, unknown> = {};
      if (inputs.prompt !== undefined)
        normalized.prompt = String(inputs.prompt).trim().replace(/\s+/g, ' ');
      if (inputs.model !== undefined) normalized.model = inputs.model;
      if (inputs.system !== undefined)
        normalized.system = String(inputs.system).trim().replace(/\s+/g, ' ');
      if (inputs.generationConfig !== undefined)
        normalized.generationConfig = inputs.generationConfig;
      if (inputs.temperature !== undefined) normalized.temperature = inputs.temperature;
      if (inputs.top_p !== undefined) normalized.top_p = inputs.top_p;
      if (inputs.top_k !== undefined) normalized.top_k = inputs.top_k;
      if (inputs.max_output_tokens !== undefined)
        normalized.max_output_tokens = inputs.max_output_tokens;
      if (inputs.seed !== undefined) normalized.seed = inputs.seed;
      if (inputs.processor_id !== undefined) normalized.processor_id = inputs.processor_id;
      if (inputs.mime_type !== undefined) normalized.mime_type = inputs.mime_type;
      // Hash document bytes so DocAI cache key stays compact.
      if (inputs.document_data !== undefined) {
        const buf = Buffer.isBuffer(inputs.document_data)
          ? inputs.document_data
          : Buffer.from(String(inputs.document_data));
        normalized.document_sha256 = createHash('sha256').update(buf).digest('hex');
      }
      return normalized;
    },
  };

  // §0.6 — Vertex Gemini streams; Document AI is synchronous and one-shot.
  // No native webhook surface.
  readonly supportsStreaming = new Set(['image.describe']);
  readonly supportsWebhooks = false;

  readonly name = 'google';
  readonly supportedOperations = [
    'document.ocr',
    'document.extract_tables',
    'document.extract_fields',
    'image.describe',
  ];

  private config: GoogleProviderConfig;
  private documentClient: DocumentProcessorServiceClient | null = null;
  private geminiClient: PredictionServiceClient | null = null;
  private clientOptions: Record<string, string>;

  private defaultLocation = 'us';
  private defaultGeminiModel = 'gemini-1.5-pro';

  constructor(config: GoogleProviderConfig) {
    super();
    this.config = config;
    this.clientOptions = {};
    if (config.keyFile) {
      this.clientOptions.keyFilename = config.keyFile;
    }
  }

  private getDocumentClient(): DocumentProcessorServiceClient {
    if (!this.documentClient) {
      this.documentClient = new DocumentProcessorServiceClient({
        projectId: this.config.projectId,
        apiEndpoint: `${this.config.location || this.defaultLocation}-documentai.googleapis.com`,
        ...this.clientOptions,
      });
    }
    return this.documentClient;
  }

  private getGeminiClient(): PredictionServiceClient {
    if (!this.geminiClient) {
      this.geminiClient = new PredictionServiceClient({
        apiEndpoint: `${this.config.location || 'us-central1'}-aiplatform.googleapis.com`,
        ...this.clientOptions,
      });
    }
    return this.geminiClient;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Check Document AI availability
      if (this.config.documentAiProcessorId) {
        const client = this.getDocumentClient();
        const name = `projects/${this.config.projectId}/locations/${this.config.location || this.defaultLocation}/processors/${this.config.documentAiProcessorId}`;
        await (
          client as unknown as { getProcessor: (req: { name: string }) => Promise<unknown> }
        ).getProcessor({ name });
      }

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
    const entry = opPricing[Object.keys(opPricing)[0]];
    return {
      costUsd: entry?.input.perUnit ?? 0.001,
      currency: 'USD',
      estimatedDurationMs: entry?.expectedDurationMs,
    };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();

    try {
      switch (input.operation) {
        case 'document.ocr':
          return this.performOCR(input, startTime);
        case 'document.extract_tables':
          return this.extractTables(input, startTime);
        case 'document.extract_fields':
          return this.extractFields(input, startTime);
        case 'image.describe':
          return this.describeImage(input, startTime);
        default:
          throw new Error(`Unsupported operation: ${input.operation}`);
      }
    } catch (error) {
      throw new Error(`Google provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private async performOCR(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const outputFormat = (input.params.output_format as string) || 'plain_text';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    // Use Document AI for OCR
    const client = this.getDocumentClient();
    const processorName = `projects/${this.config.projectId}/locations/${this.config.location || this.defaultLocation}/processors/${this.config.documentAiProcessorId || 'ocr-processor'}`;

    const response = await client.processDocument({
      name: processorName,
      rawDocument: {
        content: imageData.toString('base64'),
        mimeType,
      },
    });

    const document = (
      (response as unknown as [{ document: DocumentAIDocument }])[0] ?? {
        document: {},
      }
    ).document;
    let text: string;

    if (outputFormat === 'structured_json') {
      text = JSON.stringify(document, null, 2);
    } else if (outputFormat === 'markdown') {
      text = this.formatAsMarkdown(document);
    } else {
      text = document.text || '';
    }

    const data = Buffer.from(text);
    const costUsd = await this.lookupCost(input);

    return {
      data,
      mimeType:
        outputFormat === 'markdown'
          ? 'text/markdown'
          : outputFormat === 'structured_json'
            ? 'application/json'
            : 'text/plain',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        operation: input.operation,
        outputFormat,
        pageCount: document.pages?.length || 1,
        confidence: document.textConfidence || 0,
      },
    };
  }

  private async extractTables(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const outputFormat = (input.params.output_format as string) || 'markdown';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    // Use Document AI with form parsing
    const client = this.getDocumentClient();
    const processorName = `projects/${this.config.projectId}/locations/${this.config.location || this.defaultLocation}/processors/${this.config.documentAiProcessorId || 'form-parser'}`;

    const response = await client.processDocument({
      name: processorName,
      rawDocument: {
        content: imageData.toString('base64'),
        mimeType,
      },
    });

    const document = (
      (response as unknown as [{ document: DocumentAIDocument }])[0] ?? {
        document: {},
      }
    ).document;
    const tables = this.extractTablesFromDocument(document);

    let output: string;
    if (outputFormat === 'json') {
      output = JSON.stringify(tables, null, 2);
    } else {
      output = tables.map((t) => this.tableToMarkdown(t)).join('\n\n');
    }

    const data = Buffer.from(output);
    const costUsd = await this.lookupCost(input);

    return {
      data,
      mimeType: outputFormat === 'json' ? 'application/json' : 'text/markdown',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        operation: input.operation,
        outputFormat,
        tableCount: tables.length,
      },
    };
  }

  private async extractFields(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const fieldSchema = input.params.field_schema as Record<string, string>;
    const mimeType = (input.params.mime_type as string) || 'image/png';

    // Use Document AI with entity extraction
    const client = this.getDocumentClient();
    const processorName = `projects/${this.config.projectId}/locations/${this.config.location || this.defaultLocation}/processors/${this.config.documentAiProcessorId || 'entity-extractor'}`;

    const response = await client.processDocument({
      name: processorName,
      rawDocument: {
        content: imageData.toString('base64'),
        mimeType,
      },
    });

    const document = (
      (response as unknown as [{ document: DocumentAIDocument }])[0] ?? {
        document: {},
      }
    ).document;
    const extractedFields = this.extractFieldsFromDocument(document, fieldSchema);

    const data = Buffer.from(JSON.stringify(extractedFields, null, 2));
    const costUsd = await this.lookupCost(input);

    return {
      data,
      mimeType: 'application/json',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        operation: input.operation,
        fieldsExtracted: Object.keys(extractedFields).length,
        totalFields: Object.keys(fieldSchema).length,
      },
    };
  }

  private async describeImage(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const imageData = input.params.image_data as Buffer;
    const detailLevel = (input.params.detail_level as string) || 'detailed';
    const mimeType = (input.params.mime_type as string) || 'image/png';

    // Use Gemini for image description
    const client = this.getGeminiClient();
    const model = `projects/${this.config.projectId}/locations/${this.config.location || 'us-central1'}/publishers/google/models/${this.config.geminiModel || this.defaultGeminiModel}`;

    const prompt = this.getDescribePrompt(detailLevel);

    const response = await (
      client.predict as unknown as (req: {
        endpoint: string;
        instances: Array<{ content: string; mimeType: string; prompt: string }>;
      }) => Promise<{ predictions?: Array<{ content?: string }> }>
    )({
      endpoint: model,
      instances: [
        {
          content: imageData.toString('base64'),
          mimeType,
          prompt,
        },
      ],
    });

    const description = response.predictions?.[0]?.content || '';
    const costUsd = await this.lookupCost(input);

    return {
      data: Buffer.from(description),
      mimeType: 'text/plain',
      costUsd,
      durationMs: Date.now() - startTime,
      metadata: {
        operation: input.operation,
        detailLevel,
        model: this.config.geminiModel || this.defaultGeminiModel,
      },
    };
  }

  private formatAsMarkdown(document: DocumentAIDocument): string {
    // Simple markdown formatting of document text
    let markdown = '';
    for (const page of document.pages || []) {
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            for (const symbol of word.symbols || []) {
              markdown += symbol.text ?? '';
            }
            markdown += ' ';
          }
          markdown += '\n';
        }
        markdown += '\n';
      }
    }
    return markdown.trim();
  }

  private extractTablesFromDocument(document: DocumentAIDocument): DocumentAITableData[] {
    const tables: DocumentAITableData[] = [];
    for (const page of document.pages || []) {
      for (const table of page.tables || []) {
        const tableData: DocumentAITableData = {
          headers: [],
          rows: [],
        };

        // Extract header row
        if (table.headerRows?.[0]) {
          tableData.headers = table.headerRows[0].cells.map(
            (cell) => cell.layout?.textAnchor?.text || '',
          );
        }

        // Extract data rows
        for (const row of table.bodyRows || []) {
          const rowData = row.cells.map((cell) => cell.layout?.textAnchor?.text || '');
          tableData.rows.push(rowData);
        }

        tables.push(tableData);
      }
    }
    return tables;
  }

  private tableToMarkdown(table: DocumentAITableData): string {
    let md = `| ${table.headers.join(' | ')} |\n`;
    md += `| ${table.headers.map(() => '---').join(' | ')} |\n`;

    for (const row of table.rows) {
      md += `| ${row.join(' | ')} |\n`;
    }

    return md;
  }

  private extractFieldsFromDocument(
    document: DocumentAIDocument,
    schema: Record<string, string>,
  ): Record<string, unknown> {
    const extracted: Record<string, unknown> = {};

    for (const page of document.pages || []) {
      for (const field of page.formFields || []) {
        const fieldName = field.fieldName?.textAnchor?.text || '';
        const fieldValue = field.fieldValue?.textAnchor?.text || '';

        if (schema[fieldName]) {
          const type = schema[fieldName];
          extracted[fieldName] = this.convertType(fieldValue, type);
        }
      }
    }

    // Fill missing fields with null
    for (const field of Object.keys(schema)) {
      if (!(field in extracted)) {
        extracted[field] = null;
      }
    }

    return extracted;
  }

  private convertType(value: string, type: string): string | number | boolean {
    switch (type) {
      case 'number':
        return Number.parseFloat(value) || 0;
      case 'boolean':
        return value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
      case 'date':
        return new Date(value).toISOString();
      default:
        return value;
    }
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

  private async lookupCost(input: ProviderInput): Promise<number> {
    return (await this.estimateCost(input)).costUsd;
  }

  protected isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'permission denied',
      'invalid credentials',
      'project not found',
      'processor not found',
      'quota exceeded',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineGoogleProvider(config: GoogleProviderConfig): GoogleProvider {
  return new GoogleProvider(config);
}
