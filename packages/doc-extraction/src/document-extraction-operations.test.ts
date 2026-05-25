import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp-core';
import type {
  CostEstimate,
  ProviderHealth,
  ProviderInput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentExtractionOperations } from './document-extraction-operations.js';

interface MockProviderResult {
  data: Buffer;
  mimeType: string;
  costUsd: number;
}

class MockProvider extends MediaProvider {
  readonly name: string;
  readonly supportedOperations: string[];
  private mockResult: MockProviderResult;

  constructor(name: string, supportedOperations: string[], mockResult: MockProviderResult) {
    super();
    this.name = name;
    this.supportedOperations = supportedOperations;
    this.mockResult = mockResult;
  }

  async execute(_input: ProviderInput) {
    return { ...this.mockResult, metadata: {} };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }
  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: this.mockResult.costUsd ?? 0.001, currency: 'USD' };
  }
}

class MockStorage implements ArtifactStore {
  private store: Map<string, Buffer> = new Map();
  private metaStore: Map<string, ArtifactMeta> = new Map();

  async put(id: string, data: Buffer, meta: ArtifactMeta): Promise<string> {
    this.store.set(id, data);
    this.metaStore.set(id, meta);
    return `file:///storage/${id}`;
  }

  async get(id: string): Promise<{ data: Readable; meta: ArtifactMeta }> {
    const data = this.store.get(id);
    const meta = this.metaStore.get(id);
    if (!data || !meta) throw new Error(`Artifact ${id} not found`);
    return { data: Readable.from(data), meta };
  }

