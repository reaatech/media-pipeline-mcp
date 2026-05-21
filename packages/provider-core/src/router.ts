import type {
  CostEstimate,
  ProviderInput,
  ProviderOutput,
  RouteCandidate,
  RouteConfig,
  RouteDecision,
  RouteRejection,
} from './types.js';

// Local error classes keep the router self-contained; @reaatech/media-pipeline-mcp-core
// re-exports identically-named classes that consumers can use for `instanceof` interop.

export class RouterNoCandidatesError extends Error {
  readonly code = 'ROUTER_NO_CANDIDATES';

  constructor() {
    super('No candidates provided for routing');
    this.name = 'RouterNoCandidatesError';
  }
}

export class RouterAllCandidatesFailedError extends Error {
  readonly code = 'ROUTER_ALL_CANDIDATES_FAILED';
  readonly rejections: RouteRejection[];

  constructor(rejections: RouteRejection[]) {
    super('All routing candidates failed');
    this.name = 'RouterAllCandidatesFailedError';
    this.rejections = rejections;
  }
}

export class RouterFastestIneligibleError extends Error {
  readonly code = 'ROUTER_FASTEST_INELIGIBLE';
  readonly ineligibleCandidates: RouteCandidate[];

  constructor(ineligible: RouteCandidate[]) {
    super(
      `'fastest' strategy requires all candidates to declare expectedDurationMs < 5000; ${ineligible.length} candidate(s) failed this check`,
    );
    this.name = 'RouterFastestIneligibleError';
    this.ineligibleCandidates = ineligible;
  }
}

const FASTEST_MAX_DURATION_MS = 5000;
const DEFAULT_HEALTH_TTL_MS = 30_000;

export interface RouterContext {
  estimateCost(candidate: RouteCandidate, inputs: ProviderInput): Promise<CostEstimate>;
  health(
    candidate: RouteCandidate,
  ): Promise<{ healthy: boolean; latencyMs?: number; queueDepth?: number }>;
  execute(
    candidate: RouteCandidate,
    inputs: ProviderInput,
    signal: AbortSignal,
  ): Promise<ProviderOutput>;
  /**
   * Expected duration in ms for this candidate's pricing tier. Sourced from per-provider
   * pricing.json. Return undefined when unknown — that disqualifies the candidate from
   * `fastest` (the strategy needs an upper bound to enforce its <5s rule).
   */
  expectedDurationMs?(candidate: RouteCandidate, inputs: ProviderInput): number | undefined;
  /**
   * Per-candidate queue depth from a fresh probe. If absent, the queue check is skipped.
   * Most providers don't expose queue depth; fal does.
   */
  queueMs?(candidate: RouteCandidate): Promise<number | undefined>;
}

interface HealthCacheEntry {
  result: { healthy: boolean; latencyMs?: number; queueDepth?: number };
  expiresAtMs: number;
}

export class Router {
  private healthCache = new Map<string, HealthCacheEntry>();

  constructor(private ctx: RouterContext) {}

  async route(
    config: RouteConfig,
    inputs: ProviderInput,
  ): Promise<{ decision: RouteDecision; output: ProviderOutput }> {
    if (config.candidates.length === 0) {
      throw new RouterNoCandidatesError();
    }

    // Config-time validation for 'fastest': every candidate must have
    // expectedDurationMs < 5000. Without this, a slow candidate would be wasted
    // work that's likely cancelled by a fast one.
    if (config.strategy === 'fastest') {
      const ineligible: RouteCandidate[] = [];
      for (const c of config.candidates) {
        const dur = this.ctx.expectedDurationMs?.(c, inputs);
        if (dur === undefined || dur >= FASTEST_MAX_DURATION_MS) {
          ineligible.push(c);
        }
      }
      if (ineligible.length > 0) {
        throw new RouterFastestIneligibleError(ineligible);
      }
    }

    switch (config.strategy) {
      case 'first-success':
        return this.routeFirstSuccess(config, inputs);
      case 'cheapest-acceptable':
        return this.routeCheapestAcceptable(config, inputs);
      case 'fastest':
        return this.routeFastest(config, inputs);
      default: {
        const _exhaustive: never = config.strategy;
        throw new Error(`Unknown router strategy: ${_exhaustive}`);
      }
    }
  }

