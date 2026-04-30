import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentExtractionOperations } from './document-extraction-operations.js';

interface MockProvider {
  name: string;
  supportedOperations: string[];
  execute: (input: any) => Promise<any>;
  healthCheck: () => Promise<{ healthy: boolean }>;
}

function createMockProvider(
  name: string,
  supportedOperations: string[],
  mockResult: any,
): MockProvider {
  return {
    name,
    supportedOperations,
    execute: async () => mockResult,
    healthCheck: async () => ({ healthy: true }),
  };
}

// Mock storage implementation
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
    return {
      data: Readable.from(data),
      meta,
    };
  }

  async getSignedUrl(id: string, expiresIn?: number): Promise<string> {
    return `https://storage.example.com/signed/${id}?expires=${Date.now() + (expiresIn || 3600) * 1000}`;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
    this.metaStore.delete(id);
  }

  async list(prefix?: string): Promise<ArtifactMeta[]> {
    return Array.from(this.metaStore.values()).filter((m) => !prefix || m.id.startsWith(prefix));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe('DocumentExtractionOperations', () => {
  let artifactRegistry: ArtifactRegistry;
  let storage: MockStorage;
  let operations: DocumentExtractionOperations;

  beforeEach(() => {
    artifactRegistry = new ArtifactRegistry();
    storage = new MockStorage();
    operations = new DocumentExtractionOperations(artifactRegistry, storage);

    // Register mock providers for document operations
    operations.registerProvider(
      'mock-ocr',
      createMockProvider('mock-ocr', ['document.ocr'], {
        data: Buffer.from('extracted-text'),
        mimeType: 'text/plain',
        costUsd: 0.001,
      }),
    );

    operations.registerProvider(
      'mock-tables',
      createMockProvider('mock-tables', ['document.extract_tables'], {
        data: Buffer.from('table-data'),
        mimeType: 'text/markdown',
        costUsd: 0.002,
      }),
    );

    operations.registerProvider(
      'mock-fields',
      createMockProvider('mock-fields', ['document.extract_fields'], {
        data: Buffer.from('{"field": "value"}'),
        mimeType: 'application/json',
        costUsd: 0.001,
      }),
    );

    operations.registerProvider(
      'mock-summarize',
      createMockProvider('mock-summarize', ['document.summarize'], {
        data: Buffer.from('summary-text'),
        mimeType: 'text/plain',
        costUsd: 0.005,
      }),
    );
  });

  describe('ocr', () => {
    it('should extract text from image artifact with plain-text format', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///test.png',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 768 },
      });

      // Store the image data in storage using the artifact's ID as the key
      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 10,
        metadata: { width: 1024, height: 768 },
      });

      const result = await operations.ocr({ artifactId: imageArtifact.id });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.operation).toBe('ocr');
      expect(result.metadata.format).toBe('plain-text');
    });

    it('should extract text with structured-json format', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///test.png',
        mimeType: 'image/png',
        metadata: {},
      });

      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 10,
        metadata: {},
      });

      const result = await operations.ocr({
        artifactId: imageArtifact.id,
        format: 'structured-json',
      });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.format).toBe('structured-json');
    });

    it('should extract text with markdown format', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///test.png',
        mimeType: 'image/png',
        metadata: {},
      });

      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 10,
        metadata: {},
      });

      const result = await operations.ocr({ artifactId: imageArtifact.id, format: 'markdown' });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.format).toBe('markdown');
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
  });

  describe('extractTables', () => {
    it('should extract tables in markdown format', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///table.png',
        mimeType: 'image/png',
        metadata: {},
      });

      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 10,
        metadata: {},
      });

      const result = await operations.extractTables({ artifactId: imageArtifact.id });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/markdown');
      expect(result.metadata.operation).toBe('extract_tables');
    });

    it('should extract tables in JSON format', async () => {
      const imageArtifact = artifactRegistry.register({
        type: 'image',
        uri: 'file:///table.png',
        mimeType: 'image/png',
        metadata: {},
      });

      await storage.put(imageArtifact.id, Buffer.from('image-data'), {
        id: imageArtifact.id,
        type: 'image',
        mimeType: 'image/png',
        size: 10,
        metadata: {},
      });

      const result = await operations.extractTables({
        artifactId: imageArtifact.id,
        outputFormat: 'json',
      });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.operation).toBe('extract_tables');
    });
  });

  describe('extractFields', () => {
    it('should extract fields from document', async () => {
      const docArtifact = artifactRegistry.register({
        type: 'document',
        uri: 'file:///doc.pdf',
        mimeType: 'application/pdf',
        metadata: {},
      });

      await storage.put(docArtifact.id, Buffer.from('document-data'), {
        id: docArtifact.id,
        type: 'document',
        mimeType: 'application/pdf',
        size: 100,
        metadata: {},
      });

      const result = await operations.extractFields({
        artifactId: docArtifact.id,
        fields: [
          { name: 'invoice_number', type: 'string' },
          { name: 'total_amount', type: 'number' },
          { name: 'date', type: 'date' },
        ],
      });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.operation).toBe('extract_fields');
      expect(result.metadata.fieldCount).toBe(3);
    });

    it('should extract fields from text artifact', async () => {
      const textArtifact = artifactRegistry.register({
        type: 'text',
        uri: 'file:///text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      await storage.put(textArtifact.id, Buffer.from('text-data'), {
        id: textArtifact.id,
        type: 'text',
        mimeType: 'text/plain',
        size: 100,
        metadata: {},
      });

      const result = await operations.extractFields({
        artifactId: textArtifact.id,
        fields: [{ name: 'name', type: 'string' }],
      });

      expect(result.type).toBe('text');
      expect(result.metadata.fieldCount).toBe(1);
    });
  });

  describe('summarize', () => {
    it('should summarize text artifact with default settings', async () => {
      const textArtifact = artifactRegistry.register({
        type: 'text',
        uri: 'file:///long-text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      await storage.put(textArtifact.id, Buffer.from('long-text-data'), {
        id: textArtifact.id,
        type: 'text',
        mimeType: 'text/plain',
        size: 1000,
        metadata: {},
      });

      const result = await operations.summarize({ artifactId: textArtifact.id });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('text/plain');
      expect(result.metadata.operation).toBe('summarize');
      expect(result.metadata.length).toBe('medium');
      expect(result.metadata.style).toBe('paragraph');
    });

    it('should summarize with bullet-points style', async () => {
      const textArtifact = artifactRegistry.register({
        type: 'text',
        uri: 'file:///long-text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      await storage.put(textArtifact.id, Buffer.from('long-text-data'), {
        id: textArtifact.id,
        type: 'text',
        mimeType: 'text/plain',
        size: 1000,
        metadata: {},
      });

      const result = await operations.summarize({
        artifactId: textArtifact.id,
        style: 'bullet-points',
      });

      expect(result.metadata.style).toBe('bullet-points');
    });

    it('should summarize with executive style', async () => {
      const textArtifact = artifactRegistry.register({
        type: 'text',
        uri: 'file:///long-text.txt',
        mimeType: 'text/plain',
        metadata: {},
      });

      await storage.put(textArtifact.id, Buffer.from('long-text-data'), {
        id: textArtifact.id,
        type: 'text',
        mimeType: 'text/plain',
        size: 1000,
        metadata: {},
      });

      const result = await operations.summarize({
        artifactId: textArtifact.id,
        length: 'short',
        style: 'executive',
      });

      expect(result.metadata.length).toBe('short');
      expect(result.metadata.style).toBe('executive');
    });

    it('should fail for audio artifact', async () => {
      const audioArtifact = artifactRegistry.register({
        type: 'audio',
        uri: 'file:///audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {},
      });

      await expect(operations.summarize({ artifactId: audioArtifact.id })).rejects.toThrow();
    });
  });
});
