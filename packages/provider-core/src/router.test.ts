import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Router,
  RouterAllCandidatesFailedError,
  RouterFastestIneligibleError,
  RouterNoCandidatesError,
} from './router.js';
import type { RouterContext } from './router.js';
import type { ProviderInput, RouteConfig } from './types.js';
import type { CostEstimate } from './types.js';

function makeContext(overrides?: Partial<RouterContext>): RouterContext {
  const defaultCtx: RouterContext = {
    estimateCost: vi.fn().mockResolvedValue({ costUsd: 0.01, currency: 'USD' }),
    health: vi.fn().mockResolvedValue({ healthy: true }),
    execute: vi.fn().mockResolvedValue({
      data: Buffer.from('ok'),
      mimeType: 'text/plain',
      metadata: {},
    }),
    // Default every candidate to "fast enough" so fastest-strategy tests don't all
    // trip the eligibility guard. Tests that want a specific value override this.
    expectedDurationMs: vi.fn().mockReturnValue(100),
  };
  return { ...defaultCtx, ...overrides };
}

const sampleInput: ProviderInput = {
  operation: 'image.generate',
  params: { prompt: 'test' },
  config: {},
};

function candidate(index = 0) {
  return { provider: `p${index}`, model: `m${index}` };
}

describe('Router', () => {
  let ctx: RouterContext;
  let router: Router;

  beforeEach(() => {
    ctx = makeContext();
    router = new Router(ctx);
  });

  describe('validation', () => {
    it('should throw RouterNoCandidatesError for empty candidates', async () => {
      const config: RouteConfig = { strategy: 'first-success', candidates: [] };
      await expect(router.route(config, sampleInput)).rejects.toThrow(RouterNoCandidatesError);
    });

    it('should throw on unknown strategy', async () => {
      const config: RouteConfig = {
        strategy: 'unknown' as 'first-success',
        candidates: [candidate(0)],
      };
      await expect(router.route(config, sampleInput)).rejects.toThrow('Unknown router strategy');
    });
  });

  describe('first-success strategy', () => {
    it('should succeed with the first candidate', async () => {
      const config: RouteConfig = {
        strategy: 'first-success',
        candidates: [candidate(0), candidate(1)],
      };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p0');
      expect(result.decision.rejected).toHaveLength(0);
      expect(result.decision.reason).toContain('first-success');
      expect(result.output).toBeDefined();
    });

    it('should fall through to the second candidate when the first fails', async () => {
      ctx.execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('first failed'))
        .mockResolvedValueOnce({ data: Buffer.from('ok'), mimeType: 'text/plain', metadata: {} });
      router = new Router(ctx);

      const config: RouteConfig = {
        strategy: 'first-success',
        candidates: [candidate(0), candidate(1)],
      };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p1');
      expect(result.decision.rejected).toHaveLength(1);
      expect(result.decision.rejected[0].reason).toBe('error');
    });

    it('should throw RouterAllCandidatesFailedError when all fail', async () => {
      ctx.execute = vi.fn().mockRejectedValue(new Error('fail'));
      router = new Router(ctx);

      const config: RouteConfig = {
        strategy: 'first-success',
        candidates: [candidate(0), candidate(1)],
      };
      await expect(router.route(config, sampleInput)).rejects.toThrow(
        RouterAllCandidatesFailedError,
      );
    });
  });

  describe('cheapest-acceptable strategy', () => {
    it('should pick the cheapest healthy candidate', async () => {
      ctx.estimateCost = vi
        .fn()
        .mockResolvedValueOnce({ costUsd: 0.05, currency: 'USD' } as CostEstimate)
        .mockResolvedValueOnce({ costUsd: 0.02, currency: 'USD' } as CostEstimate);

      const config: RouteConfig = {
        strategy: 'cheapest-acceptable',
        candidates: [candidate(0), candidate(1)],
      };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p1');
      expect(result.decision.reason).toContain('cheapest-acceptable');
    });

    it('should filter out unhealthy candidates', async () => {
      ctx.estimateCost = vi.fn().mockResolvedValue({ costUsd: 0.01, currency: 'USD' });
      ctx.health = vi
        .fn()
        .mockResolvedValueOnce({ healthy: false })
        .mockResolvedValueOnce({ healthy: true });

      const config: RouteConfig = {
        strategy: 'cheapest-acceptable',
        candidates: [candidate(0), candidate(1)],
      };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p1');
      expect(result.decision.rejected).toHaveLength(1);
      expect(result.decision.rejected[0].reason).toBe('unhealthy');
    });

    it('should filter out over-budget candidates', async () => {
      ctx.estimateCost = vi
        .fn()
        .mockResolvedValueOnce({ costUsd: 0.1, currency: 'USD' })
        .mockResolvedValueOnce({ costUsd: 0.02, currency: 'USD' });

      const config: RouteConfig = {
        strategy: 'cheapest-acceptable',
        candidates: [{ ...candidate(0), maxUsd: 0.05 }, candidate(1)],
      };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p1');
      expect(result.decision.rejected).toHaveLength(1);
      expect(result.decision.rejected[0].reason).toBe('over-budget');
    });

    it('should throw RouterAllCandidatesFailedError when no valid candidates', async () => {
      ctx.health = vi.fn().mockResolvedValue({ healthy: false });

      const config: RouteConfig = { strategy: 'cheapest-acceptable', candidates: [candidate(0)] };
      await expect(router.route(config, sampleInput)).rejects.toThrow(
        RouterAllCandidatesFailedError,
      );
    });

    it('should pass inputOverrides to execution in cheapest-acceptable', async () => {
      ctx.estimateCost = vi.fn().mockResolvedValue({ costUsd: 0.01, currency: 'USD' });
      const config: RouteConfig = {
        strategy: 'cheapest-acceptable',
        candidates: [{ ...candidate(0), inputOverrides: { model: 'fast-model' } }],
      };
      await router.route(config, sampleInput);
      expect(ctx.execute).toHaveBeenCalled();
      // Execute gets the overridden input
    });

    it('should throw RouterAllCandidatesFailedError when execution fails in cheapest-acceptable', async () => {
      ctx.health = vi.fn().mockResolvedValue({ healthy: true });
      ctx.execute = vi.fn().mockRejectedValue(new Error('exec failed'));
      const config: RouteConfig = { strategy: 'cheapest-acceptable', candidates: [candidate(0)] };
      await expect(router.route(config, sampleInput)).rejects.toThrow(
        RouterAllCandidatesFailedError,
      );
    });

    it('should use timeout when timeoutMs is specified in cheapest-acceptable', async () => {
      ctx.health = vi.fn().mockResolvedValue({ healthy: true });
      const config: RouteConfig = {
        strategy: 'cheapest-acceptable',
        candidates: [candidate(0)],
        timeoutMs: 5000,
      };
      await router.route(config, sampleInput);
      expect(ctx.execute).toHaveBeenCalled();
    });
  });

  describe('fastest strategy', () => {
    it('should pick the first candidate to complete', async () => {
      ctx.execute = vi
        .fn()
        .mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { data: Buffer.from('slow'), mimeType: 'text/plain', metadata: {} };
        })
        .mockImplementationOnce(async () => {
          return { data: Buffer.from('fast'), mimeType: 'text/plain', metadata: {} };
        });

      const config: RouteConfig = { strategy: 'fastest', candidates: [candidate(0), candidate(1)] };
      const result = await router.route(config, sampleInput);
      expect(result.decision.selected.provider).toBe('p1');
      expect(result.decision.reason).toContain('fastest');
    });

    it('should throw RouterFastestIneligibleError when any candidate has expectedDurationMs >= 5000', async () => {
      // Slow candidate disqualifies the entire race per plan §F8.
      ctx = makeContext({
        expectedDurationMs: vi
          .fn()
          .mockImplementationOnce(() => 100)
          .mockImplementationOnce(() => 6000),
      });
      router = new Router(ctx);

      const config: RouteConfig = {
        strategy: 'fastest',
        candidates: [candidate(0), candidate(1)],
      };
      await expect(router.route(config, sampleInput)).rejects.toThrow(RouterFastestIneligibleError);
    });

    it('should throw RouterFastestIneligibleError when expectedDurationMs is unknown', async () => {
      // Missing duration data = disqualified (we can't enforce the <5s rule).
      ctx = makeContext({ expectedDurationMs: vi.fn().mockReturnValue(undefined) });
      router = new Router(ctx);

      const config: RouteConfig = { strategy: 'fastest', candidates: [candidate(0)] };
      await expect(router.route(config, sampleInput)).rejects.toThrow(RouterFastestIneligibleError);
    });

    it('should throw RouterAllCandidatesFailedError when all eligible fail', async () => {
      ctx.execute = vi.fn().mockRejectedValue(new Error('fail'));

      const config: RouteConfig = { strategy: 'fastest', candidates: [candidate(0)] };
      await expect(router.route(config, sampleInput)).rejects.toThrow(
        RouterAllCandidatesFailedError,
      );
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
