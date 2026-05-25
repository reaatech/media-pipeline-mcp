import { Readable } from 'node:stream';
import { ArtifactRegistry } from '@reaatech/media-pipeline-mcp-core';
import type {
  CostEstimate,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ArtifactMeta,
  ArtifactStore,
  StorageResult,
} from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudioGenOperations } from './audio-gen-operations.js';

class MockStorage implements ArtifactStore {
  private store = new Map<string, Buffer>();
  private metas = new Map<string, ArtifactMeta>();

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async put(id: string, data: Buffer | Readable | unknown, meta: ArtifactMeta): Promise<string> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from('mock-audio');
    this.store.set(id, buffer);
    this.metas.set(id, meta);
    return `file://${id}`;
  }

  async get(id: string): Promise<StorageResult> {
    const data = this.store.get(id);
    const meta = this.metas.get(id);
    if (!data || !meta) throw new Error(`Artifact not found: ${id}`);
    return { data: Readable.from(data), meta };
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

// Test helper using the real ArtifactRegistry — kept as an alias so existing
// `new TestArtifactRegistry()` call-sites work without churn. The previous
// subclass had a registerWithId(artifact, id) signature that conflicted with
// ArtifactRegistry's parent (id, artifact) signature, so we now register via
// a local helper that uses the correct arg order.
const TestArtifactRegistry = ArtifactRegistry;
type TestArtifactRegistry = ArtifactRegistry;

class MockProvider extends MediaProvider {
  readonly name: string;
  readonly supportedOperations: string[];
  private mockResult: ProviderOutput;

  constructor(name: string, supportedOperations: string[], mockResult: ProviderOutput) {
    super();
    this.name = name;
    this.supportedOperations = supportedOperations;
    this.mockResult = mockResult;
  }

  async execute(_input: ProviderInput): Promise<ProviderOutput> {
    return this.mockResult;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: this.mockResult.costUsd ?? 0.001, currency: 'USD' };
  }
}

