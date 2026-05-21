import {
  InvalidInputError,
  WorkflowExpiredError,
  WorkflowNotFoundError,
} from '@reaatech/media-pipeline-mcp-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';

import fluxText2ImgWorkflow from './workflows/flux-text2img.json' with { type: 'json' };
import sdxlImg2ImgWorkflow from './workflows/sdxl-img2img.json' with { type: 'json' };
import sdxlText2ImgWorkflow from './workflows/sdxl-text2img.json' with { type: 'json' };
import svdImg2VidWorkflow from './workflows/svd-img2vid.json' with { type: 'json' };

export interface ComfyUIConfig {
  baseUrl?: string;
  workflowsDir?: string;
  downloadOutputs?: boolean;
  pollIntervalMs?: number;
  retentionMs?: number;
}

export interface ComfyParamSpec {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  enum?: string[];
  default?: unknown;
  required?: boolean;
}

export interface ComfyUIWorkflow {
  name: string;
  apiFormat: object;
  inputs: Record<string, ComfyParamSpec>;
  outputs: Record<string, 'image' | 'video' | 'mask' | 'latent'>;
}

interface ComfyPromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface ComfyHistoryResponse {
  [promptId: string]: {
    prompt: unknown;
    outputs: Record<string, ComfyNodeOutput>;
    status: { completed: boolean; status_str?: string };
  };
}

interface ComfyNodeOutput {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
  videos?: Array<{ filename: string; subfolder: string; type: string }>;
}

const BUILT_IN_WORKFLOWS: Record<string, ComfyUIWorkflow> = {
  'sdxl-text2img': {
    name: 'SDXL Text-to-Image',
    apiFormat: sdxlText2ImgWorkflow as object,
    inputs: {
      prompt: { path: '6.inputs.text', type: 'string', required: true },
      negative_prompt: { path: '7.inputs.text', type: 'string', default: '' },
      seed: { path: '3.inputs.seed', type: 'number', default: -1 },
      steps: { path: '3.inputs.steps', type: 'number', default: 20 },
      cfg: { path: '3.inputs.cfg', type: 'number', default: 7 },
      width: { path: '5.inputs.width', type: 'number', default: 1024 },
      height: { path: '5.inputs.height', type: 'number', default: 1024 },
    },
    outputs: {
      '9': 'image',
    },
  },
  'sdxl-img2img': {
    name: 'SDXL Image-to-Image',
    apiFormat: sdxlImg2ImgWorkflow as object,
    inputs: {
      prompt: { path: '6.inputs.text', type: 'string', required: true },
      negative_prompt: { path: '7.inputs.text', type: 'string', default: '' },
      seed: { path: '3.inputs.seed', type: 'number', default: -1 },
      steps: { path: '3.inputs.steps', type: 'number', default: 20 },
      cfg: { path: '3.inputs.cfg', type: 'number', default: 7 },
      denoise: { path: '3.inputs.denoise', type: 'number', default: 0.75 },
      image: { path: '10.inputs.image', type: 'string', required: true },
    },
    outputs: {
      '9': 'image',
    },
  },
  'flux-text2img': {
    name: 'Flux.1-dev Text-to-Image',
    apiFormat: fluxText2ImgWorkflow as object,
    inputs: {
      prompt: { path: '6.inputs.text', type: 'string', required: true },
      negative_prompt: { path: '7.inputs.text', type: 'string', default: '' },
      seed: { path: '3.inputs.seed', type: 'number', default: -1 },
      steps: { path: '3.inputs.steps', type: 'number', default: 20 },
      cfg: { path: '3.inputs.cfg', type: 'number', default: 1 },
      width: { path: '5.inputs.width', type: 'number', default: 1024 },
      height: { path: '5.inputs.height', type: 'number', default: 1024 },
    },
    outputs: {
      '9': 'image',
    },
  },
  'svd-img2vid': {
    name: 'Stable Video Diffusion Image-to-Video',
    apiFormat: svdImg2VidWorkflow as object,
    inputs: {
      image: { path: '10.inputs.image', type: 'string', required: true },
      seed: { path: '3.inputs.seed', type: 'number', default: -1 },
      steps: { path: '3.inputs.steps', type: 'number', default: 20 },
      cfg: { path: '3.inputs.cfg', type: 'number', default: 2.5 },
      width: { path: '12.inputs.width', type: 'number', default: 1024 },
      height: { path: '12.inputs.height', type: 'number', default: 576 },
      video_frames: { path: '12.inputs.video_frames', type: 'number', default: 14 },
      motion_bucket_id: { path: '12.inputs.motion_bucket_id', type: 'number', default: 127 },
      fps: { path: '12.inputs.fps', type: 'number', default: 6 },
    },
    outputs: {
      '20': 'video',
    },
  },
};

