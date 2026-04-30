import type { Provider } from './pipeline-executor.js';
import type { Artifact } from './types/index.js';

export interface MockProviderConfig {
  name?: string;
  operations?: string[];
  delay?: number; // Simulated delay in ms
  failureRate?: number; // 0-1, probability of failure
  baseCost?: number; // Base cost per operation
  alwaysPass?: boolean; // If true, returns high quality (0.99)
}

export class MockProvider implements Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  private delay: number;
  private failureRate: number;
  private baseCost: number;
  private alwaysPass: boolean;

  constructor(config: MockProviderConfig = {}) {
    this.name = config.name ?? 'mock';
    this.supportedOperations = config.operations ?? [
      'mock.generate',
      'mock.transform',
      'mock.extract',
    ];
    this.delay = config.delay ?? 100;
    this.failureRate = config.failureRate ?? 0;
    this.baseCost = config.baseCost ?? 0.001;
    this.alwaysPass = config.alwaysPass ?? false;
  }

  async execute(
    operation: string,
    _inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<{
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    cost_usd?: number;
    duration_ms?: number;
  }> {
    // Simulate delay
    await new Promise((resolve) => setTimeout(resolve, this.delay));

    // Simulate random failures
    if (Math.random() < this.failureRate) {
      throw new Error('Mock provider simulated failure');
    }

    // Determine artifact type based on operation
    let type: Artifact['type'] = 'image';
    let mimeType = 'image/png';

    if (operation.includes('audio')) {
      type = 'audio';
      mimeType = 'audio/mpeg';
    } else if (operation.includes('video')) {
      type = 'video';
      mimeType = 'video/mp4';
    } else if (operation.includes('text') || operation.includes('extract')) {
      type = 'text';
      mimeType = 'text/plain';
    } else if (operation.includes('document')) {
      type = 'document';
      mimeType = 'application/pdf';
    }

    // Generate mock metadata - alwaysPass returns higher quality
    const metadata: Record<string, unknown> = {
      width: 1024,
      height: 1024,
      quality: this.alwaysPass ? 0.99 : 0.9,
      ...config,
    };

    if (type === 'audio') {
      metadata.duration = 30;
      metadata.sampleRate = 44100;
    } else if (type === 'video') {
      metadata.duration = 10;
      metadata.fps = 30;
    }

    // Generate mock URI
    const uri = `mock://${operation}/${Date.now()}.${mimeType.split('/')[1]}`;

    return {
      data: Buffer.from(JSON.stringify({ operation, metadata })),
      artifact: {
        type,
        uri,
        mimeType,
        metadata,
        sourceStep: undefined,
      },
      cost_usd: this.baseCost,
      duration_ms: this.delay,
    };
  }

  async healthCheck(): Promise<boolean> {
    // Mock provider is always healthy (unless we want to test failures)
    return Math.random() > this.failureRate;
  }
}

// Pre-configured mock operations
export const mockOperations = {
  generate: 'mock.generate',
  transform: 'mock.transform',
  extract: 'mock.extract',
  imageGenerate: 'image.generate',
  imageUpscale: 'image.upscale',
  imageRemoveBackground: 'image.remove_background',
  audioTts: 'audio.tts',
  audioStt: 'audio.stt',
} as const;
