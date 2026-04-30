import { fal } from '@fal-ai/client';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';

export interface FalProviderConfig {
  apiKey: string;
  models?: {
    imageGenerate?: string;
    upscale?: string;
    removeBackground?: string;
    videoGenerate?: string;
    videoImageToVideo?: string;
  };
  pollingInterval?: number;
  timeout?: number;
}

export class FalProvider extends MediaProvider {
  readonly name = 'fal';
  readonly supportedOperations = [
    'image.generate',
    'image.upscale',
    'image.remove_background',
    'video.generate',
    'video.image_to_video',
  ];

  private config: FalProviderConfig;

  private defaultModels = {
    imageGenerate: 'fal-ai/fast-flux-pro',
    upscale: 'fal-ai/real-esrgan',
    removeBackground: 'fal-ai/background-removal',
    videoGenerate: 'fal-ai/kling-video/v1/prod/text-to-video',
    videoImageToVideo: 'fal-ai/kling-video/v1/prod/image-to-video',
  };

  constructor(config: FalProviderConfig) {
    super();
    this.config = config;
    fal.config({
      credentials: config.apiKey,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Lightweight health check - verify API key via balance endpoint
      const response = await fetch('https://api.fal.ai/v1/balance', {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
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
      let falInput: Record<string, unknown>;

      switch (input.operation) {
        case 'image.generate':
          model = this.config.models?.imageGenerate || this.defaultModels.imageGenerate;
          falInput = {
            prompt: input.params.prompt,
            image_size: this.parseImageSize(input.params.aspect_ratio as string),
            num_inference_steps: 28,
            guidance_scale: 3.5,
            num_images: 1,
            enable_safety_checker: true,
            output_format: 'png',
          };
          break;

        case 'image.upscale':
          model = this.config.models?.upscale || this.defaultModels.upscale;
          falInput = {
            image_url: this.bufferToDataUri(input.params.image_data as Buffer),
            scale: input.params.scale || 4,
            face_enhance: false,
          };
          break;

        case 'image.remove_background':
          model = this.config.models?.removeBackground || this.defaultModels.removeBackground;
          falInput = {
            image_url: this.bufferToDataUri(input.params.image_data as Buffer),
          };
          break;

        case 'video.generate':
          model = this.config.models?.videoGenerate || this.defaultModels.videoGenerate;
          falInput = {
            prompt: input.params.prompt,
            duration: input.params.duration || 5,
            aspect_ratio: input.params.aspect_ratio || '16:9',
            fps: 30,
          };
          break;

        case 'video.image_to_video':
          model = this.config.models?.videoImageToVideo || this.defaultModels.videoImageToVideo;
          falInput = {
            image_url: this.bufferToDataUri(input.params.image_data as Buffer),
            prompt: input.params.motion_prompt,
            duration: input.params.duration || 5,
          };
          break;

        default:
          throw new Error(`Unsupported operation: ${input.operation}`);
      }

      const result = await fal.subscribe(model, {
        input: falInput,
        logs: false,
        onQueueUpdate: () => {},
      });

      // Convert fal output to ProviderOutput
      let data: Buffer;
      let mimeType: string;

      const falResult = result as { images?: Array<{ url: string }>; video?: { url: string } };

      if (falResult.images && falResult.images.length > 0) {
        const imageUrl = falResult.images[0].url;
        const response = await fetch(imageUrl);
        const arrayBuffer = await response.arrayBuffer();
        data = Buffer.from(arrayBuffer);
        mimeType = response.headers.get('content-type') || 'image/png';
      } else if (falResult.video?.url) {
        const videoUrl = falResult.video.url;
        const response = await fetch(videoUrl);
        const arrayBuffer = await response.arrayBuffer();
        data = Buffer.from(arrayBuffer);
        mimeType = response.headers.get('content-type') || 'video/mp4';
      } else {
        data = Buffer.from(JSON.stringify(result));
        mimeType = 'application/json';
      }

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
      throw new Error(`fal.ai provider error: ${(error as Error).message}`, { cause: error });
    }
  }

  private bufferToDataUri(buffer: Buffer): string {
    const base64 = buffer.toString('base64');
    return `data:application/octet-stream;base64,${base64}`;
  }

  private parseImageSize(aspectRatio?: string): { width: number; height: number } {
    const defaults = { width: 1024, height: 1024 };
    if (!aspectRatio) return defaults;

    const ratios: Record<string, { width: number; height: number }> = {
      '1:1': { width: 1024, height: 1024 },
      '16:9': { width: 1920, height: 1080 },
      '9:16': { width: 1080, height: 1920 },
      '4:3': { width: 1024, height: 768 },
      '3:4': { width: 768, height: 1024 },
    };

    return ratios[aspectRatio] || defaults;
  }

  private estimateCost(operation: string): number {
    const costs: Record<string, number> = {
      'image.generate': 0.008,
      'image.upscale': 0.004,
      'image.remove_background': 0.002,
      'video.generate': 0.12,
      'video.image_to_video': 0.1,
    };
    return costs[operation] || 0.01;
  }

  protected isNonRetryableError(error: Error): boolean {
    const nonRetryableMessages = [
      'authentication failed',
      'invalid api key',
      'permission denied',
      'model not found',
      'insufficient credits',
    ];

    return nonRetryableMessages.some((msg) => error.message.toLowerCase().includes(msg));
  }
}

export function defineFalProvider(config: FalProviderConfig): FalProvider {
  return new FalProvider(config);
}