describe('AudioGenOperations', () => {
  let artifactRegistry: TestArtifactRegistry;
  let storage: MockStorage;
  let operations: AudioGenOperations;

  const ttsResult: ProviderOutput = {
    data: Buffer.from('mock-audio-data'),
    mimeType: 'audio/mp3',
    metadata: {},
    costUsd: 0.001,
  };
  const sttResult: ProviderOutput = {
    data: Buffer.from(
      JSON.stringify({
        text: 'Hello world',
        confidence: 0.95,
        segments: [{ start: 0, end: 1, text: 'Hello world' }],
      }),
    ),
    mimeType: 'application/json',
    metadata: {},
    costUsd: 0.001,
  };
  const diarizeResult: ProviderOutput = {
    data: Buffer.from(JSON.stringify({ speakers: 2, segments: [{ speaker: 'A', text: 'Hi' }] })),
    mimeType: 'application/json',
    metadata: {},
    costUsd: 0.002,
  };
  const isolateResult: ProviderOutput = {
    data: Buffer.from('mock-isolated-audio'),
    mimeType: 'audio/wav',
    metadata: {},
    costUsd: 0.002,
  };
  const musicResult: ProviderOutput = {
    data: Buffer.from('mock-music'),
    mimeType: 'audio/mp3',
    metadata: {},
    costUsd: 0.005,
  };
  const sfxResult: ProviderOutput = {
    data: Buffer.from('mock-sfx'),
    mimeType: 'audio/mp3',
    metadata: {},
    costUsd: 0.003,
  };

  beforeEach(() => {
    artifactRegistry = new TestArtifactRegistry();
    storage = new MockStorage();
    operations = new AudioGenOperations(artifactRegistry, storage);

    operations.registerProvider('mock-tts', new MockProvider('mock-tts', ['audio.tts'], ttsResult));
    operations.registerProvider('mock-stt', new MockProvider('mock-stt', ['audio.stt'], sttResult));
    operations.registerProvider(
      'mock-diarize',
      new MockProvider('mock-diarize', ['audio.diarize'], diarizeResult),
    );
    operations.registerProvider(
      'mock-isolate',
      new MockProvider('mock-isolate', ['audio.isolate'], isolateResult),
    );
    operations.registerProvider(
      'mock-music',
      new MockProvider('mock-music', ['audio.music'], musicResult),
    );
    operations.registerProvider(
      'mock-sfx',
      new MockProvider('mock-sfx', ['audio.sound_effect'], sfxResult),
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
    artifactRegistry.registerWithId(id, {
      type: 'audio',
      uri: `file://${id}`,
      mimeType: 'audio/mp3',
      metadata: { duration },
    });
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
      expect(result.metadata.operation).toBe('tts');
    });

    it('should use default values when not provided', async () => {
      const result = await operations.textToSpeech({ text: 'Hello' });
      expect(result.metadata.voice).toBe('default');
      expect(result.metadata.speed).toBe(1.0);
      expect(result.metadata.format).toBe('mp3');
    });

    it('should truncate long text in metadata', async () => {
      const result = await operations.textToSpeech({ text: 'A'.repeat(200) });
      expect((result.metadata.sourceText as string).length).toBe(100);
    });

    it('should throw when no provider available', async () => {
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.textToSpeech({ text: 'hello' })).rejects.toThrow('No provider available');
    });
  });

  describe('speechToText', () => {
    it('should transcribe audio to text', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.speechToText(audioId, { language: 'en', diarize: false });
      expect(result.type).toBe('text');
      expect(result.mimeType).toBe('application/json');
      expect(result.metadata.operation).toBe('stt');
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.speechToText(id)).rejects.toThrow('is not an audio file');
    });

    it('should default language to en', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.speechToText(audioId);
      expect(result.metadata.language).toBe('en');
    });

    it('should throw when no provider available', async () => {
      const audioId = await createTestAudioArtifact();
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.speechToText(audioId)).rejects.toThrow('No provider available');
    });
  });

  describe('diarize', () => {
    it('should diarize using dedicated provider', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.diarize(audioId, { language: 'en' });
      expect(result.type).toBe('text');
      expect(result.metadata.operation).toBe('diarize');
    });

    it('should fallback to STT provider when no dedicated diarize provider', async () => {
      const ops = new AudioGenOperations(artifactRegistry, storage);
      ops.registerProvider('mock-stt-only', new MockProvider('mock-stt', ['audio.stt'], sttResult));

      const audioId = await createTestAudioArtifact();
      const result = await ops.diarize(audioId, { language: 'en' });
      expect(result.metadata.operation).toBe('diarize');
    });

    it('should throw when no provider available', async () => {
      const audioId = await createTestAudioArtifact();
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.diarize(audioId)).rejects.toThrow('No provider available');
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.diarize(id)).rejects.toThrow('is not an audio file');
    });
  });

  describe('isolate', () => {
    it('should isolate vocals from audio', async () => {
      const audioId = await createTestAudioArtifact(60);
      const result = await operations.isolate(audioId, { target: 'vocals' });
      expect(result.type).toBe('audio');
      expect(result.metadata.target).toBe('vocals');
      expect(result.metadata.operation).toBe('isolate');
    });

    it('should isolate instruments', async () => {
      const audioId = await createTestAudioArtifact();
      const result = await operations.isolate(audioId, { target: 'instruments' });
      expect(result.metadata.target).toBe('instruments');
    });

    it('should throw for non-audio artifact', async () => {
      const id = 'non-audio';
      artifactRegistry.registerWithId(id, {
        type: 'text',
        uri: `file://${id}`,
        mimeType: 'text/plain',
        metadata: {},
      });
      await expect(operations.isolate(id, { target: 'vocals' })).rejects.toThrow(
        'is not an audio file',
      );
    });

    it('should throw when no provider available', async () => {
      const audioId = await createTestAudioArtifact();
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.isolate(audioId, { target: 'vocals' })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('generateMusic', () => {
    it('should generate music from text prompt', async () => {
      const result = await operations.generateMusic({
        prompt: 'upbeat pop song',
        duration: 30,
        instrumental: true,
        style: 'pop',
        tempo: 120,
        format: 'mp3',
      });

      expect(result.type).toBe('audio');
      expect(result.mimeType).toBe('audio/mp3');
      expect(result.metadata.operation).toBe('music');
      expect(result.metadata.duration).toBe(30);
      expect(result.metadata.style).toBe('pop');
    });

    it('should use defaults when not specified', async () => {
      const result = await operations.generateMusic({ prompt: 'music' });
      expect(result.metadata.duration).toBe(30);
      expect(result.metadata.instrumental).toBe(true);
      expect(result.metadata.style).toBe('general');
      expect(result.metadata.tempo).toBe(120);
    });

    it('should throw when no provider available', async () => {
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.generateMusic({ prompt: 'test' })).rejects.toThrow('No provider available');
    });
  });

  describe('generateSoundEffect', () => {
    it('should generate sound effect from text prompt', async () => {
      const result = await operations.generateSoundEffect({
        prompt: 'door creaking',
        duration: 3,
        format: 'wav',
      });

      expect(result.type).toBe('audio');
      expect(result.mimeType).toBe('audio/mp3');
      expect(result.metadata.operation).toBe('sound_effect');
      expect(result.metadata.duration).toBe(3);
    });

    it('should use default duration when not specified', async () => {
      const result = await operations.generateSoundEffect({ prompt: 'rain' });
      expect(result.metadata.duration).toBe(5);
    });

    it('should throw when no provider available', async () => {
      const ops = new AudioGenOperations(artifactRegistry, storage);
      await expect(ops.generateSoundEffect({ prompt: 'test' })).rejects.toThrow(
        'No provider available',
      );
    });
  });

  describe('getProvider (private)', () => {
    it('should return preferred provider when it supports the operation', () => {
      const p = (
        operations as unknown as {
          getProvider(op: string, preferred?: string): { name: string } | undefined;
        }
      ).getProvider('audio.tts', 'mock-tts');
      expect(p!.name).toBe('mock-tts');
    });

    it('should fallback when preferred provider does not support operation', () => {
      const p = (
        operations as unknown as {
          getProvider(op: string, preferred?: string): { name: string } | undefined;
        }
      ).getProvider('audio.isolate', 'mock-tts');
      expect(p!.name).toBe('mock-isolate');
    });

    it('should return undefined when no provider supports operation', () => {
      const p = (
        operations as unknown as {
          getProvider(op: string, preferred?: string): { name: string } | undefined;
        }
      ).getProvider('unknown.op');
      expect(p).toBeUndefined();
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.AudioGenOperations).toBeDefined();
    expect(mod.createAudioGenOperations).toBeDefined();
  });
});

describe('createAudioGenOperations', () => {
  it('should create AudioGenOperations instance', async () => {
    const mod = await import('./audio-gen-operations.js');
    const { createAudioGenOperations } = mod;
    const { ArtifactRegistry } = await import('@reaatech/media-pipeline-mcp-core');
    const registry = new ArtifactRegistry();
    const result = createAudioGenOperations(
      registry,
      {} as unknown as Parameters<typeof createAudioGenOperations>[1],
    );
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(mod.AudioGenOperations);
  });
});
