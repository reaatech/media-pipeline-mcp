export interface CostEntry {
  id: string;
  runId: string;
  tenantId?: string;
  stepId: string;
  provider: string;
  operation: string;
  modelId: string;
  inputUnits: number;
  outputUnits: number;
  inputUnitType: 'tokens' | 'seconds' | 'pixels' | 'characters' | 'requests';
  outputUnitType: 'tokens' | 'seconds' | 'pixels' | 'characters' | 'requests';
  usd: number;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface CostEstimate {
  provider: string;
  operation: string;
  modelId: string;
  inputUnits: number;
  outputUnitsLow: number;
  outputUnitsHigh: number;
  usdLow: number;
  usdHigh: number;
}

/**
 * Time-bounded window for tenant queries.
 *
 * Plan §0.2 names these `since` / `until`; the in-tree implementation initially used
 * `start` / `end`. Both pairs are accepted at the API boundary — `start`/`end` are
 * the canonical fields and `since`/`until` are spec-compat aliases.
 */
export interface TimeWindow {
  /** ISO 8601 lower bound. */
  start: string;
  /** ISO 8601 upper bound. */
  end: string;
  /** Spec-compat alias for `start`. */
  since?: string;
  /** Spec-compat alias for `end`. */
  until?: string;
}

export type CostScope =
  | { type: 'run'; runId: string; kind?: 'run' }
  | {
      type: 'tenant';
      tenantId: string;
      timeWindow: TimeWindow;
      window?: TimeWindow;
      kind?: 'tenant';
    };

export interface PreflightResult {
  allowed: boolean;
  currentSpentUsd: number;
  requestEstimateUsd: number;
  capUsd: number;
  scope: string;
  reason?: string;
  /** Spec-compat alias: capUsd - currentSpentUsd (clamped at 0). */
  remainingUsd?: number;
}

export interface CostLedger {
  charge(entry: CostEntry): Promise<void>;
  preflight(estimate: CostEstimate, scope: CostScope): Promise<PreflightResult>;
  totalForRun(runId: string): Promise<number>;
  totalForTenant(tenantId: string, timeWindow: TimeWindow): Promise<number>;
  listEntries(scope: CostScope): Promise<CostEntry[]>;
}
