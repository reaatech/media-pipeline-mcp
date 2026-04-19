import { createClient, DeepgramClient, SyncPrerecordedResponse } from '@deepgram/sdk';
import { MediaProvider } from '@media-pipeline/provider-core';
import type { ProviderInput, ProviderOutput, ProviderHealth } from '@media-pipeline/provider-core';

export interface DeepgramProviderConfig {
  apiKey: string;
  models?: {
    stt?: string;
    diarize?: string;
  };
  timeout?: number;
}

export class DeepgramProvider extends MediaProvider {
  readonly name = 'deepgram';
  readonly supportedOperations = ['audio.stt', 'audio.diarize'];

  private client: DeepgramClient;
  private config: DeepgramProviderConfig;

  private defaultModels = {
    stt: 'nova-2',
    diarize: 'nova-2', // Deepgram supports diarization with Nova-2
  };

  constructor(config: DeepgramProviderConfig) {
    super();
    this.config = config;
    this.client = createClient(config.apiKey);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Simple health check - verify we can get project info
      const response = await fetch('https://api.deepgram.com/v1/projects', {
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
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
      switch (input.operation) {
        case 'audio.stt':
          return this.transcribe(input, startTime);
        case 'audio.diarize':
          return this.diarize(input, startTime);
        default:
          throw new Error(`Unsupported operation: ${input.operation}`);
      }
    } catch (error) {
      throw new Error(`Deepgram provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private async transcribe(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const audioData = input.params.audio_data as Buffer;
    const language = (input.params.language as string) || 'en';
    const model = (input.params.model as string) || this.defaultModels.stt;
    const diarize = (input.params.diarize as boolean) || false;

    const response = await this.client.listen.prerecorded.transcribeFile(audioData, {
      model,
      language,
      smart_format: true,
      diarize: diarize ? true : undefined,
      utterances: diarize ? true : undefined,
    });

    const result = response.result;
    if (!result) {
      throw new Error('No transcription result received');
    }
    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

    // Build segments data
    const segments = this.extractSegments(result);

    const outputData = {
      transcript,
      confidence: result.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0,
      language,
      segments,
    };

    const data = Buffer.from(JSON.stringify(outputData, null, 2));
    const cost = this.estimateCost(input.operation, audioData.length);

    return {
      data,
      mimeType: 'application/json',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        model,
        operation: input.operation,
        language,
        diarized: diarize,
        confidence: outputData.confidence,
        segmentCount: segments.length,
      },
    };
  }

  private async diarize(input: ProviderInput, startTime: number): Promise<ProviderOutput> {
    const audioData = input.params.audio_data as Buffer;
    const language = (input.params.language as string) || 'en';
    const model = (input.params.model as string) || this.defaultModels.diarize;

    // Use Nova-2 with diarization enabled
    const response = await this.client.listen.prerecorded.transcribeFile(audioData, {
      model,
      language,
      smart_format: true,
      diarize: true,
      diarize_version: 'nova2',
      utterances: true,
    });

    const result = response.result;
    if (!result) {
      throw new Error('No diarization result received');
    }
    const utterances = result.results?.utterances || [];

    // Extract speaker-labeled segments
    const speakerSegments = utterances.map((u) => ({
      speaker: u.speaker || 'Unknown',
      text: u.transcript || '',
      start: u.start || 0,
      end: u.end || 0,
      confidence: u.confidence || 0,
    }));

    const outputData = {
      speakers: this.countUniqueSpeakers(utterances),
      segments: speakerSegments,
    };

    const data = Buffer.from(JSON.stringify(outputData, null, 2));
    const cost = this.estimateCost(input.operation, audioData.length);

    return {
      data,
      mimeType: 'application/json',
      costUsd: cost,
      durationMs: Date.now() - startTime,
      metadata: {
        model,
        operation: input.operation,
        language,
        speakerCount: outputData.speakers,
        segmentCount: speakerSegments.length,
      },
    };
  }

  private extractSegments(
    result: SyncPrerecordedResponse
  ): Array<{ text: string; start: number; end: number; confidence: number }> {
    const words = result.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    return words.map((w: { word?: string; start?: number; end?: number; confidence?: number }) => ({
      text: w.word || '',
      start: w.start || 0,
      end: w.end || 0,
      confidence: w.confidence || 0,
    }));
  }

  private countUniqueSpeakers(utterances: any[]): number {
    const speakers = new Set(utterances.map((u) => u.speaker || 'Unknown'));
    return speakers.size;
  }

  private estimateCost(_operation: string, audioBytes: number): number {
    // Deepgram pricing: ~$0.0059 per minute for Nova-2
    // Assuming ~128kbps audio = 16KB per second = 960KB per minute
    const minutes = audioBytes / (960 * 1024);
    const costPerMinute = 0.0059;

    return Math.max(minutes * costPerMinute, 0.001); // Minimum $0.001
  }

  protected isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'authentication failed',
      'invalid api key',
      'permission denied',
      'insufficient credits',
      'unsupported model',
      'invalid audio format',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineDeepgramProvider(config: DeepgramProviderConfig): DeepgramProvider {
  return new DeepgramProvider(config);
}