  /**
   * Cached health probe. Cache key is provider+model so we share the result across
   * routes that mention the same candidate. TTL defaults to 30s; per-route override
   * via RouteConfig.healthTtlMs.
   */
  private async cachedHealth(
    candidate: RouteCandidate,
    ttlMs: number,
  ): Promise<{ healthy: boolean; latencyMs?: number; queueDepth?: number }> {
    const cacheKey = `${candidate.provider}::${candidate.model}`;
    const now = Date.now();
    const existing = this.healthCache.get(cacheKey);
    if (existing && existing.expiresAtMs > now) {
      return existing.result;
    }
    const result = await this.ctx.health(candidate);
    this.healthCache.set(cacheKey, { result, expiresAtMs: now + ttlMs });
    return result;
  }

  /** Merge candidate-specific input overrides into the step inputs. */
  private applyInputOverrides(candidate: RouteCandidate, inputs: ProviderInput): ProviderInput {
    if (!candidate.inputOverrides) return inputs;
    return {
      ...inputs,
      params: { ...inputs.params, ...candidate.inputOverrides },
    };
  }

  private async routeFirstSuccess(
    config: RouteConfig,
    inputs: ProviderInput,
  ): Promise<{ decision: RouteDecision; output: ProviderOutput }> {
    const rejections: RouteRejection[] = [];

    for (const candidate of config.candidates) {
      // Cheap rejection signals first — avoid spawning the execution at all if we know
      // it won't be accepted.
      if (candidate.maxQueueMs !== undefined && this.ctx.queueMs) {
        const queue = await this.ctx.queueMs(candidate);
        if (queue !== undefined && queue > candidate.maxQueueMs) {
          rejections.push({
            candidate,
            reason: 'queue-full',
            detail: `Queue ${queue}ms > max ${candidate.maxQueueMs}ms`,
          });
          continue;
        }
      }

      const controller = new AbortController();
      const timer = config.timeoutMs
        ? setTimeout(() => controller.abort(), config.timeoutMs)
        : undefined;

      try {
        const resolved = this.applyInputOverrides(candidate, inputs);
        const output = await this.ctx.execute(candidate, resolved, controller.signal);
        clearTimeout(timer);
        return {
          decision: {
            selected: candidate,
            rejected: rejections,
            reason: 'first-success: candidate succeeded',
            decidedAtMs: Date.now(),
          },
          output,
        };
      } catch (error) {
        clearTimeout(timer);
        rejections.push({
          candidate,
          reason: 'error',
          detail: (error as Error).message,
        });
      }
    }

    throw new RouterAllCandidatesFailedError(rejections);
  }

