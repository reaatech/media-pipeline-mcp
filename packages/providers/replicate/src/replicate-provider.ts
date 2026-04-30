import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import Replicate from 'replicate';

export interface ReplicateProviderConfig {
  apiKey: string;
  models?: {
    upscale?: string;
    removeBackground?: string;
    inpaint?: string;
    isolate?: string;
    videoGenerate?: string;
    videoImageToVideo?: string;
  };
  pollingInterval?: number;
  timeout?: number;
}

export class ReplicateProvider extends MediaProvider {
  readonly name = 'replicate';
  readonly supportedOperations = [
    'image.upscale',
    'image.remove_background',
    'image.inpaint',
    'audio.isolate',
    'video.generate',
    'video.image_to_video',
  ];

  private client: Replicate;
  private config: ReplicateProviderConfig;

  private defaultModels: Record<string, string> = {
    upscale: 'nightmareai/real-esrgan',
    removeBackground: 'briaai/rmbg-1.4',
    inpaint: 'stability-ai/stable-inpainting',
    isolate: 'cwqkwg/demucs',
    videoGenerate: 'kling-video',
    videoImageToVideo: 'kling-i2v',
  };

  constructor(config: ReplicateProviderConfig) {
    super();
    this.config = config;
    this.client = new Replicate({
      auth: config.apiKey,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Lightweight health check - verify API key is valid via Replicate API
      const response = await this.client.fetch('/v1/collections', {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });

      if (response.ok) {
        return {
          healthy: true,
          latency: Date.now() - startTime,
        };
      }

      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: `HTTP ${response.status}: ${response.statusText}`,
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
      let model: string;
      let replicateInput: Record<string, unknown>;

      switch (input.operation) {
        case 'image.upscale':
          model = this.config.models?.upscale || this.defaultModels.upscale;
          replicateInput = {
            image: this.bufferToDataUri(input.params.image_data as Buffer),
            scale: input.params.scale || 4,
            face_enhance: false,
            upscale: input.params.scale === 4 ? 4 : 2,
          };
          break;

        case 'image.remove_background':
          model = this.config.models?.removeBackground || this.defaultModels.removeBackground;
          replicateInput = {
            image: this.bufferToDataUri(input.params.image_data as Buffer),
          };
          break;

        case 'image.inpaint':
          model = this.config.models?.inpaint || this.defaultModels.inpaint;
          replicateInput = {
            image: this.bufferToDataUri(input.params.image_data as Buffer),
            mask: input.params.mask_data
              ? this.bufferToDataUri(input.params.mask_data as Buffer)
              : undefined,
            prompt: input.params.prompt,
            negative_prompt: input.params.negative_prompt,
          };
          break;

        case 'audio.isolate':
          model = this.config.models?.isolate || this.defaultModels.isolate;
          replicateInput = {
            audio: this.bufferToDataUri(input.params.audio_data as Buffer),
            model: 'htdemucs',
            stems: input.params.target || 'vocals',
          };
          break;

        case 'video.generate':
          model = this.config.models?.videoGenerate || this.defaultModels.videoGenerate;
          replicateInput = {
            prompt: input.params.prompt,
            duration: input.params.duration || 5,
            aspect_ratio: input.params.aspect_ratio || '16:9',
            fps: 30,
          };
          break;

        case 'video.image_to_video':
          model = this.config.models?.videoImageToVideo || this.defaultModels.videoImageToVideo;
          replicateInput = {
            image: this.bufferToDataUri(input.params.image_data as Buffer),
            motion_prompt: input.params.motion_prompt,
            duration: input.params.duration || 5,
          };
          break;

        default:
          throw new Error(`Unsupported operation: ${input.operation}`);
      }

      const output = await (this.client.run as any)(model, replicateInput);

      // Convert output to ProviderOutput
      let data: Buffer;
      let mimeType: string;

      if (typeof output === 'string') {
        // If output is a URL, fetch it
        if (output.startsWith('http')) {
          const response = await fetch(output);
          const arrayBuffer = await response.arrayBuffer();
          data = Buffer.from(arrayBuffer);
          mimeType = response.headers.get('content-type') || 'application/octet-stream';
        } else {
          data = Buffer.from(output);
          mimeType = 'text/plain';
        }
      } else if (output instanceof Buffer) {
        data = output;
        mimeType = 'application/octet-stream';
      } else if (output instanceof Uint8Array) {
        data = Buffer.from(output);
        mimeType = 'application/octet-stream';
      } else {
        // Try to convert to string
        data = Buffer.from(JSON.stringify(output));
        mimeType = 'application/json';
      }

      // Estimate cost based on operation type
      const cost = this.estimateCost(input.operation);

      return {
        data,
        mimeType,
        costUsd: cost,
        durationMs: Date.now() - startTime,
        metadata: {
          model,
          operation: input.operation,
        },
      };
    } catch (error) {
      throw new Error(`Replicate provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private bufferToDataUri(buffer: Buffer): string {
    const base64 = buffer.toString('base64');
    return `data:application/octet-stream;base64,${base64}`;
  }

  private estimateCost(operation: string): number {
    // Approximate costs based on Replicate pricing
    const costs: Record<string, number> = {
      'image.upscale': 0.005,
      'image.remove_background': 0.003,
      'image.inpaint': 0.01,
      'audio.isolate': 0.01,
      'video.generate': 0.1,
      'video.image_to_video': 0.08,
    };
    return costs[operation] || 0.01;
  }

  protected isNonRetryableError(error: Error): boolean {
    // Replicate-specific non-retryable errors
    const nonRetryableMessages = [
      'authentication failed',
      'invalid api key',
      'permission denied',
      'model not found',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineReplicateProvider(config: ReplicateProviderConfig): ReplicateProvider {
  return new ReplicateProvider(config);
}
