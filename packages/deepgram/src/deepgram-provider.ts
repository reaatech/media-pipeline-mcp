import { createHash } from 'node:crypto';
import { type DeepgramClient, type SyncPrerecordedResponse, createClient } from '@deepgram/sdk';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  CostEstimate,
  PricingTable,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

export interface DeepgramProviderConfig {
  apiKey: string;
  models?: {
    stt?: string;
    diarize?: string;
  };
  timeout?: number;
}

export class DeepgramProvider extends MediaProvider {
  // F2: per-plan table — `sha256(audio_bytes), model, language, all features` are
  // deterministic; `request_id` is non-det. We hash audio_data inside normalize() so
  // the cache key doesn't carry megabytes of raw audio.
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'audio_data',
      'audio_url',
      'model',
      'language',
      'diarize',
      'punctuate',
      'smart_format',
      'utterances',
      'detect_topics',
      'detect_entities',
      'redact',
    ],
    nonDeterministicParams: ['request_id'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const normalized: Record<string, unknown> = {};
      // Audio bytes get hashed; keep the raw audio out of the cache key.
      if (inputs.audio_data !== undefined) {
        const buf = Buffer.isBuffer(inputs.audio_data)
          ? inputs.audio_data
          : Buffer.from(String(inputs.audio_data));
        normalized.audio_sha256 = createHash('sha256').update(buf).digest('hex');
      }
      if (inputs.audio_url !== undefined) normalized.audio_url = inputs.audio_url;
      if (inputs.model !== undefined) normalized.model = inputs.model;
      if (inputs.language !== undefined) normalized.language = inputs.language;
      if (inputs.diarize !== undefined) normalized.diarize = !!inputs.diarize;
      if (inputs.punctuate !== undefined) normalized.punctuate = !!inputs.punctuate;
      if (inputs.smart_format !== undefined) normalized.smart_format = !!inputs.smart_format;
      if (inputs.utterances !== undefined) normalized.utterances = !!inputs.utterances;
      if (inputs.detect_topics !== undefined) normalized.detect_topics = !!inputs.detect_topics;
      if (inputs.detect_entities !== undefined)
        normalized.detect_entities = !!inputs.detect_entities;
      if (inputs.redact !== undefined) normalized.redact = inputs.redact;
      return normalized;
    },
  };

  // §0.6 — deepgram STT streams WebSocket frames natively (audio.transcribeStream
  // / F20). Batch jobs notify via HMAC-signed webhook callbacks.
  readonly supportsStreaming = new Set(['audio.stt', 'audio.diarize']);
  readonly supportsWebhooks = true;

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

  async estimateCost(input: ProviderInput): Promise<CostEstimate> {
    const opPricing = (pricing as PricingTable)[input.operation];
    if (!opPricing) {
      return { costUsd: 0, currency: 'USD' };
    }
    const model = (input.params.model as string) || 'nova-2';
    const entry = opPricing[model] || opPricing['nova-2'];
    const audioData = input.params.audio_data as Buffer | undefined;
    const estimatedMinutes = audioData ? Math.max(audioData.length / (960 * 1024), 0.1) : 1;
    const costUsd = estimatedMinutes * (entry?.input.perUnit ?? 0.0059);
    return { costUsd, currency: 'USD', estimatedDurationMs: entry?.expectedDurationMs };
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
    const costUsd = (await this.estimateCost(input)).costUsd;

    return {
      data,
      mimeType: 'application/json',
      costUsd,
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
    const costUsd = (await this.estimateCost(input)).costUsd;

    return {
      data,
      mimeType: 'application/json',
      costUsd,
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
    result: SyncPrerecordedResponse,
  ): Array<{ text: string; start: number; end: number; confidence: number }> {
    const words = result.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    return words.map((w: { word?: string; start?: number; end?: number; confidence?: number }) => ({
      text: w.word || '',
      start: w.start || 0,
      end: w.end || 0,
      confidence: w.confidence || 0,
    }));
  }

  private countUniqueSpeakers(utterances: Array<{ speaker?: string | number }>): number {
    const speakers = new Set(utterances.map((u) => u.speaker || 'Unknown'));
    return speakers.size;
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
