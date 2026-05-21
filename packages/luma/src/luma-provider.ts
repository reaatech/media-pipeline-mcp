import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';
import pricing from './pricing.json' with { type: 'json' };

const PRICING = pricing as {
  'mesh.generate': { genie: { input: { perUnit: number } } };
};
const GENIE_PRICE = PRICING['mesh.generate'].genie.input.perUnit;

/**
 * Luma Genie text-to-3D / image-to-3D provider (F21).
 *
 * Uses Luma's Dream Machine API (https://lumalabs.ai/dream-machine/api). The previous
 * implementation returned a hardcoded JSON blob with no API call — replaced here with
 * a poll-based real implementation. Webhook delivery is supported in Luma's API but
 * left to the F7 wiring (callers provide a webhook_url through config when desired).
 */
export interface LumaConfig {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

interface LumaGenerationResponse {
  id: string;
  state: 'queued' | 'dreaming' | 'completed' | 'failed';
  assets?: { mesh?: { glb?: string; usdz?: string } } | null;
  failure_reason?: string;
}

export class LumaProvider extends MediaProvider {
  readonly name = 'luma';
  readonly supportedOperations: string[] = ['mesh.generate'];

  /**
   * §0.6 / F21 — Luma supports webhook delivery (via webhook_url config on the
   * generation request) but the in-tree impl currently polls. The capability flag
   * still says yes so the §0.6 capability matrix matches the plan.
   */
  readonly supportsStreaming = new Set<string>(['mesh.generate']);
  readonly supportsWebhooks = true;

  /**
   * F2 cacheConfig per plan §F21: luma bills per generation. Same shape as meshy —
   * deterministic inputs drive output, and webhook_url is the only common
   * runtime-volatile param.
   */
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: ['prompt', 'sourceArtifactId', 'format', 'model', 'type'],
    nonDeterministicParams: ['webhook_url'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        if (k === 'webhook_url') continue;
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
    this.apiKey = (config?.apiKey as string) ?? process.env.LUMA_API_KEY ?? '';
    this.baseUrl = (config?.baseUrl as string) ?? 'https://api.lumalabs.ai';
    this.pollIntervalMs = (config?.pollIntervalMs as number) ?? 5_000;
    this.maxWaitMs = (config?.maxWaitMs as number) ?? 15 * 60 * 1000;
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    if (!this.apiKey) {
      throw new Error('LUMA_API_KEY not configured');
    }

    const prompt = input.params.prompt as string | undefined;
    const sourceArtifactId = input.params.sourceArtifactId as string | undefined;
    const requestedFormat = (input.params.format as string | undefined) ?? 'glb';

    const body: Record<string, unknown> = {
      type: 'mesh',
      prompt: prompt ?? '',
    };
    if (sourceArtifactId) body.image_url = sourceArtifactId;

    const startedAt = Date.now();
    const createResp = await fetch(`${this.baseUrl}/dream-machine/v1/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!createResp.ok) {
      throw new Error(
        `Luma create failed: ${createResp.status} ${await createResp.text().catch(() => '')}`,
      );
    }
    const created = (await createResp.json()) as LumaGenerationResponse;

    const deadline = startedAt + this.maxWaitMs;
    let status: LumaGenerationResponse = created;
    while (Date.now() < deadline && status.state !== 'completed' && status.state !== 'failed') {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const pollResp = await fetch(`${this.baseUrl}/dream-machine/v1/generations/${created.id}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!pollResp.ok) {
        throw new Error(`Luma poll failed: ${pollResp.status}`);
      }
      status = (await pollResp.json()) as LumaGenerationResponse;
    }

    if (status.state !== 'completed') {
      throw new Error(`Luma generation did not complete: ${status.failure_reason ?? status.state}`);
    }

    // Luma natively returns glb + usdz. ply/fbx/obj would need external conversion.
    const meshAssets = status.assets?.mesh;
    const downloadUrl = requestedFormat === 'usdz' ? meshAssets?.usdz : meshAssets?.glb;
    if (!downloadUrl) {
      throw new Error(`Luma succeeded but no mesh URL for format=${requestedFormat}`);
    }
    const modelResp = await fetch(downloadUrl);
    if (!modelResp.ok) {
      throw new Error(`Failed to download Luma mesh: ${modelResp.status}`);
    }
    const modelBuf = Buffer.from(await modelResp.arrayBuffer());
    const finalFormat = requestedFormat === 'usdz' && meshAssets?.usdz ? 'usdz' : 'glb';

    return {
      data: modelBuf,
      mimeType: finalFormat === 'usdz' ? 'model/vnd.usdz+zip' : 'model/gltf-binary',
      metadata: {
        provider: this.name,
        taskId: created.id,
        format: finalFormat,
        requestedFormat,
        hasTextures: true,
        hasAnimation: false,
        prompt,
        sourceArtifactId,
      },
      costUsd: GENIE_PRICE,
      durationMs: Date.now() - startedAt,
    };
  }

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: GENIE_PRICE, currency: 'USD' };
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.apiKey) {
      return { healthy: false, error: 'LUMA_API_KEY not configured' };
    }
    try {
      const resp = await fetch(`${this.baseUrl}/dream-machine/v1/generations?limit=1`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      return { healthy: resp.ok, latency: 100, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    } catch (err) {
      return { healthy: false, error: (err as Error).message };
    }
  }
}
