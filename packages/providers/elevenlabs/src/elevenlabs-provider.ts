import { MediaProvider } from '@media-pipeline/provider-core';
import type { ProviderInput, ProviderOutput, ProviderHealth } from '@media-pipeline/provider-core';

export interface ElevenLabsProviderConfig {
  apiKey: string;
  voices?: {
    default?: string;
    [key: string]: string | undefined;
  };
  model?: string;
  timeout?: number;
}

interface ElevenLabsTTSRequest {
  text: string;
  model_id: string;
  voice_settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

export class ElevenLabsProvider extends MediaProvider {
  readonly name = 'elevenlabs';
  readonly supportedOperations = ['audio.tts'];

  private config: ElevenLabsProviderConfig;
  private baseUrl = 'https://api.elevenlabs.io/v1';

  private defaultVoices = {
    default: 'Rachel', // Professional female voice
    'male-narrator': 'Josh',
    'female-narrator': 'Rachel',
    'british-male': 'Daniel',
    'british-female': 'Charlotte',
  };

  constructor(config: ElevenLabsProviderConfig) {
    super();
    this.config = config;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/voices`, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.statusText}`);
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
      if (input.operation !== 'audio.tts') {
        throw new Error(`Unsupported operation: ${input.operation}`);
      }

      const text = input.params.text as string;
      const voice = this.resolveVoice(input.params.voice as string);
      const speed = (input.params.speed as number) || 1.0;
      const format = (input.params.response_format as string) || 'mp3';
      const model = (input.params.model as string) || 'eleven_monolingual_v1';

      if (!text) {
        throw new Error('Text is required for TTS');
      }

      const requestBody: ElevenLabsTTSRequest = {
        text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      };

      // Adjust speed via SSML if needed
      let processedText = text;
      if (speed !== 1.0) {
        processedText = `<speak rate="${speed * 100}%">${text}</speak>`;
      }

      requestBody.text = processedText;

      const response = await fetch(`${this.baseUrl}/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const data = Buffer.from(arrayBuffer);

      const mimeType = this.getMimeType(format);
      const duration = this.estimateDuration(text);
      const cost = this.estimateCost(text.length);

      return {
        data,
        mimeType,
        costUsd: cost,
        durationMs: Date.now() - startTime,
        metadata: {
          model,
          operation: input.operation,
          voice,
          duration,
          speed,
          format,
          characterCount: text.length,
        },
      };
    } catch (error) {
      throw new Error(`ElevenLabs provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private resolveVoice(voiceName?: string): string {
    if (!voiceName) {
      return this.defaultVoices.default;
    }

    // Check if it's a named voice in our config
    if (this.config.voices && this.config.voices[voiceName]) {
      return this.config.voices[voiceName] as string;
    }

    // Check if it's a voice ID (starts with known pattern)
    if (voiceName.startsWith('voice_') || voiceName.length === 20) {
      return voiceName;
    }

    // Try to match default voices
    if (this.defaultVoices[voiceName as keyof typeof this.defaultVoices]) {
      return this.defaultVoices[voiceName as keyof typeof this.defaultVoices];
    }

    // Default fallback
    return this.defaultVoices.default;
  }

  private getMimeType(format: string): string {
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      aac: 'audio/aac',
    };
    return mimeTypes[format] || 'audio/mpeg';
  }

  private estimateDuration(text: string): number {
    // Average speaking rate: ~150 words per minute, ~5 chars per word
    // So ~750 characters per minute = ~12.5 characters per second
    const charsPerSecond = 12.5;
    return Math.ceil(text.length / charsPerSecond);
  }

  private estimateCost(characterCount: number): number {
    // ElevenLabs pricing: ~$0.30 per 1000 characters for standard voice
    const costPerCharacter = 0.0003;
    return characterCount * costPerCharacter;
  }

  protected isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'authentication failed',
      'invalid api key',
      'permission denied',
      'insufficient credits',
      'voice not found',
      'invalid voice id',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineElevenLabsProvider(config: ElevenLabsProviderConfig): ElevenLabsProvider {
  return new ElevenLabsProvider(config);
}
