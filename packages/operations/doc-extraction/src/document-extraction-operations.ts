import type { Readable } from 'node:stream';
import type { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { Artifact } from '@reaatech/media-pipeline-mcp';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { v4 as uuidv4 } from 'uuid';

export interface OCRConfig {
  artifactId: string;
  format?: 'plain-text' | 'structured-json' | 'markdown';
  language?: string;
  provider?: string; // Provider name to use (e.g., 'openai', 'google')
}

export interface TableExtractionConfig {
  artifactId: string;
  outputFormat?: 'markdown' | 'json';
  provider?: string; // Provider name to use
}

export interface FieldSchema {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'array';
  description?: string;
}

export interface FieldExtractionConfig {
  artifactId: string;
  fields: FieldSchema[];
  provider?: string; // Provider name to use
}

export interface SummarizeConfig {
  artifactId: string;
  length?: 'short' | 'medium' | 'long';
  style?: 'bullet-points' | 'paragraph' | 'executive';
  provider?: string; // Provider name to use
}

export class DocumentExtractionOperations {
  private providers: Map<string, MediaProvider> = new Map();

  constructor(
    private artifactRegistry: ArtifactRegistry,
    private storage: ArtifactStore,
  ) {}

  /**
   * Register a provider for use with operations
   */
  registerProvider(name: string, provider: MediaProvider): void {
    this.providers.set(name, provider);
  }

  /**
   * Get a provider by name, or the first one that supports the operation
   */
  private getProvider(operation: string, preferred?: string): MediaProvider | undefined {
    if (preferred && this.providers.has(preferred)) {
      const provider = this.providers.get(preferred);
      if (provider?.supportedOperations.includes(operation)) {
        return provider;
      }
    }

    for (const provider of this.providers.values()) {
      if (provider.supportedOperations.includes(operation)) {
        return provider;
      }
    }
    return undefined;
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async ocr(config: OCRConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || (artifact.type !== 'image' && artifact.type !== 'document')) {
      throw new Error(`Artifact ${config.artifactId} is not an image or document`);
    }

    // Get image data for vision model
    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    // Use vision provider for OCR (OpenAI GPT-4 Vision or similar)
    const provider =
      this.getProvider('document.ocr', config.provider) ||
      this.getProvider('image.describe', config.provider);

    if (!provider) {
      throw new Error('No provider available for document.ocr operation');
    }

    const format = config.format || 'plain-text';
    const prompt =
      format === 'structured-json'
        ? 'Extract all text from this document and return as structured JSON with fields: text, confidence, language.'
        : format === 'markdown'
          ? 'Extract all text from this document and format as markdown, preserving headings and structure.'
          : 'Extract all text from this document.';

    const input: ProviderInput = {
      operation: 'image.describe',
      config: {},
      params: {
        artifact_data: imageData,
        prompt: prompt,
        detail: 'full',
        model: 'gpt-4o',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: format === 'structured-json' ? 'application/json' : 'text/plain',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'ocr',
        format,
        language: config.language || 'en',
        confidence: 0.95,
        pageCount: 1,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'text',
      uri,
      mimeType: format === 'structured-json' ? 'application/json' : 'text/plain',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async extractTables(config: TableExtractionConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (!artifact || (artifact.type !== 'image' && artifact.type !== 'document')) {
      throw new Error(`Artifact ${config.artifactId} is not an image or document`);
    }

    const storageResult = await this.storage.get(config.artifactId);
    const imageData = await this.streamToBuffer(storageResult.data as Readable);

    const provider =
      this.getProvider('document.extract_tables', config.provider) ||
      this.getProvider('image.describe', config.provider);

    if (!provider) {
      throw new Error('No provider available for document.extract_tables operation');
    }

    const format = config.outputFormat || 'markdown';
    const prompt =
      format === 'markdown'
        ? 'Extract all tables from this document and format as markdown tables.'
        : 'Extract all tables from this document and return as JSON with headers and rows arrays.';

    const input: ProviderInput = {
      operation: 'image.describe',
      config: {},
      params: {
        artifact_data: imageData,
        prompt: prompt,
        detail: 'full',
        model: 'gpt-4o',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const tableOutput = (result.data as Buffer).toString('utf-8');

    // Parse table data for metadata
    let tableCount = 1;
    let rowCount = 1;
    let columnCount = 3;

    if (format === 'json') {
      try {
        const parsed = JSON.parse(tableOutput);
        if (Array.isArray(parsed)) {
          tableCount = parsed.length;
          if (parsed[0]?.rows) {
            rowCount = parsed[0].rows.length;
            columnCount = parsed[0].headers?.length || parsed[0].rows[0]?.length || 3;
          }
        }
      } catch {
        // Keep defaults
      }
    } else {
      // Count markdown tables
      tableCount = (tableOutput.match(/^\|/gm) || []).length > 0 ? 1 : 0;
      rowCount = (tableOutput.match(/\n/g) || []).length;
      columnCount =
        (tableOutput.match(/\|/g) || []).length > 0
          ? (tableOutput.split('\n')[0]?.match(/\|/g) || []).length - 1
          : 3;
    }

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: format === 'markdown' ? 'text/markdown' : 'application/json',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'extract_tables',
        format,
        tableCount,
        rowCount,
        columnCount,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'text',
      uri,
      mimeType: format === 'markdown' ? 'text/markdown' : 'application/json',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async extractFields(config: FieldExtractionConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    if (
      !artifact ||
      (artifact.type !== 'image' && artifact.type !== 'document' && artifact.type !== 'text')
    ) {
      throw new Error(`Artifact ${config.artifactId} is not a document or text`);
    }

    let inputData: Buffer;

    if (artifact.type === 'text') {
      // For text artifacts, get the text content
      const storageResult = await this.storage.get(config.artifactId);
      inputData = await this.streamToBuffer(storageResult.data as Readable);
    } else {
      // For image/document artifacts, get the image data
      const storageResult = await this.storage.get(config.artifactId);
      inputData = await this.streamToBuffer(storageResult.data as Readable);
    }

    const provider =
      this.getProvider('document.extract_fields', config.provider) ||
      this.getProvider('image.describe', config.provider);

    if (!provider) {
      throw new Error('No provider available for document.extract_fields operation');
    }

    // Build extraction prompt based on schema
    const fieldDescriptions = config.fields
      .map((f) => `- ${f.name} (${f.type}): ${f.description || 'Extract this field'}`)
      .join('\n');

    const prompt = `Extract the following fields from this document and return as JSON:\n${fieldDescriptions}\n\nReturn ONLY a JSON object with the field names as keys.`;

    const input: ProviderInput = {
      operation: 'image.describe',
      config: {},
      params: {
        artifact_data: inputData,
        prompt: prompt,
        detail: 'full',
        model: 'gpt-4o',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const extractedJson = (result.data as Buffer).toString('utf-8');

    // Try to parse and validate the extracted fields
    let extractedFields: Record<string, unknown>;
    try {
      extractedFields = JSON.parse(extractedJson);
    } catch {
      // If parsing fails, wrap in a field
      extractedFields = { raw_extraction: extractedJson };
    }

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: 'application/json',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'extract_fields',
        fieldCount: config.fields.length,
        fields: config.fields.map((f) => f.name),
        extractedFields: Object.keys(extractedFields),
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'text',
      uri,
      mimeType: 'application/json',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async summarize(config: SummarizeConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(config.artifactId);
    const validTypes: string[] = ['text', 'document', 'image'];
    if (!artifact || !validTypes.includes(artifact.type)) {
      throw new Error(`Artifact ${config.artifactId} is not a document, text, or image`);
    }

    let inputData: Buffer;

    if (artifact.type === 'text') {
      const storageResult = await this.storage.get(config.artifactId);
      inputData = await this.streamToBuffer(storageResult.data as Readable);
    } else {
      const storageResult = await this.storage.get(config.artifactId);
      inputData = await this.streamToBuffer(storageResult.data as Readable);
    }

    const provider =
      this.getProvider('document.summarize', config.provider) ||
      this.getProvider('image.describe', config.provider);

    if (!provider) {
      throw new Error('No provider available for document.summarize operation');
    }

    const length = config.length || 'medium';
    const style = config.style || 'paragraph';

    const styleInstructions: Record<string, string> = {
      'bullet-points': 'Provide the summary as bullet points.',
      paragraph: 'Provide the summary as a coherent paragraph.',
      executive: 'Provide an executive summary suitable for decision-makers.',
    };

    const lengthInstructions: Record<string, string> = {
      short: 'Keep it brief (2-3 sentences).',
      medium: 'Provide a moderate length summary (1 paragraph).',
      long: 'Provide a detailed summary (2-3 paragraphs).',
    };

    const prompt = `Summarize this content. ${lengthInstructions[length]} ${styleInstructions[style]}`;

    const input: ProviderInput = {
      operation: 'image.describe',
      config: {},
      params: {
        artifact_data: inputData,
        prompt: prompt,
        detail: 'full',
        model: 'gpt-4o',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const summaryText = (result.data as Buffer).toString('utf-8');

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: 'text/plain',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: config.artifactId,
        operation: 'summarize',
        length,
        style,
        originalLength: inputData.length,
        compressionRatio: summaryText.length / inputData.length,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'text',
      uri,
      mimeType: 'text/plain',
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }
}

export function createDocumentExtractionOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): DocumentExtractionOperations {
  return new DocumentExtractionOperations(artifactRegistry, storage);
}
