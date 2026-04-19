import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { PredictionServiceClient } from '@google-cloud/aiplatform';
import { MediaProvider } from '@media-pipeline/provider-core';
import type { ProviderInput, ProviderOutput, ProviderHealth } from '@media-pipeline/provider-core';

export interface GoogleProviderConfig {
  projectId: string;
  location?: string;
  documentAiProcessorId?: string;
  geminiModel?: string;
  keyFile?: string;
  timeout?: number;
}

export class GoogleProvider extends MediaProvider {
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
        await (client as any).getProcessor({ name });
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

    const document = (response as any).document;
    let text: string;

    if (outputFormat === 'structured_json') {
      text = JSON.stringify(document, null, 2);
    } else if (outputFormat === 'markdown') {
      text = this.formatAsMarkdown(document);
    } else {
      text = document.text || '';
    }

    const data = Buffer.from(text);
    const cost = this.estimateCost('ocr', imageData.length);

    return {
      data,
      mimeType:
        outputFormat === 'markdown'
          ? 'text/markdown'
          : outputFormat === 'structured_json'
            ? 'application/json'
            : 'text/plain',
      costUsd: cost,
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

    const document = (response as any).document;
    const tables = this.extractTablesFromDocument(document);

    let output: string;
    if (outputFormat === 'json') {
      output = JSON.stringify(tables, null, 2);
    } else {
      output = tables.map((t) => this.tableToMarkdown(t)).join('\n\n');
    }

    const data = Buffer.from(output);
    const cost = this.estimateCost('form', imageData.length);

    return {
      data,
      mimeType: outputFormat === 'json' ? 'application/json' : 'text/markdown',
      costUsd: cost,
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

    const document = (response as any).document;
    const extractedFields = this.extractFieldsFromDocument(document, fieldSchema);

    const data = Buffer.from(JSON.stringify(extractedFields, null, 2));
    const cost = this.estimateCost('entity', imageData.length);

    return {
      data,
      mimeType: 'application/json',
      costUsd: cost,
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

    const response = await (client.predict as any)({
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
    const cost = this.estimateCost('vision', imageData.length);

    return {
      data: Buffer.from(description),
      mimeType: 'text/plain',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        operation: input.operation,
        detailLevel,
        model: this.config.geminiModel || this.defaultGeminiModel,
      },
    };
  }

  private formatAsMarkdown(document: any): string {
    // Simple markdown formatting of document text
    let markdown = '';
    for (const page of document.pages || []) {
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          for (const word of paragraph.words || []) {
            for (const symbol of word.symbols || []) {
              markdown += symbol.text;
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

  private extractTablesFromDocument(document: any): any[] {
    const tables: any[] = [];
    for (const page of document.pages || []) {
      for (const table of page.tables || []) {
        const tableData = {
          headers: [] as string[],
          rows: [] as string[][],
        };

        // Extract header row
        if (table.headerRows && table.headerRows[0]) {
          tableData.headers = table.headerRows[0].cells.map(
            (cell: any) => cell.layout?.textAnchor?.text || ''
          );
        }

        // Extract data rows
        for (const row of table.bodyRows || []) {
          const rowData = row.cells.map((cell: any) => cell.layout?.textAnchor?.text || '');
          tableData.rows.push(rowData);
        }

        tables.push(tableData);
      }
    }
    return tables;
  }

  private tableToMarkdown(table: any): string {
    let md = '| ' + table.headers.join(' | ') + ' |\n';
    md += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';

    for (const row of table.rows) {
      md += '| ' + row.join(' | ') + ' |\n';
    }

    return md;
  }

  private extractFieldsFromDocument(
    document: any,
    schema: Record<string, string>
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

  private convertType(value: string, type: string): any {
    switch (type) {
      case 'number':
        return parseFloat(value) || 0;
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

  private estimateCost(type: string, _bytes: number): number {
    const costs: Record<string, number> = {
      ocr: 0.001, // Per page
      form: 0.01, // Per page
      entity: 0.01, // Per page
      vision: 0.0025, // Per image
    };
    return costs[type] || 0.001;
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
