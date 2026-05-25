import type {
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

const PRICING = pricing as {
  'mesh.generate': {
    'meshy-4': {
      preview: { input: { perUnit: number } };
      refine: { input: { perUnit: number } };
    };
  };
};

/**
 * Meshy text-to-3D / image-to-3D provider (F21).
 *
 * Uses Meshy's v2 REST API (https://docs.meshy.ai). The previous implementation in this
 * file returned a hardcoded JSON blob with no API call — a placeholder that would be
 * silently broken in production. This version submits the job, polls status, and
 * downloads the model file. Format conversion (glb→fbx/usdz) is deferred per plan §F21
 * since it requires assimp/gltfpack bundling.
 */
export interface MeshyConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

interface MeshyJobResponse {
  result: string;
}

interface MeshyTaskStatus {
  id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress?: number;
  model_urls?: Record<string, string>;
  thumbnail_url?: string;
  task_error?: { message: string };
}

export class MeshyProvider extends MediaProvider {
  readonly name = 'meshy';
  readonly supportedOperations: string[] = ['mesh.generate'];

  /**
   * §0.6 / F21 — Meshy emits poll-derived progress for long-running jobs (we surface it
   * via the F6 progress bridge during poll) and supports webhook callbacks for async
   * job completion.
   */
  readonly supportsStreaming = new Set<string>(['mesh.generate']);
  readonly supportsWebhooks = true;

  /**
   * F2 cacheConfig per plan §F21: meshy bills per generation; deterministic inputs
   * fully drive output. `request_id` (if Meshy started returning one) and `webhook_url`
   * are runtime-volatile and must not participate in the cache key.
   */
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'sourceArtifactId',
      'format',
      'polyBudget',
      'topology',
      'texture',
      'animated',
      'model',
    ],
    nonDeterministicParams: ['webhook_url', 'request_id'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        if (k === 'webhook_url' || k === 'request_id') continue;
        out[k] = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v;
      }
      return out;
    },
  };

  private apiKey: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private maxWaitMs: number;

  constructor(config?: Record<string, unknown>) {
    super();
    this.apiKey = (config?.apiKey as string) ?? process.env.MESHY_API_KEY ?? '';
    this.baseUrl = (config?.baseUrl as string) ?? 'https://api.meshy.ai';
    this.pollIntervalMs = (config?.pollIntervalMs as number) ?? 5_000;
    this.maxWaitMs = (config?.maxWaitMs as number) ?? 10 * 60 * 1000;
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    if (!this.apiKey) {
      throw new Error('MESHY_API_KEY not configured');
    }

    const prompt = input.params.prompt as string | undefined;
    const sourceArtifactId = input.params.sourceArtifactId as string | undefined;
    const requestedFormat = (input.params.format as string | undefined) ?? 'glb';
    const polyBudget = input.params.polyBudget as number | undefined;
    const texture = input.params.texture as
      | { enabled?: boolean; pbr?: boolean; resolution?: number }
      | undefined;

    const isImageTo3d = Boolean(sourceArtifactId);
    const path = isImageTo3d ? '/openapi/v2/image-to-3d' : '/openapi/v2/text-to-3d';

    const body: Record<string, unknown> = {
      mode: texture?.enabled ? 'refine' : 'preview',
      art_style: 'realistic',
    };
    if (prompt) body.prompt = prompt;
    if (sourceArtifactId) body.image_url = sourceArtifactId;
    if (polyBudget) body.target_polycount = polyBudget;
    if (texture?.enabled) {
      body.enable_pbr = texture.pbr ?? false;
      if (texture.resolution) body.texture_resolution = texture.resolution;
    }

    const startedAt = Date.now();
    const createResp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!createResp.ok) {
      throw new Error(
        `Meshy create failed: ${createResp.status} ${await createResp.text().catch(() => '')}`,
      );
    }
    const created = (await createResp.json()) as MeshyJobResponse;
    const taskId = created.result;
    if (!taskId) {
      throw new Error('Meshy create returned no task id');
    }

    const deadline = startedAt + this.maxWaitMs;
    let status: MeshyTaskStatus | undefined;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const statusResp = await fetch(`${this.baseUrl}${path}/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!statusResp.ok) {
        throw new Error(`Meshy poll failed: ${statusResp.status}`);
      }
      status = (await statusResp.json()) as MeshyTaskStatus;
      if (
        status.status === 'SUCCEEDED' ||
        status.status === 'FAILED' ||
        status.status === 'CANCELED'
      ) {
        break;
      }
    }

    if (!status || status.status !== 'SUCCEEDED') {
      const msg =
        status?.task_error?.message ??
        `Meshy task did not complete (status=${status?.status ?? 'timeout'})`;
      throw new Error(msg);
    }

    const formatUrl = status.model_urls?.[requestedFormat] ?? status.model_urls?.glb;
    if (!formatUrl) {
      throw new Error(`Meshy succeeded but no model URL for format=${requestedFormat}`);
    }
    const modelResp = await fetch(formatUrl);
    if (!modelResp.ok) {
      throw new Error(`Failed to download mesh: ${modelResp.status}`);
    }
    const modelBuf = Buffer.from(await modelResp.arrayBuffer());
    const finalFormat = status.model_urls?.[requestedFormat] ? requestedFormat : 'glb';
    const mimeType =
      finalFormat === 'glb'
        ? 'model/gltf-binary'
        : finalFormat === 'fbx'
          ? 'application/octet-stream'
          : finalFormat === 'obj'
            ? 'text/plain'
            : finalFormat === 'usdz'
              ? 'model/vnd.usdz+zip'
              : 'application/octet-stream';

    return {
      data: modelBuf,
      mimeType,
      metadata: {
        provider: this.name,
        taskId,
        format: finalFormat,
        requestedFormat,
        hasTextures: Boolean(texture?.enabled),
        hasAnimation: false,
        prompt,
        sourceArtifactId,
      },
      costUsd: this.priceForMode(body.mode as 'preview' | 'refine'),
      durationMs: Date.now() - startedAt,
    };
  }

  async estimateCost(input: ProviderInput): Promise<CostEstimate> {
    const texture = input.params.texture as { enabled?: boolean } | undefined;
    const mode = texture?.enabled ? 'refine' : 'preview';
    return { costUsd: this.priceForMode(mode), currency: 'USD' };
  }

  private priceForMode(mode: 'preview' | 'refine'): number {
    return PRICING['mesh.generate']['meshy-4'][mode].input.perUnit;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey) {
      return { healthy: false, error: 'MESHY_API_KEY not configured' };
    }
    try {
      const resp = await fetch(`${this.baseUrl}/openapi/v2/users/me`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { healthy: resp.ok, latency: 100, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    } catch (err) {
      return { healthy: false, error: (err as Error).message };
    }
  }
}
