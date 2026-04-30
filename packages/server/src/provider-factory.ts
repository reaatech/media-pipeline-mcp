import type { Provider } from '@reaatech/media-pipeline-mcp';
import { MockProvider } from '@reaatech/media-pipeline-mcp';
import { AnthropicProvider } from '@reaatech/media-pipeline-mcp-anthropic';
import { DeepgramProvider } from '@reaatech/media-pipeline-mcp-deepgram';
import { ElevenLabsProvider } from '@reaatech/media-pipeline-mcp-elevenlabs';
import { FalProvider } from '@reaatech/media-pipeline-mcp-fal';
import { GoogleProvider } from '@reaatech/media-pipeline-mcp-google';
import { OpenAIProvider } from '@reaatech/media-pipeline-mcp-openai';
import { ReplicateProvider } from '@reaatech/media-pipeline-mcp-replicate';
import { StabilityProvider } from '@reaatech/media-pipeline-mcp-stability';
import { ProviderAdapter } from './provider-adapter.js';

export interface ProviderConfig {
  name: string;
  operations: string[];
  config?: Record<string, unknown>;
}

type MediaProviderConstructor = new (
  config: Record<string, unknown>,
) => {
  name: string;
  supportedOperations: string[];
  execute(
    operation: string,
    params: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<{
    data: Buffer | ReadableStream;
    mimeType: string;
    metadata: Record<string, unknown>;
    costUsd?: number;
    durationMs?: number;
  }>;
  healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }>;
};

interface ProviderInfo {
  ctor: MediaProviderConstructor;
  configKey?: string;
}

const providerRegistry: Record<string, ProviderInfo> = {
  stability: {
    ctor: StabilityProvider as unknown as MediaProviderConstructor,
    configKey: 'apiKey',
  },
  openai: { ctor: OpenAIProvider as unknown as MediaProviderConstructor, configKey: 'apiKey' },
  replicate: {
    ctor: ReplicateProvider as unknown as MediaProviderConstructor,
    configKey: 'apiKey',
  },
  fal: { ctor: FalProvider as unknown as MediaProviderConstructor, configKey: 'apiKey' },
  elevenlabs: {
    ctor: ElevenLabsProvider as unknown as MediaProviderConstructor,
    configKey: 'apiKey',
  },
  deepgram: { ctor: DeepgramProvider as unknown as MediaProviderConstructor, configKey: 'apiKey' },
  anthropic: {
    ctor: AnthropicProvider as unknown as MediaProviderConstructor,
    configKey: 'apiKey',
  },
  google: { ctor: GoogleProvider as unknown as MediaProviderConstructor },
};

export function createProvider(config: ProviderConfig): Provider | null {
  const { name, operations, config: providerConfig = {} } = config;

  if (name.toLowerCase() === 'mock') {
    return new MockProvider({
      name: 'mock',
      operations,
      delay: 100,
      baseCost: 0.001,
    });
  }

  const providerInfo = providerRegistry[name.toLowerCase()];
  if (!providerInfo) {
    console.warn(`Unknown provider type: ${name}`);
    return null;
  }

  let resolvedConfig: Record<string, unknown> = { ...providerConfig };

  if (providerInfo.configKey) {
    const envKey = `${name.toUpperCase()}_API_KEY`;
    const apiKey =
      (providerConfig[providerInfo.configKey] as string) || (process.env[envKey] as string);

    if (!apiKey) {
      console.warn(`${name} provider configured but ${envKey} not set`);
      return null;
    }

    resolvedConfig = {
      [providerInfo.configKey]: apiKey,
      ...providerConfig,
    };
  }

  try {
    const mediaProvider = new providerInfo.ctor(resolvedConfig);
    return new ProviderAdapter({
      name: mediaProvider.name,
      supportedOperations: mediaProvider.supportedOperations,
      execute: (operation, params, config) => mediaProvider.execute(operation, params, config),
      healthCheck: () => mediaProvider.healthCheck(),
    });
  } catch (error) {
    console.warn(`Failed to create ${name} provider: ${error}`);
    return null;
  }
}

export function createProviders(configs: ProviderConfig[]): Provider[] {
  const providers: Provider[] = [];

  for (const config of configs) {
    const provider = createProvider(config);
    if (provider) {
      providers.push(provider);
    }
  }

  if (providers.length === 0) {
    console.warn('No providers configured, using mock provider for development');
    providers.push(
      new MockProvider({
        name: 'mock',
        operations: [
          'mock.generate',
          'mock.transform',
          'mock.extract',
          'image.generate',
          'image.generate.batch',
          'image.upscale',
          'image.remove_background',
          'image.inpaint',
          'image.describe',
          'image.resize',
          'image.crop',
          'image.composite',
          'image.image_to_image',
          'audio.tts',
          'audio.stt',
          'audio.diarize',
          'audio.isolate',
          'audio.music',
          'audio.sound_effect',
          'video.generate',
          'video.image_to_video',
          'video.extract_frames',
          'video.extract_audio',
          'document.ocr',
          'document.extract_tables',
          'document.extract_fields',
          'document.summarize',
        ],
        delay: 100,
        baseCost: 0.001,
      }),
    );
  }

  return providers;
}