  private async routeCheapestAcceptable(
    config: RouteConfig,
    inputs: ProviderInput,
  ): Promise<{ decision: RouteDecision; output: ProviderOutput }> {
    const rejections: RouteRejection[] = [];
    const healthTtl = config.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;

    // In parallel: estimate + health + (optionally) queue depth for every candidate.
    const results = await Promise.all(
      config.candidates.map(async (candidate) => {
        const resolved = this.applyInputOverrides(candidate, inputs);
        const [estimate, healthResult, queueMs] = await Promise.all([
          this.ctx.estimateCost(candidate, resolved),
          this.cachedHealth(candidate, healthTtl),
          candidate.maxQueueMs !== undefined && this.ctx.queueMs
            ? this.ctx.queueMs(candidate)
            : Promise.resolve(undefined),
        ]);
        return { candidate, estimate, health: healthResult, queueMs, resolved };
      }),
    );

    const valid: typeof results = [];
    for (const r of results) {
      if (!r.health.healthy) {
        rejections.push({
          candidate: r.candidate,
          reason: 'unhealthy',
          detail: 'Health check failed',
        });
        continue;
      }
      // costUsd is the per-call expected cost from the provider's pricing tier; for
      // providers that ship the spec-shape estimate ({ usdLow, usdHigh, costUsd: usdHigh })
      // this lines up with the plan's "compare against usdHigh" rule.
      if (r.candidate.maxUsd !== undefined && r.estimate.costUsd > r.candidate.maxUsd) {
        rejections.push({
          candidate: r.candidate,
          reason: 'over-budget',
          detail: `Estimate ${r.estimate.costUsd} > max ${r.candidate.maxUsd}`,
        });
        continue;
      }
      if (
        r.candidate.maxQueueMs !== undefined &&
        r.queueMs !== undefined &&
        r.queueMs > r.candidate.maxQueueMs
      ) {
        rejections.push({
          candidate: r.candidate,
          reason: 'queue-full',
          detail: `Queue ${r.queueMs}ms > max ${r.candidate.maxQueueMs}ms`,
        });
        continue;
      }
      valid.push(r);
    }

    if (valid.length === 0) {
      throw new RouterAllCandidatesFailedError(rejections);
    }

    // Sort by cost ascending; on equal cost, higher weight wins (weight default 1).
    valid.sort((a, b) => {
      const costDelta = a.estimate.costUsd - b.estimate.costUsd;
      if (costDelta !== 0) return costDelta;
      return (b.candidate.weight ?? 1) - (a.candidate.weight ?? 1);
    });
    const best = valid[0];

    const controller = new AbortController();
    const timer = config.timeoutMs
      ? setTimeout(() => controller.abort(), config.timeoutMs)
      : undefined;

    try {
      const output = await this.ctx.execute(best.candidate, best.resolved, controller.signal);
      clearTimeout(timer);
      return {
        decision: {
          selected: best.candidate,
          rejected: rejections,
          estimate: best.estimate,
          reason: 'cheapest-acceptable: lowest cost among healthy candidates',
          decidedAtMs: Date.now(),
        },
        output,
      };
    } catch (error) {
      clearTimeout(timer);
      rejections.push({
        candidate: best.candidate,
        reason: 'error',
        detail: (error as Error).message,
      });
      throw new RouterAllCandidatesFailedError(rejections);
    }
  }

  private async routeFastest(
    config: RouteConfig,
    inputs: ProviderInput,
  ): Promise<{ decision: RouteDecision; output: ProviderOutput }> {
    const rejections: RouteRejection[] = [];
    const controller = new AbortController();

    // Eligibility was validated in `route()`. Every candidate here is < 5s expected.
    const eligible = config.candidates;

    const timer = config.timeoutMs
      ? setTimeout(() => controller.abort(), config.timeoutMs)
      : undefined;

    return new Promise<{ decision: RouteDecision; output: ProviderOutput }>((resolve, reject) => {
      let settled = false;
      let remaining = eligible.length;

      for (const candidate of eligible) {
        const resolved = this.applyInputOverrides(candidate, inputs);
        this.ctx
          .execute(candidate, resolved, controller.signal)
          .then((output) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controller.abort();
            resolve({
              decision: {
                selected: candidate,
                rejected: rejections,
                reason: 'fastest: first candidate to complete',
                decidedAtMs: Date.now(),
              },
              output,
            });
          })
          .catch((error) => {
            if (settled) return;
            rejections.push({
              candidate,
              reason: 'error',
              detail: (error as Error).message,
            });
            remaining--;
            if (remaining === 0) {
              settled = true;
              clearTimeout(timer);
              reject(new RouterAllCandidatesFailedError(rejections));
            }
          });
      }
    });
  }
}