  async getSignedUrl(id: string, expiresIn?: number): Promise<string> {
    return `https://storage.example.com/signed/${id}?expires=${Date.now() + (expiresIn || 3600) * 1000}`;
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id);
    this.metaStore.delete(id);
  }
  async list(prefix?: string): Promise<ArtifactMeta[]> {
    return Array.from(this.metaStore.values()).filter(
      (m) => !prefix || (m.id ?? '').startsWith(prefix),
    );
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe('DocumentExtractionOperations', () => {
  let artifactRegistry: ArtifactRegistry;
  let storage: MockStorage;
  let operations: DocumentExtractionOperations;

  function registerArtifact(
    type: 'image' | 'video' | 'audio' | 'text' | 'document',
    id?: string,
  ): string {
    const artifact = artifactRegistry.register({
      type,
      uri: `file:///test.${type}`,
      mimeType: type === 'image' ? 'image/png' : 'text/plain',
      metadata: {},
    });
    const artId = id || artifact.id;
    storage.put(artId, Buffer.from('data'), {
      id: artId,
      type,
      mimeType: type === 'image' ? 'image/png' : 'text/plain',
      size: 4,
      metadata: {},
    } as ArtifactMeta);
    return artId;
  }

  beforeEach(() => {
    artifactRegistry = new ArtifactRegistry();
    storage = new MockStorage();
    operations = new DocumentExtractionOperations(artifactRegistry, storage);

    operations.registerProvider(
      'mock-ocr',
      new MockProvider('mock-ocr', ['document.ocr'], {
        data: Buffer.from('extracted-text'),
        mimeType: 'text/plain',
        costUsd: 0.001,
      }),
    );
    operations.registerProvider(
      'mock-tables',
      new MockProvider('mock-tables', ['document.extract_tables'], {
        data: Buffer.from('table-data'),
        mimeType: 'text/markdown',
        costUsd: 0.002,
      }),
    );
    operations.registerProvider(
      'mock-fields',
      new MockProvider('mock-fields', ['document.extract_fields'], {
        data: Buffer.from('{"field": "value"}'),
        mimeType: 'application/json',
        costUsd: 0.001,
      }),
    );
    operations.registerProvider(
      'mock-summarize',
      new MockProvider('mock-summarize', ['document.summarize'], {
        data: Buffer.from('summary-text'),
        mimeType: 'text/plain',
        costUsd: 0.005,
      }),
    );
  });

  describe('ocr', () => {
    it('should extract text with plain-text format', async () => {
      const artId = registerArtifact('image');
      const result = await operations.ocr({ artifactId: artId });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.format).toBe('plain-text');
    });

    it('should extract text with structured-json format', async () => {
      const artId = registerArtifact('image');
      const result = await operations.ocr({ artifactId: artId, format: 'structured-json' });
      expect(result.mimeType).toBe('application/json');
    });

    it('should extract text with markdown format', async () => {
      const artId = registerArtifact('image');
      const result = await operations.ocr({ artifactId: artId, format: 'markdown' });
      expect(result.mimeType).toBe('text/plain');
    });

    it('should fail for non-image/document artifact', async () => {
      const audioArtifact = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///test.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });
      await expect(operations.ocr({ artifactId: audioArtifact.id })).rejects.toThrow();
    });

    it('should fail when no provider available', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      const artId = registerArtifact('image');
      await expect(ops.ocr({ artifactId: artId })).rejects.toThrow('No provider available');
    });

    it('should use image.describe as fallback if no document.ocr provider', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      ops.registerProvider(
        'mock-vision',
        new MockProvider('mock-vision', ['image.describe'], {
          data: Buffer.from('vision-ocr'),
          mimeType: 'text/plain',
          costUsd: 0.001,
        }),
      );
      const artId = registerArtifact('image');
      const result = await ops.ocr({ artifactId: artId });
      expect(result.mimeType).toBe('text/plain');
    });

    it('should prefer specified provider', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      ops.registerProvider(
        'custom',
        new MockProvider('custom', ['document.ocr'], {
          data: Buffer.from('custom-result'),
          mimeType: 'text/plain',
          costUsd: 0.001,
        }),
      );
      const artId = registerArtifact('image');
      const result = await ops.ocr({ artifactId: artId, provider: 'custom' });
      expect(result.metadata.provider).toBe('custom');
    });
  });

  describe('extractTables', () => {
    it('should extract tables in markdown format', async () => {
      const artId = registerArtifact('image');
      const result = await operations.extractTables({ artifactId: artId });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/markdown');
    });

    it('should extract tables in json format', async () => {
      const artId = registerArtifact('image');
      const result = await operations.extractTables({ artifactId: artId, outputFormat: 'json' });
      expect(result.mimeType).toBe('application/json');
    });

    it('should fail for non-image/document artifact', async () => {
      const audio = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///a.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });
      await expect(operations.extractTables({ artifactId: audio.id })).rejects.toThrow();
    });

    it('should fail when no provider available', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      const artId = registerArtifact('image');
      await expect(ops.extractTables({ artifactId: artId })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('extractFields', () => {
    it('should extract fields from document', async () => {
      const artId = registerArtifact('image');
      const result = await operations.extractFields({
        artifactId: artId,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'number' },
        ],
      });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.fieldCount).toBe(2);
    });

    it('should extract fields from text artifact', async () => {
      const artId = registerArtifact('text');
      const result = await operations.extractFields({
        artifactId: artId,
        fields: [{ name: 'title', type: 'string' }],
      });
      expect(result.metadata.fieldCount).toBe(1);
    });

    it('should fail for invalid artifact type', async () => {
      const audio = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///a.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });
      await expect(
        operations.extractFields({ artifactId: audio.id, fields: [] }),
      ).rejects.toThrow();
    });

    it('should fail when no provider available', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      const artId = registerArtifact('image');
      await expect(ops.extractFields({ artifactId: artId, fields: [] })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('summarize', () => {
    it('should summarize text artifact with default settings', async () => {
      const artId = registerArtifact('text');
      const result = await operations.summarize({ artifactId: artId });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.length).toBe('medium');
      expect(result.metadata.style).toBe('paragraph');
    });

    it('should summarize with bullet-points style', async () => {
      const artId = registerArtifact('text');
      const result = await operations.summarize({ artifactId: artId, style: 'bullet-points' });
      expect(result.metadata.style).toBe('bullet-points');
    });

    it('should summarize with executive style', async () => {
      const artId = registerArtifact('text');
      const result = await operations.summarize({
        artifactId: artId,
        length: 'short',
        style: 'executive',
      });
      expect(result.metadata.length).toBe('short');
      expect(result.metadata.style).toBe('executive');
    });

    it('should summarize image artifact', async () => {
      const artId = registerArtifact('image');
      const result = await operations.summarize({ artifactId: artId });
      expect(result.type).toBe('text');
    });

    it('should fail for audio artifact', async () => {
      const audio = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///a.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });
      await expect(operations.summarize({ artifactId: audio.id })).rejects.toThrow();
    });

    it('should fail when no provider available', async () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      const artId = registerArtifact('text');
      await expect(ops.summarize({ artifactId: artId })).rejects.toThrow('No provider available');
    });
  });

  describe('getProvider (private)', () => {
    it('should return preferred provider if it supports operation', () => {
      const p = (
        operations as unknown as {
          getProvider(operation: string, preferred?: string): MediaProvider | undefined;
        }
      ).getProvider('document.ocr', 'mock-ocr');
      expect(p!.name).toBe('mock-ocr');
    });

    it('should return undefined when preferred does not support operation', () => {
      const p = (
        operations as unknown as {
          getProvider(operation: string, preferred?: string): MediaProvider | undefined;
        }
      ).getProvider('document.extract_tables', 'mock-ocr');
      expect(p!.name).toBe('mock-tables');
    });

    it('should return undefined when no provider supports operation', () => {
      const p = (
        operations as unknown as {
          getProvider(operation: string, preferred?: string): MediaProvider | undefined;
        }
      ).getProvider('unknown.op');
      expect(p).toBeUndefined();
    });
  });

  describe('registerProvider', () => {
    it('should register a provider', () => {
      const ops = new DocumentExtractionOperations(artifactRegistry, storage);
      ops.registerProvider(
        'test',
        new MockProvider('test', ['document.ocr'], {
          data: Buffer.from('x'),
          mimeType: 'text/plain',
          costUsd: 0,
        }),
      );
      const p = (
        ops as unknown as {
          getProvider(operation: string, preferred?: string): MediaProvider | undefined;
        }
      ).getProvider('document.ocr');
      expect(p!.name).toBe('test');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.DocumentExtractionOperations).toBeDefined();
    expect(mod.createDocumentExtractionOperations).toBeDefined();
  });
});
