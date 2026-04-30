import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { ProviderOutput } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ArtifactMeta,
  ArtifactStore,
  StorageResult,
} from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudioGenOperations } from './audio-gen-operations.js';

interface MockProvider {
  name: string;
  supportedOperations: string[];
  execute: (input: any) => Promise<ProviderOutput>;
  healthCheck: () => Promise<{ healthy: boolean }>;
}

class MockStorage implements ArtifactStore {
  private store = new Map<string, Buffer>();
  private metas = new Map<string, ArtifactMeta>();

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async put(id: string, data: Buffer | Readable | unknown, meta: ArtifactMeta): Promise<string> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from('mock-audio-data');
    this.store.set(id, buffer);
    this.metas.set(id, meta);
    return `file://${id}`;
  }

  async get(id: string): Promise<StorageResult> {
    const data = this.store.get(id);
    const meta = this.metas.get(id);
    if (!data || !meta) throw new Error(`Artifact not found: ${id}`);
    return {
      data: Readable.from(data),
      meta,
    };
  }

  async getSignedUrl(id: string): Promise<string> {
    return `file://${id}`;
  }

  async delete(_id: string): Promise<void> {
    this.store.delete(_id);
    this.metas.delete(_id);
  }

  async list(): Promise<ArtifactMeta[]> {
    return Array.from(this.metas.values());
  }
}

class TestArtifactRegistry extends ArtifactRegistry {
  registerWithId(
    artifact: { type: string; uri: string; mimeType: string; metadata: Record<string, unknown> },
    id: string,
  ) {
    const fullArtifact = {
      ...artifact,
      id,
      createdAt: new Date().toISOString(),
    };
    (this as any).artifacts.set(id, fullArtifact);
    return fullArtifact;
  }
}

function createMockProvider(
  name: string,
  supportedOperations: string[],
  mockResult: ProviderOutput,
): MockProvider {
  return {
    name,
    supportedOperations,
    execute: async () => mockResult,
    healthCheck: async () => ({ healthy: true }),
  };
}

describe('AudioGenOperations', () => {
  let artifactRegistry: TestArtifactRegistry;
  let storage: MockStorage;
  let operations: AudioGenOperations;

  beforeEach(() => {
    artifactRegistry = new TestArtifactRegistry();
    storage = new MockStorage();
    operations = new AudioGenOperations(artifactRegistry, storage);

    // Register mock providers for all audio operations
    operations.registerProvider(
      'mock-tts',
      createMockProvider('mock-tts', ['audio.tts'], {
        data: Buffer.from('mock-audio-data'),
        mimeType: 'audio/mp3',
        costUsd: 0.001,
      }),
    );

    operations.registerProvider(
      'mock-stt',
      createMockProvider('mock-stt', ['audio.stt'], {
        data: Buffer.from(
          JSON.stringify({
            text: 'Hello world',
            confidence: 0.95,
            segments: [{ start: 0, end: 1, text: 'Hello world' }],
          }),
        ),
        mimeType: 'application/json',
        costUsd: 0.001,
      }),
    );

    operations.registerProvider(
      'mock-isolate',
      createMockProvider('mock-isolate', ['audio.isolate'], {
        data: Buffer.from('mock-isolated-audio'),
        mimeType: 'audio/wav',
        costUsd: 0.002,
      }),
    );
  });

  async function createTestAudioArtifact(duration = 30): Promise<string> {
    const id = `artifact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    await storage.put(id, Buffer.from('mock-audio-data'), {
      id,
      type: 'audio',
      mimeType: 'audio/mp3',
      size: 100,
      duration,
    } as ArtifactMeta);

    artifactRegistry.registerWithId(
      {
        type: 'audio',
        uri: `file://${id}`,
        mimeType: 'audio/mp3',
        metadata: { duration },
      },
      id,
    );

    return id;
  }

  describe('textToSpeech', () => {
    it('should generate audio from text', async () => {
      const result = await operations.textToSpeech({
        text: 'Hello world',
        voice: 'Rachel',
        speed: 1.0,
        format: 'mp3',
      });

      expect(result.type).toBe('audio');
      expect(result.mimeType).toBe('audio/mp3');
      expect(result.metadata.duration).toBe(1);
      expect(result.metadata.voice).toBe('Rachel');
      expect(result.metadata.speed).toBe(1.0);
      expect(result.metadata.operation).toBe('tts');
    });

    it('should use default values when not provided', async () => {
      const result = await operations.textToSpeech({
        text: 'Hello',
      });

      expect(result.metadata.voice).toBe('default');
      expect(result.metadata.speed).toBe(1.0);
      expect(result.metadata.format).toBe('mp3');
    });

    it('should truncate long text in metadata', async () => {
      const longText = 'A'.repeat(200);
      const result = await operations.textToSpeech({
        text: longText,
      });

      expect((result.metadata.sourceText as string).length).toBe(100);
    });
  });

  describe('speechToText', () => {
    it('should transcribe audio to text', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.speechToText(audioId, {
        language: 'en',
        diarize: false,
      });

      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.sourceArtifact).toBe(audioId);
      expect(result.metadata.operation).toBe('stt');
      expect(result.metadata.language).toBe('en');
      expect(result.metadata.diarized).toBe(false);
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id,
      );

      await expect(operations.speechToText(id)).rejects.toThrow('is not an audio file');
    });

    it('should default to English language', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.speechToText(audioId);

      expect(result.metadata.language).toBe('en');
    });
  });

  describe('diarize', () => {
    it('should diarize audio using STT provider with diarization', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.diarize(audioId, {
        language: 'en',
        model: 'pyannote',
      });

      expect(result.type).toBe('text');
      expect(result.metadata.sourceArtifact).toBe(audioId);
      expect(result.metadata.operation).toBe('diarize');
      expect(result.metadata.language).toBe('en');
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id,
      );

      await expect(operations.diarize(id)).rejects.toThrow('is not an audio file');
    });
  });

  describe('isolate', () => {
    it('should isolate vocals from audio', async () => {
      const audioId = await createTestAudioArtifact(60);
      const result = await operations.isolate(audioId, { target: 'vocals' });

      expect(result.type).toBe('audio');
      expect(result.mimeType).toBe('audio/wav');
      expect(result.metadata.sourceArtifact).toBe(audioId);
      expect(result.metadata.operation).toBe('isolate');
      expect(result.metadata.target).toBe('vocals');
      expect(result.metadata.model).toBe('demucs');
      expect(result.metadata.duration).toBe(60);
    });

    it('should isolate instruments from audio', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.isolate(audioId, { target: 'instruments' });

      expect(result.metadata.target).toBe('instruments');
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(
        {
          type: 'text',
          uri: `file://${id}`,
          mimeType: 'text/plain',
          metadata: {},
        },
        id,
      );

      await expect(operations.isolate(id, { target: 'vocals' })).rejects.toThrow(
        'is not an audio file',
      );
    });
  });
});