export class ComfyUIProvider extends MediaProvider {
  static readonly id = 'comfyui';
  readonly name = 'comfyui';
  readonly supportedOperations = ['image.generate', 'image.edit', 'video.generate'];

  /**
   * §0.6 capability declarations. ComfyUI exposes per-node progress as it executes a
   * workflow (we surface it via the F6 progress bridge during pollForCompletion), but
   * does not push outbound webhooks.
   */
  readonly supportsStreaming = new Set<string>(['image.generate', 'image.edit', 'video.generate']);
  readonly supportsWebhooks = false;

  /**
   * F2 cacheConfig per plan §F10 "Per-implementation features":
   *   "det per fixed `seed`; cache enabled when seed is provided and non-negative"
   *
   * All workflow inputs are deterministic given a fixed seed. The non-det list is
   * empty because there is no provider-side request id (ComfyUI's `prompt_id` is
   * generated post-submit and is not user-supplied). Normalize trims string params.
   */
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'negative_prompt',
      'seed',
      'steps',
      'cfg',
      'denoise',
      'width',
      'height',
      'image',
      'model',
      'sampler',
      'scheduler',
      'video_frames',
      'motion_bucket_id',
      'fps',
      'dimensions',
    ],
    nonDeterministicParams: [],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        out[k] = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v;
      }
      return out;
    },
  };

  private baseUrl: string;
  private pollIntervalMs: number;
  private retentionMs: number;
  private downloadOutputs: boolean;
  private workflows: Record<string, ComfyUIWorkflow>;
  private workflowsDir?: string;
  private workflowsDirLoaded = false;

  constructor(config: ComfyUIConfig = {}) {
    super();
    this.baseUrl = config.baseUrl ?? 'http://localhost:8188';
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.retentionMs = config.retentionMs ?? 600_000;
    this.downloadOutputs = config.downloadOutputs ?? true;
    this.workflows = { ...BUILT_IN_WORKFLOWS };
    this.workflowsDir = config.workflowsDir;
  }

  /**
   * Plan §F10 "Mechanism (ComfyUI) #1": load user workflows from `workflowsDir/*.json`
   * at construction time. We do it lazily (first execute / explicit call) so that the
   * constructor stays sync and tests can mock fs.
   *
   * Each file becomes `custom/<basename>` workflow. The JSON must declare `apiFormat`,
   * `inputs`, and `outputs` keys (the ComfyUIWorkflow shape). Files that don't match
   * the shape are skipped with a warning.
   */
  async loadWorkflowsFromDir(): Promise<void> {
    if (this.workflowsDirLoaded || !this.workflowsDir) return;
    this.workflowsDirLoaded = true;
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const entries = await fs.readdir(this.workflowsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const full = path.join(this.workflowsDir, entry);
        try {
          const raw = await fs.readFile(full, 'utf8');
          const parsed = JSON.parse(raw) as ComfyUIWorkflow;
          if (typeof parsed.apiFormat !== 'object' || typeof parsed.inputs !== 'object') {
            console.warn(`ComfyUI: skipping workflow ${entry} — missing apiFormat/inputs`);
            continue;
          }
          const slug = `custom/${path.basename(entry, '.json')}`;
          this.workflows[slug] = parsed;
        } catch (err) {
          console.warn(`ComfyUI: failed to load workflow ${entry}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(
        `ComfyUI: workflowsDir '${this.workflowsDir}' unreadable: ${(err as Error).message}`,
      );
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(10_000),
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

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return {
      costUsd: 0,
      currency: 'USD',
    };
  }

  registerWorkflow(name: string, workflow: ComfyUIWorkflow): void {
    this.workflows[name] = workflow;
  }

  getWorkflow(name: string): ComfyUIWorkflow | undefined {
    return this.workflows[name];
  }

  listWorkflows(): string[] {
    return Object.keys(this.workflows);
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    // Lazy: load user workflows on first execute. No-op when workflowsDir absent
    // or already loaded; second+ calls reuse the cached registry.
    await this.loadWorkflowsFromDir();

    // Plan §F10: `model: 'workflow:<slug>'` selects a built-in or registered workflow
    // explicitly. Falls back to per-operation defaults when `model` is absent.
    const explicit = this.resolveWorkflowName(input);
    if (explicit) {
      return this.runWorkflow(explicit, input);
    }
    switch (input.operation) {
      case 'image.generate':
        return this.runWorkflow('sdxl-text2img', input);
      case 'image.edit':
        return this.runWorkflow('sdxl-img2img', input);
      case 'video.generate':
        return this.runWorkflow('svd-img2vid', input);
      default:
        throw new Error(`Unsupported operation: ${input.operation}`);
    }
  }

  private resolveWorkflowName(input: ProviderInput): string | null {
    const model = (input.params?.model ?? (input as { model?: string }).model) as
      | string
      | undefined;
    if (!model) return null;
    if (!model.startsWith('workflow:')) return null;
    return model.slice('workflow:'.length);
  }

  private async runWorkflow(workflowName: string, input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const workflow = this.workflows[workflowName];

    // Plan §F10 test matrix: "ComfyUI unknown workflow → WorkflowNotFoundError at execute".
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowName);
    }

    const prompt = structuredClone(workflow.apiFormat) as Record<string, unknown>;

    // Plan §F10 test matrix: "ComfyUI param mismatch | workflow needs `cfg`, inputs
    // provide `cfg_scale` | InvalidInputError listing missing/extra params". Missing
    // required inputs preserve the legacy "Missing required input: <name>" phrasing
    // (also matched by the test suite) but are now wrapped in the typed InvalidInputError.
    for (const [paramName, spec] of Object.entries(workflow.inputs)) {
      const value = input.params[paramName] ?? spec.default;
      if (value === undefined && spec.required) {
        throw new InvalidInputError(`Missing required input: ${paramName}`);
      }
      if (value !== undefined) {
        this.setNestedValue(prompt, spec.path, value);
      }
    }

    const dims = input.params.dimensions as string | undefined;
    if (dims) {
      const parts = dims.split('x').map(Number);
      if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
        this.setNestedValue(prompt, '5.inputs.width', parts[0]);
        this.setNestedValue(prompt, '5.inputs.height', parts[1]);
      }
    }

    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ComfyUI error: ${errorText}`);
    }

    const promptResult = (await response.json()) as ComfyPromptResponse;
    const promptId = promptResult.prompt_id;

    const outputs = await this.pollForCompletion(promptId);

    if (this.downloadOutputs && Object.keys(outputs).length > 0) {
      const firstOutput = Object.values(outputs)[0];
      if (firstOutput.images && firstOutput.images.length > 0) {
        const img = firstOutput.images[0];
        const imageUrl = `${this.baseUrl}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=${img.type}`;
        const imageResponse = await fetch(imageUrl);

        if (!imageResponse.ok) {
          throw new Error(`Failed to download output image: ${imageResponse.statusText}`);
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return {
          data: buffer,
          mimeType: this.mimeTypeFromFilename(img.filename),
          metadata: {
            type: 'image',
            prompt_id: promptId,
            workflow: workflowName,
            filename: img.filename,
          },
          costUsd: 0,
          durationMs: Date.now() - startTime,
        };
      }
    }

    throw new Error('No output images produced by workflow');
  }

  private async pollForCompletion(promptId: string): Promise<Record<string, ComfyNodeOutput>> {
    const deadline = Date.now() + this.retentionMs;

    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);

      try {
        const response = await fetch(`${this.baseUrl}/history/${promptId}`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 404) {
          continue;
        }

        if (!response.ok) {
          continue;
        }

        const history = (await response.json()) as ComfyHistoryResponse;
        const entry = history[promptId];

        if (entry?.status.completed) {
          return entry.outputs;
        }

        if (entry && entry.status.status_str === 'error') {
          throw new Error('ComfyUI workflow execution failed');
        }
      } catch {}
    }

    // Plan §F10 test matrix: "ComfyUI expired | resume after retentionMs | WorkflowExpiredError".
    throw new WorkflowExpiredError();
  }

  private setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    const lastKey = keys[keys.length - 1];

    if (lastKey === 'width' || lastKey === 'height') {
      current[lastKey] = typeof value === 'string' ? Number(value) : value;
    } else {
      current[lastKey] = value;
    }
  }

  private mimeTypeFromFilename(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'mp4':
        return 'video/mp4';
      case 'webm':
        return 'video/webm';
      default:
        return 'application/octet-stream';
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createComfyUIProvider(config?: ComfyUIConfig): ComfyUIProvider {
  return new ComfyUIProvider(config);
}
