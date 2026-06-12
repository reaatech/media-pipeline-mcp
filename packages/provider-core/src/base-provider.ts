import { createHash } from 'node:crypto';
import type { ArtifactType } from '@reaatech/media-pipeline-mcp-core';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import type {
  CacheConfig,
  CacheEntry,
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
  WebhookPayload,
} from './types.js';

export abstract class MediaProvider {
  abstract readonly name: string;
  abstract readonly supportedOperations: string[];

  /** F2: per-provider cache config. Subclasses override to declare deterministic & non-deterministic params. */
  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: [],
    nonDeterministicParams: [],
    normalize: (inputs: Record<string, unknown>): Record<string, unknown> => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === 'string') {
          normalized[key] = value.trim().replace(/\s+/g, ' ');
        } else {
          normalized[key] = value;
        }
      }
      return normalized;
    },
  };

  /** F4/F5: cost estimation from public pricing */
  abstract estimateCost(input: ProviderInput): Promise<CostEstimate>;

  /** F6: set of operations that support streaming; absent = no streaming */
  supportsStreaming?: ReadonlySet<string>;

  /** F7: whether this provider supports webhook callbacks */
  supportsWebhooks?: boolean;

  /** F7: derive the signature key for webhook verification */
  webhookSignatureKey?(): Promise<string>;

  /** F7: parse an incoming webhook payload */
  parseWebhookPayload?(headers: Record<string, string>, body: string): Promise<WebhookPayload>;

  protected storage?: ArtifactStore;
  protected retryConfig = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
  };

  /** F2: in-memory cache store */
  protected cacheStore = new Map<string, CacheEntry>();

  setStorage(storage: ArtifactStore): void {
    this.storage = storage;
  }

  healthCheck?(): Promise<ProviderHealth>;

  abstract execute(input: ProviderInput): Promise<ProviderOutput>;

  /**
   * F2: execute with optional caching layer.
   *
   * Resolves cacheConfig:
   *   - explicit cacheConfig wins
   *   - else fall back to `defaultCacheConfigForOperation(input)` (per-op default; plan §F2)
   *
   * Mode semantics:
   *   - 'skip'    — bypass cache entirely (no read, no write).
   *   - 'use'     — read first; on miss, execute and store.
   *   - 'refresh' — always execute and store the fresh result (replace any existing entry).
   *
   * Key formula:
   *   sha256(provider :: modelId :: modelVersion :: scopeTag :: canonicalJson(deterministicInputs))
   *   where deterministicInputs = normalize(input.params filtered by ProviderCacheConfig.deterministicParams).
   *   When deterministicParams is empty (provider didn't override), all params participate.
   */
  async executeWithCache(input: ProviderInput, cacheConfig?: CacheConfig): Promise<ProviderOutput> {
    const effective = cacheConfig ?? this.defaultCacheConfigForOperation(input);

    if (effective.mode === 'skip') {
      return this.execute(input);
    }

    const cacheKey = this.computeCacheKey(input, effective);

    if (effective.mode === 'use') {
      const cached = this.cacheStore.get(cacheKey);
      if (cached) {
        const expires = new Date(cached.expiresAt).getTime();
        if (expires > Date.now()) {
          cached.hitCount++;
          // F2 spec: cache hit is free. Rebate costUsd to 0 so the cost ledger
          // doesn't double-charge for cached responses. The original cost is preserved
          // in `cached.costUsd` for analytics.
          const out = cached.outputs;
          return {
            ...out,
            costUsd: 0,
            metadata: { ...(out.metadata ?? {}), cached: true, originalCostUsd: cached.costUsd },
          };
        }
        this.cacheStore.delete(cacheKey);
      }
    }

    const result = await this.execute(input);

    // Both 'use' (miss) and 'refresh' write the result. The old code skipped writes on refresh
    // which inverted the spec: refresh is supposed to REPLACE the entry.
    const ttl = effective.ttlSeconds ?? 2_592_000; // 30 days per plan default
    this.cacheStore.set(cacheKey, {
      key: cacheKey,
      artifactIds: [],
      outputs: result,
      costUsd: result.costUsd ?? 0,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      hitCount: 0,
    });

    return result;
  }

  /** Per-plan defaults when caller omits cacheConfig (F2 §"Backwards-compat" table). */
  protected defaultCacheConfigForOperation(input: ProviderInput): CacheConfig {
    const op = input.operation;
    const seed = (input.params as Record<string, unknown>)?.seed;

    // Explicit non-determinism opt-out: seed=-1 (or any negative seed) = always skip
    if (typeof seed === 'number' && seed < 0) {
      return { mode: 'skip' };
    }

    if (op === 'audio.tts') {
      return { mode: 'skip' };
    }

    if (op === 'image.generate' || op === 'audio.stt' || op === 'document.extract') {
      return { mode: 'use' };
    }

    // Conservative default for anything else — providers can override on a per-op basis.
    return { mode: 'skip' };
  }

  /**
   * F2: cache key — provider :: modelId :: modelVersion :: scopeTag :: deterministic-only inputs.
   *
   * `modelId` is read from input.params.model (or input.config.model); `modelVersion` from
   * input.params.model_version (or model_id when it embeds a version like 'flux-pro-1.1').
   * Scope tag: 'global' or `tenant:<id>` based on cacheConfig.scope. Tenant scope requires
   * a tenantId on input.config; absence falls back to 'global' with a warning.
   */
  protected computeCacheKey(input: ProviderInput, cacheConfig?: CacheConfig): string {
    const params = input.params as Record<string, unknown>;
    const config = input.config as Record<string, unknown> | undefined;
    const modelId = String(params?.model ?? config?.model ?? 'unknown');
    const modelVersion = String(
      params?.model_version ?? params?.modelVersion ?? config?.model_version ?? 'v0',
    );

    // Apply per-provider deterministic filter + normalize.
    const providerCacheConfig = (this.constructor as typeof MediaProvider).cacheConfig;
    const filtered = this.filterDeterministic(params, providerCacheConfig);
    const normalized = providerCacheConfig.normalize(filtered);

    let scopeTag = 'global';
    if (cacheConfig?.scope === 'tenant') {
      const tenantId = config?.tenantId;
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        scopeTag = `tenant:${tenantId}`;
      } else {
        // Caller asked for tenant scope but provided no tenantId — degrade to global,
        // signalled in the key with a distinct tag so the two never alias.
        scopeTag = 'tenant:UNKNOWN';
      }
    }

    const hash = createHash('sha256');
    hash.update(this.name);
    hash.update('::');
    hash.update(modelId);
    hash.update('::');
    hash.update(modelVersion);
    hash.update('::');
    hash.update(scopeTag);
    hash.update('::');
    hash.update(input.operation);
    hash.update('::');
    hash.update(this.canonicalJson(normalized));
    return hash.digest('hex');
  }

  /**
   * Drop params not in `deterministicParams`. If the list is empty (provider didn't override),
   * fall back to "all params except those in `nonDeterministicParams`" — and if both lists are
   * empty, hash every param (legacy behavior).
   */
  private filterDeterministic(
    params: Record<string, unknown>,
    pcc: ProviderCacheConfig,
  ): Record<string, unknown> {
    if (!params) return {};
    if (pcc.deterministicParams.length > 0) {
      const out: Record<string, unknown> = {};
      for (const k of pcc.deterministicParams) {
        if (k in params) out[k] = params[k];
      }
      return out;
    }
    if (pcc.nonDeterministicParams.length > 0) {
      const out: Record<string, unknown> = {};
      const skip = new Set(pcc.nonDeterministicParams);
      for (const [k, v] of Object.entries(params)) {
        if (!skip.has(k)) out[k] = v;
      }
      return out;
    }
    return params;
  }

  /** F2: canonical JSON: sorted keys, no whitespace, no trailing zeros */
  protected canonicalJson(obj: unknown): string {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'string') return JSON.stringify(obj);
    if (typeof obj === 'number') return this.canonicalNumber(obj);
    if (typeof obj === 'boolean') return obj ? 'true' : 'false';
    if (Array.isArray(obj)) {
      const items = obj.map((item) => this.canonicalJson(item));
      return `[${items.join(',')}]`;
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const pairs = keys.map(
        (k) =>
          `${this.canonicalJson(k)}:${this.canonicalJson((obj as Record<string, unknown>)[k])}`,
      );
      return `{${pairs.join(',')}}`;
    }
    return String(obj);
  }

  /** F2: strip trailing zeros from numbers */
  private canonicalNumber(n: number): string {
    const s = n.toFixed(10);
    const trimmed = s.replace(/\.?0+$/, '');
    return trimmed;
  }

  async executeWithRetry(input: ProviderInput): Promise<ProviderOutput> {
    return this.executeWithRetryImpl(input);
  }

  private async executeWithRetryImpl(input: ProviderInput): Promise<ProviderOutput> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryConfig.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(
            this.retryConfig.baseDelay * 2 ** (attempt - 1),
            this.retryConfig.maxDelay,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        return await this.executeWithCache(input);
      } catch (error) {
        lastError = error as Error;

        if (this.isNonRetryableError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  protected isNonRetryableError(error: unknown): boolean {
    const message = (error as Error).message.toLowerCase();
    return (
      message.includes('authentication') ||
      message.includes('unauthorized') ||
      message.includes('validation') ||
      message.includes('invalid api key')
    );
  }

  protected generateArtifactId(): string {
    return `artifact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  async storeArtifact(
    data: Buffer | ReadableStream,
    type: ArtifactType,
    mimeType: string,
    metadata: Record<string, unknown>,
    sourceStep?: string,
  ): Promise<string> {
    if (!this.storage) {
      throw new Error('Storage not configured for provider');
    }

    const id = this.generateArtifactId();
    const uri = await this.storage.put(id, data, {
      id,
      type,
      mimeType,
      metadata,
      sourceStep,
    });

    return uri;
  }
}

export function defineProvider<T extends MediaProvider>(
  providerClass: new (...args: unknown[]) => T,
): new (
  ...args: unknown[]
) => T {
  return providerClass;
}
