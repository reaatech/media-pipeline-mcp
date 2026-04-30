import type { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type { Artifact } from '@reaatech/media-pipeline-mcp';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactMeta, ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { v4 as uuidv4 } from 'uuid';

export interface TTSConfig {
  text: string;
  voice?: string;
  speed?: number;
  format?: 'mp3' | 'wav' | 'ogg' | 'flac';
  model?: string;
  provider?: string; // Provider name to use (e.g., 'openai', 'elevenlabs')
}

export interface STTConfig {
  language?: string;
  diarize?: boolean;
  model?: string;
  provider?: string; // Provider name to use (e.g., 'openai', 'deepgram')
}

export interface DiarizeConfig {
  language?: string;
  model?: string;
  provider?: string; // Provider name to use (e.g., 'deepgram')
}

export interface IsolateConfig {
  target: 'vocals' | 'instruments' | 'drums' | 'bass';
  model?: string;
  provider?: string; // Provider name to use (e.g., 'replicate')
}

export interface MusicConfig {
  prompt: string; // Text description of the music to generate
  duration?: number; // Duration in seconds (default: 30)
  instrumental?: boolean; // Whether to generate instrumental only (default: true)
  style?: string; // Musical style (e.g., 'pop', 'rock', 'classical')
  tempo?: number; // BPM (e.g., 120)
  format?: 'mp3' | 'wav' | 'ogg' | 'flac';
  model?: string;
  provider?: string; // Provider name to use (e.g., 'elevenlabs')
}

export interface SoundEffectConfig {
  prompt: string; // Text description of the sound effect
  duration?: number; // Duration in seconds (default: 5)
  format?: 'mp3' | 'wav' | 'ogg' | 'flac';
  model?: string;
  provider?: string; // Provider name to use (e.g., 'elevenlabs')
}

export class AudioGenOperations {
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

  async textToSpeech(config: TTSConfig): Promise<Artifact> {
    const provider = this.getProvider('audio.tts', config.provider);

    if (!provider) {
      throw new Error('No provider available for audio.tts operation');
    }

    const input: ProviderInput = {
      operation: 'audio.tts',
      config: {},
      params: {
        text: config.text,
        voice: config.voice || 'alloy',
        speed: config.speed || 1.0,
        response_format: config.format || 'mp3',
        model: config.model || 'tts-1',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const duration = Math.ceil(config.text.length / 15); // Rough estimate

    const meta: ArtifactMeta = {
      id: newId,
      type: 'audio',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        duration,
        voice: config.voice || 'default',
        speed: config.speed || 1.0,
        format: config.format || 'mp3',
        model: config.model || 'tts-1',
        sourceText: config.text.substring(0, 100),
        operation: 'tts',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'audio',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: undefined,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async speechToText(artifactId: string, config: STTConfig = {}): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(artifactId);
    if (!artifact || artifact.type !== 'audio') {
      throw new Error(`Artifact ${artifactId} is not an audio file`);
    }

    const provider = this.getProvider('audio.stt', config.provider);

    if (!provider) {
      throw new Error('No provider available for audio.stt operation');
    }

    const storageResult = await this.storage.get(artifactId);
    const chunks: Buffer[] = [];
    for await (const chunk of storageResult.data as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const audioData = Buffer.concat(chunks);

    const input: ProviderInput = {
      operation: 'audio.stt',
      config: {},
      params: {
        audio_data: audioData,
        language: config.language,
        model: config.model || 'whisper-1',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const transcriptData = JSON.parse((result.data as Buffer).toString('utf-8'));

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: 'application/json',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: artifactId,
        operation: 'stt',
        language: config.language || 'en',
        diarized: config.diarize || false,
        model: config.model || 'whisper-1',
        confidence: transcriptData.confidence || 0.95,
        segments: transcriptData.segments || [],
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

  async diarize(artifactId: string, config: DiarizeConfig = {}): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(artifactId);
    if (!artifact || artifact.type !== 'audio') {
      throw new Error(`Artifact ${artifactId} is not an audio file`);
    }

    const provider = this.getProvider('audio.diarize', config.provider);

    if (!provider) {
      // Fallback to STT provider with diarization enabled
      const sttProvider = this.getProvider('audio.stt', config.provider);
      if (!sttProvider) {
        throw new Error('No provider available for audio.diarize operation');
      }

      const storageResult = await this.storage.get(artifactId);
      const chunks: Buffer[] = [];
      for await (const chunk of storageResult.data as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const audioData = Buffer.concat(chunks);

      const input: ProviderInput = {
        operation: 'audio.stt',
        config: {},
        params: {
          audio_data: audioData,
          language: config.language,
          model: config.model || 'whisper-1',
          diarize: true,
        },
      };

      const result = await sttProvider.execute(input);
      const newId = `artifact-${uuidv4()}`;

      const transcriptData = JSON.parse((result.data as Buffer).toString('utf-8'));

      const meta: ArtifactMeta = {
        id: newId,
        type: 'text',
        mimeType: 'application/json',
        size: (result.data as Buffer).length,
        metadata: {
          sourceArtifact: artifactId,
          operation: 'diarize',
          language: config.language || 'en',
          model: config.model || 'whisper-1',
          speakers: transcriptData.speakers || 2,
          segments: transcriptData.segments || [],
          provider: sttProvider.name,
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

    // Use dedicated diarization provider
    const storageResult = await this.storage.get(artifactId);
    const chunks: Buffer[] = [];
    for await (const chunk of storageResult.data as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const audioData = Buffer.concat(chunks);

    const input: ProviderInput = {
      operation: 'audio.diarize',
      config: {},
      params: {
        audio_data: audioData,
        language: config.language,
        model: config.model || 'pyannote',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'text',
      mimeType: 'application/json',
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: artifactId,
        operation: 'diarize',
        language: config.language || 'en',
        model: config.model || 'pyannote',
        speakers: 2,
        segments: JSON.parse((result.data as Buffer).toString('utf-8')),
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

  async isolate(artifactId: string, config: IsolateConfig): Promise<Artifact> {
    const artifact = this.artifactRegistry.get(artifactId);
    if (!artifact || artifact.type !== 'audio') {
      throw new Error(`Artifact ${artifactId} is not an audio file`);
    }

    const provider = this.getProvider('audio.isolate', config.provider);

    if (!provider) {
      throw new Error('No provider available for audio.isolate operation');
    }

    const storageResult = await this.storage.get(artifactId);
    const chunks: Buffer[] = [];
    for await (const chunk of storageResult.data as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const audioData = Buffer.concat(chunks);

    const input: ProviderInput = {
      operation: 'audio.isolate',
      config: {},
      params: {
        audio_data: audioData,
        target: config.target,
        model: config.model || 'demucs',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'audio',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        sourceArtifact: artifactId,
        operation: 'isolate',
        target: config.target,
        model: config.model || 'demucs',
        duration: (artifact.metadata.duration as number) || 0,
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'audio',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: artifact.sourceStep,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async generateMusic(config: MusicConfig): Promise<Artifact> {
    const provider = this.getProvider('audio.music', config.provider);

    if (!provider) {
      throw new Error('No provider available for audio.music operation');
    }

    const input: ProviderInput = {
      operation: 'audio.music',
      config: {},
      params: {
        prompt: config.prompt,
        duration: config.duration || 30,
        instrumental: config.instrumental !== false,
        style: config.style,
        tempo: config.tempo,
        response_format: config.format || 'mp3',
        model: config.model || 'music-gen',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const duration = config.duration || 30;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'audio',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        duration,
        prompt: config.prompt,
        instrumental: config.instrumental !== false,
        style: config.style || 'general',
        tempo: config.tempo || 120,
        format: config.format || 'mp3',
        model: config.model || 'music-gen',
        operation: 'music',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'audio',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: undefined,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }

  async generateSoundEffect(config: SoundEffectConfig): Promise<Artifact> {
    const provider = this.getProvider('audio.sound_effect', config.provider);

    if (!provider) {
      throw new Error('No provider available for audio.sound_effect operation');
    }

    const input: ProviderInput = {
      operation: 'audio.sound_effect',
      config: {},
      params: {
        prompt: config.prompt,
        duration: config.duration || 5,
        response_format: config.format || 'mp3',
        model: config.model || 'sfx-gen',
      },
    };

    const result = await provider.execute(input);
    const newId = `artifact-${uuidv4()}`;
    const duration = config.duration || 5;

    const meta: ArtifactMeta = {
      id: newId,
      type: 'audio',
      mimeType: result.mimeType,
      size: (result.data as Buffer).length,
      metadata: {
        duration,
        prompt: config.prompt,
        format: config.format || 'mp3',
        model: config.model || 'sfx-gen',
        operation: 'sound_effect',
        provider: provider.name,
        costUsd: result.costUsd,
      },
    };

    const uri = await this.storage.put(newId, result.data as Buffer, meta);

    const newArtifact: Artifact = {
      id: newId,
      type: 'audio',
      uri,
      mimeType: result.mimeType,
      metadata: meta.metadata || {},
      sourceStep: undefined,
    };

    this.artifactRegistry.register(newArtifact);
    return newArtifact;
  }
}

export function createAudioGenOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): AudioGenOperations {
  return new AudioGenOperations(artifactRegistry, storage);
}
