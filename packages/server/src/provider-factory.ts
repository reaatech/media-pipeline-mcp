import { AnthropicProvider } from '@reaatech/media-pipeline-mcp-anthropic';
import { ComfyUIProvider } from '@reaatech/media-pipeline-mcp-comfyui';
import type { Provider } from '@reaatech/media-pipeline-mcp-core';
import { MockProvider } from '@reaatech/media-pipeline-mcp-core';
import { DeepgramProvider } from '@reaatech/media-pipeline-mcp-deepgram';
import { ElevenLabsProvider } from '@reaatech/media-pipeline-mcp-elevenlabs';
import { FalProvider } from '@reaatech/media-pipeline-mcp-fal';
import { GoogleProvider } from '@reaatech/media-pipeline-mcp-google';
import type { KeyVault } from '@reaatech/media-pipeline-mcp-keyvault';
import { LumaProvider } from '@reaatech/media-pipeline-mcp-luma';
import { MeshyProvider } from '@reaatech/media-pipeline-mcp-meshy';
import { OllamaProvider } from '@reaatech/media-pipeline-mcp-ollama';
import { OpenAIProvider } from '@reaatech/media-pipeline-mcp-openai';
import { ReplicateProvider } from '@reaatech/media-pipeline-mcp-replicate';
import { StabilityProvider } from '@reaatech/media-pipeline-mcp-stability';
import { ProviderAdapter } from './provider-adapter.js';

export interface ProviderConfig {
  name: string;
  operations: string[];
  config?: Record<string, unknown>;
}

interface MediaProviderInstance {
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
  estimateCost?: (input: {
    operation: string;
    params: Record<string, unknown>;
    config: Record<string, unknown>;
  }) => Promise<{ costUsd: number; estimatedDurationMs?: number; currency?: string }>;
}

type MediaProviderConstructor = new (config: Record<string, unknown>) => MediaProviderInstance;

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
  meshy: { ctor: MeshyProvider as unknown as MediaProviderConstructor, configKey: 'apiKey' },
  luma: { ctor: LumaProvider as unknown as MediaProviderConstructor, configKey: 'apiKey' },
  // F10 local models — no API key required. `configKey` is omitted so the factory
  // skips the env-var/keyVault lookup and passes the inline config (baseUrl, etc.) directly.
  ollama: { ctor: OllamaProvider as unknown as MediaProviderConstructor },
  comfyui: { ctor: ComfyUIProvider as unknown as MediaProviderConstructor },
};

export async function createProvider(
  config: ProviderConfig,
  keyVault?: KeyVault,
): Promise<Provider | null> {
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
    const keyName = `${name.toUpperCase()}_API_KEY`;
    let apiKey = providerConfig[providerInfo.configKey] as string | undefined;

    if (!apiKey && keyVault) {
      apiKey = (await keyVault.get('default', keyName)) ?? undefined;
    }

    if (!apiKey) {
      apiKey = process.env[keyName] as string;
    }

    if (!apiKey) {
      console.warn(`${name} provider configured but ${keyName} not set`);
      return null;
    }

    resolvedConfig = {
      [providerInfo.configKey]: apiKey,
      ...providerConfig,
    };
  }

  try {
    const mediaProvider = new providerInfo.ctor(resolvedConfig);
    const providerEstimate = mediaProvider.estimateCost;
    return new ProviderAdapter({
      name: mediaProvider.name,
      supportedOperations: mediaProvider.supportedOperations,
      execute: (operation, params, config) => mediaProvider.execute(operation, params, config),
      healthCheck: () => mediaProvider.healthCheck(),
      estimateCost: providerEstimate
        ? async (input) => {
            const est = await providerEstimate(input);
            return { costUsd: est.costUsd, estimatedDurationMs: est.estimatedDurationMs };
          }
        : undefined,
    });
  } catch (error) {
    console.warn(`Failed to create ${name} provider: ${error}`);
    return null;
  }
}

export async function createProviders(
  configs: ProviderConfig[],
  keyVault?: KeyVault,
): Promise<Provider[]> {
  const providers: Provider[] = [];

  for (const config of configs) {
    const provider = await createProvider(config, keyVault);
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
          'video.subtitle',
          'document.ocr',
          'document.extract_tables',
          'document.extract_fields',
          'document.summarize',
          'mesh.generate',
        ],
        delay: 100,
        baseCost: 0.001,
      }),
    );
  }

  return providers;
}
