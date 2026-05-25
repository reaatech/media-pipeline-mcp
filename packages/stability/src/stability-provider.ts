import type {
  CostEstimate,
  PricingTable,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

export interface StabilityConfig {
  apiKey: string;
  model?: 'sd3' | 'sdxl' | 'stable-diffusion-v1-5';
  baseUrl?: string;
}

export class StabilityProvider extends MediaProvider {
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'model',
      'steps',
      'cfg_scale',
      'width',
      'height',
      'seed',
      'sampler',
    ],
    nonDeterministicParams: [],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const normalized: Record<string, unknown> = {};

      if (inputs.prompt !== undefined)
        normalized.prompt = String(inputs.prompt).trim().replace(/\s+/g, ' ');
      if (inputs.model !== undefined) normalized.model = inputs.model;
      if (inputs.steps !== undefined) normalized.steps = inputs.steps;
      if (inputs.cfg_scale !== undefined) normalized.cfg_scale = inputs.cfg_scale;
      if (inputs.width !== undefined) normalized.width = inputs.width;
      if (inputs.height !== undefined) normalized.height = inputs.height;
      if (inputs.seed !== undefined) normalized.seed = inputs.seed;

      if (inputs.sampler !== undefined) {
        const sampler = String(inputs.sampler);
        if (sampler !== 'auto') {
          normalized.sampler = sampler;
        }
      }

      return normalized;
    },
  };

  // §0.6 — stability image gen is synchronous; no streaming, no webhooks.
  readonly supportsStreaming = new Set<string>();
  readonly supportsWebhooks = false;

  readonly name = 'stability-ai';
  readonly supportedOperations = ['image.generate'];

  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: StabilityConfig) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model || 'sd3';
    this.baseUrl = config.baseUrl || 'https://api.stability.ai/v2beta';
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/user/balance`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
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

  async estimateCost(input: ProviderInput): Promise<CostEstimate> {
    const opPricing = (pricing as PricingTable)[input.operation];
    if (!opPricing) {
      return { costUsd: 0, currency: 'USD' };
    }
    const model = (input.params.model as string) || this.model;
    const entry = opPricing[model];
    const steps = (input.params.steps as number) || 30;
    const baseCost = entry?.input.perUnit ?? 0.007;
    const perStep = entry?.perStep ?? 0;
    const costUsd = baseCost + perStep * steps;
    return { costUsd, currency: 'USD', estimatedDurationMs: entry?.expectedDurationMs };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    switch (input.operation) {
      case 'image.generate':
        return this.generateImage(input);
      case 'image.inpaint':
        return this.inpaintImage(input);
      case 'image.upscale':
        return this.upscaleImage(input);
      case 'image.remove_background':
        return this.removeBackground(input);
      default:
        throw new Error(`Unsupported operation: ${input.operation}`);
    }
  }

  private async generateImage(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { prompt, negative_prompt, width, height, seed, steps, cfg_scale } = input.params;

    const formData = new FormData();
    formData.append('prompt', prompt as string);
    if (negative_prompt) formData.append('negative_prompt', negative_prompt as string);
    formData.append('output_format', 'png');
    if (width) formData.append('width', String(width));
    if (height) formData.append('height', String(height));
    if (seed) formData.append('seed', String(seed));
    if (steps) formData.append('steps', String(steps));
    if (cfg_scale) formData.append('cfg_scale', String(cfg_scale));

    const response = await fetch(`${this.baseUrl}/stable-image/generate/${this.model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'image/*',
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Stability AI error: ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      data: buffer,
      mimeType: 'image/png',
      metadata: {
        width: width as number,
        height: height as number,
        model: this.model,
        seed: seed as number,
      },
      costUsd: 0.007,
      durationMs: Date.now() - startTime,
    };
  }

  private async inpaintImage(_input: ProviderInput): Promise<ProviderOutput> {
    throw new Error('Inpainting not yet implemented');
  }

  private async upscaleImage(_input: ProviderInput): Promise<ProviderOutput> {
    throw new Error('Upscaling not yet implemented');
  }

  private async removeBackground(_input: ProviderInput): Promise<ProviderOutput> {
    throw new Error('Background removal not yet implemented');
  }
}

// Create a factory function instead of using defineProvider
export function createStabilityProvider(config: StabilityConfig): StabilityProvider {
  return new StabilityProvider(config);
}
