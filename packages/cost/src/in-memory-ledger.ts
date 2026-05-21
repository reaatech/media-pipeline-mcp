import type {
  CostEntry,
  CostEstimate,
  CostLedger,
  CostScope,
  PreflightResult,
  TimeWindow,
} from './types.js';
// TimeWindow is re-imported above for the destructured-window normalization below.

export interface InMemoryCostLedgerConfig {
  defaultRunCapUsd?: number;
  runCaps?: Map<string, number>;
  tenantDailyCaps?: Map<string, number>;
  tenantMonthlyCaps?: Map<string, number>;
}

export class InMemoryCostLedger implements CostLedger {
  private entries: CostEntry[] = [];
  private config: Required<InMemoryCostLedgerConfig>;

  constructor(config?: InMemoryCostLedgerConfig) {
    this.config = {
      defaultRunCapUsd: config?.defaultRunCapUsd ?? 0,
      runCaps: config?.runCaps ?? new Map(),
      tenantDailyCaps: config?.tenantDailyCaps ?? new Map(),
      tenantMonthlyCaps: config?.tenantMonthlyCaps ?? new Map(),
    };
  }

  async charge(entry: CostEntry): Promise<void> {
    this.entries.push({ ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined });
  }

  async preflight(estimate: CostEstimate, scope: CostScope): Promise<PreflightResult> {
    const estimateUsd = estimate.usdHigh;

    if (scope.type === 'run') {
      const cap = this.config.runCaps.get(scope.runId) ?? this.config.defaultRunCapUsd;
      const current = await this.totalForRun(scope.runId);

      if (cap > 0 && current + estimateUsd > cap) {
        return {
          allowed: false,
          currentSpentUsd: current,
          requestEstimateUsd: estimateUsd,
          capUsd: cap,
          remainingUsd: Math.max(cap - current, 0),
          scope: `run:${scope.runId}`,
          reason: `Run budget exceeded: ${current + estimateUsd} > ${cap}`,
        };
      }

      return {
        allowed: true,
        currentSpentUsd: current,
        requestEstimateUsd: estimateUsd,
        capUsd: cap,
        remainingUsd: cap > 0 ? Math.max(cap - current, 0) : Number.POSITIVE_INFINITY,
        scope: `run:${scope.runId}`,
      };
    }

    // Accept both `timeWindow` and the spec-compat `window` alias on tenant scope.
    const windowSrc = scope.timeWindow ?? scope.window;
    const tenantId = scope.tenantId;
    // Normalize since/until → start/end for the rest of the call.
    const timeWindow: TimeWindow = {
      start: windowSrc?.start ?? windowSrc?.since ?? new Date(0).toISOString(),
      end: windowSrc?.end ?? windowSrc?.until ?? new Date().toISOString(),
    };
    const current = await this.totalForTenant(tenantId, timeWindow);
    const total = current + estimateUsd;

    // Both caps always enforced for tenant scope; the timeWindow is just the audit
    // span for `current`, not a gate on which cap applies.
    const dailyCap = this.config.tenantDailyCaps.get(tenantId) ?? 0;
    if (dailyCap > 0 && total > dailyCap) {
      return {
        allowed: false,
        currentSpentUsd: current,
        requestEstimateUsd: estimateUsd,
        capUsd: dailyCap,
        remainingUsd: Math.max(dailyCap - current, 0),
        scope: `tenant:${tenantId}:daily`,
        reason: `Daily budget exceeded: ${total} > ${dailyCap}`,
      };
    }

    const monthlyCap = this.config.tenantMonthlyCaps.get(tenantId) ?? 0;
    if (monthlyCap > 0 && total > monthlyCap) {
      return {
        allowed: false,
        currentSpentUsd: current,
        requestEstimateUsd: estimateUsd,
        capUsd: monthlyCap,
        remainingUsd: Math.max(monthlyCap - current, 0),
        scope: `tenant:${tenantId}:monthly`,
        reason: `Monthly budget exceeded: ${total} > ${monthlyCap}`,
      };
    }

    const effectiveCap = monthlyCap || dailyCap || 0;
    return {
      allowed: true,
      currentSpentUsd: current,
      requestEstimateUsd: estimateUsd,
      capUsd: effectiveCap,
      remainingUsd:
        effectiveCap > 0 ? Math.max(effectiveCap - current, 0) : Number.POSITIVE_INFINITY,
      scope: `tenant:${tenantId}`,
    };
  }

  async totalForRun(runId: string): Promise<number> {
    return this.entries.filter((e) => e.runId === runId).reduce((sum, e) => sum + e.usd, 0);
  }

  async totalForTenant(tenantId: string, timeWindow: TimeWindow): Promise<number> {
    // Accept either {start, end} or the spec-compat {since, until} pair.
    const start = new Date(timeWindow.start ?? timeWindow.since ?? 0).getTime();
    const end = new Date(timeWindow.end ?? timeWindow.until ?? Date.now()).getTime();

    return this.entries
      .filter((e) => {
        const ts = new Date(e.at).getTime();
        return e.tenantId === tenantId && ts >= start && ts <= end;
      })
      .reduce((sum, e) => sum + e.usd, 0);
  }

  async listEntries(scope: CostScope): Promise<CostEntry[]> {
    if (scope.type === 'run') {
      return this.entries
        .filter((e) => e.runId === scope.runId)
        .map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : undefined }));
    }

    const { tenantId, timeWindow } = scope;
    const start = new Date(timeWindow.start).getTime();
    const end = new Date(timeWindow.end).getTime();

    return this.entries
      .filter((e) => {
        const ts = new Date(e.at).getTime();
        return e.tenantId === tenantId && ts >= start && ts <= end;
      })
      .map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : undefined }));
  }
}
