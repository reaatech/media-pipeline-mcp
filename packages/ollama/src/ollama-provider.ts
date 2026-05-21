import { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type {
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from '@reaatech/media-pipeline-mcp-provider-core';

export interface OllamaConfig {
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  autoPull?: boolean;
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_duration?: number;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

export class OllamaProvider extends MediaProvider {
  static readonly id = 'ollama';
  readonly name = 'ollama';
  readonly supportedOperations = ['text.complete', 'embedding.generate', 'image.describe'];
  readonly supportsStreaming = new Set(['text.complete', 'embedding.generate']);
  /** §0.6 / F10 — Ollama has no webhook callbacks; consumers poll or stream. */
  readonly supportsWebhooks = false;

  /**
   * F2 cacheConfig per plan §F10: "text non-det by default". Local LLM sampling is
   * inherently non-deterministic without temperature=0 + fixed seed, and the
   * defaultCacheConfigForOperation() in MediaProvider already picks `mode: 'skip'`
   * for text ops. The explicit declaration here documents which inputs would be
   * cache-relevant if a caller forces `cache: { mode: 'use' }`.
   */
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [
      'prompt',
      'model',
      'system',
      'temperature',
      'seed',
      'input',
      'artifact_data',
      'detail',
      'max_tokens',
    ],
    nonDeterministicParams: ['stream'],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        if (k === 'stream') continue;
        out[k] = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v;
      }
      return out;
    },
  };

  private baseUrl: string;
  private defaultModel: string;
  private timeoutMs: number;
  private headers: Record<string, string>;
  private autoPull: boolean;
  /** Models we've already ensured are present (per-process cache, never invalidated). */
  private pulledModels = new Set<string>();

  constructor(config: OllamaConfig = {}) {
    super();
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.defaultModel = config.defaultModel ?? 'llama3.2';
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.headers = config.headers ?? {};
    this.autoPull = config.autoPull ?? false;
  }

  /**
   * Plan §F10 autoPull: when enabled and the requested model is not present in
   * `/api/tags`, POST `/api/pull { name }` and stream until done. Per-process
   * memoized so we only check + pull once per (provider instance × model).
   *
   * No-op when `autoPull` is false. Errors during pull surface as a fail-fast
   * `Error` to the caller — the next provider call would have failed anyway with
   * an opaque "model not found" message; here at least the reason is clear.
   */
  private async ensureModel(model: string): Promise<void> {
    if (!this.autoPull) return;
    if (this.pulledModels.has(model)) return;

    // List current models. If listing itself fails, fall through to the request —
    // the underlying op will throw with the actual reason if the server is down.
    let present = false;
    try {
      const tagsResp = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (tagsResp.ok) {
        const tags = (await tagsResp.json()) as { models?: Array<{ name: string }> };
        present = !!tags.models?.some((m) => m.name === model || m.name.startsWith(`${model}:`));
      }
    } catch {
      // Network errors checking tags shouldn't stop us — let the actual request fail loudly.
    }
    if (present) {
      this.pulledModels.add(model);
      return;
    }

    // Pull. /api/pull streams progress as NDJSON; we only care about completion,
    // so we drain the response without parsing per line.
    const pullResp = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ name: model, stream: false }),
      // Pulling can be slow — give it the full timeout budget, or 10 min, whichever is greater.
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 600_000)),
    });
    if (!pullResp.ok) {
      const text = await pullResp.text().catch(() => '');
      throw new Error(`Ollama autoPull failed for '${model}': ${pullResp.status} ${text}`);
    }
    // Drain body in case the server streamed it.
    await pullResp.text().catch(() => undefined);
    this.pulledModels.add(model);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers,
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
    return { costUsd: 0, currency: 'USD' };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    switch (input.operation) {
      case 'text.complete':
        return this.textComplete(input);
      case 'embedding.generate':
        return this.embeddingGenerate(input);
      case 'image.describe':
        return this.imageDescribe(input);
      default:
        throw new Error(`Unsupported operation: ${input.operation}`);
    }
  }

  private async textComplete(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { prompt, model, system, temperature, max_tokens, stream } = input.params;

    const effectiveModel = (model as string) ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model: effectiveModel,
      prompt: prompt as string,
      stream: stream ?? false,
      options: {},
    };

    if (system) body.system = system;
    if (temperature !== undefined)
      (body.options as Record<string, unknown>).temperature = temperature;
    if (max_tokens !== undefined)
      (body.options as Record<string, unknown>).num_predict = max_tokens;

    if (body.stream) {
      throw new Error('Streaming not supported in direct execute; use supportsStreaming metadata');
    }

    await this.ensureModel(effectiveModel);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error: ${errorText}`);
    }

    const result = (await response.json()) as OllamaGenerateResponse;

    return {
      data: Buffer.from(result.response),
      mimeType: 'text/plain',
      metadata: {
        type: 'text',
        model: result.model,
        total_duration_ns: result.total_duration,
        eval_duration_ns: result.eval_duration,
      },
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  private async embeddingGenerate(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { input: text, model } = input.params;

    const effectiveModel = (model as string) ?? this.defaultModel;

    await this.ensureModel(effectiveModel);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({
        model: effectiveModel,
        prompt: text as string,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error: ${errorText}`);
    }

    const result = (await response.json()) as OllamaEmbeddingResponse;

    return {
      data: Buffer.from(JSON.stringify(result.embedding)),
      mimeType: 'application/json',
      metadata: {
        type: 'embedding',
        model: effectiveModel,
        dimensions: result.embedding.length,
      },
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  private async imageDescribe(input: ProviderInput): Promise<ProviderOutput> {
    const startTime = Date.now();
    const { artifact_data, model, detail, prompt } = input.params;

    const effectiveModel = (model as string) ?? 'llama3.2-vision';
    const imageBase64 = (artifact_data as Buffer).toString('base64');
    const userPrompt = (prompt as string) ?? 'Describe this image in detail.';

    await this.ensureModel(effectiveModel);

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({
        model: effectiveModel,
        prompt: userPrompt,
        images: [imageBase64],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error: ${errorText}`);
    }

    const result = (await response.json()) as OllamaGenerateResponse;

    return {
      data: Buffer.from(result.response),
      mimeType: 'text/plain',
      metadata: {
        type: 'text',
        model: result.model,
        detail: detail ?? 'detailed',
        total_duration_ns: result.total_duration,
      },
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createOllamaProvider(config?: OllamaConfig): OllamaProvider {
  return new OllamaProvider(config);
}
