import type { BudgetConfig } from '@reaatech/media-pipeline-mcp-core';

export type PipelineRunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'gated'
  | 'cached'
  | 'cancelled';

export interface StepState {
  stepId: string;
  operation: string;
  inputs: Record<string, unknown>;
  status: StepStatus;
  attempts: number;
  maxRetries?: number;
  artifactIds: string[];
  costUsd: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  cacheKey?: string;
  lastError?: { code: string; message: string; retryable: boolean; at: string };
}

export interface PipelineRun {
  runId: string;
  pipelineId: string;
  status: PipelineRunStatus;
  tenantId?: string;
  pipelineDefHash: string;
  idempotencyKey?: string;
  externalJobId?: string;
  externalJobIds: Record<string, string>;
  currentStepIndex: number;
  steps: StepState[];
  events: PipelineEvent[];
  error?: string;
  budget?: BudgetConfig;
  resumeToken?: string;
  resumable?: boolean;
  startedAt?: string;
  costUsd?: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// Canonical event taxonomy (plan §0.1). The earlier `'pipeline:start'`/`'step:complete'`
// kebab-namespaced events were legacy from the pre-plan code and have been removed —
// emit the kebab-case spec events below instead.
export type PipelineEvent =
  | { kind: 'run-created'; runId: string; at: number; pipelineDefHash: string }
  | { kind: 'run-started'; runId: string; at: number }
  | { kind: 'step-started'; runId: string; stepId: string; at: number; attempt: number }
  | {
      kind: 'step-progress';
      runId: string;
      stepId: string;
      at: number;
      pct: number;
      etaMs?: number;
      message?: string;
      costUsdAccrued?: number;
    }
  | {
      kind: 'step-cached';
      runId: string;
      stepId: string;
      at: number;
      cacheKey: string;
      artifactIds: string[];
    }
  | {
      kind: 'step-completed';
      runId: string;
      stepId: string;
      at: number;
      artifactIds: string[];
      costUsd: number;
    }
  | {
      kind: 'step-failed';
      runId: string;
      stepId: string;
      at: number;
      code: string;
      retryable: boolean;
    }
  | {
      kind: 'step-gated';
      runId: string;
      stepId: string;
      at: number;
      gateType: string;
      verdict: string;
    }
  | {
      kind: 'run-suspended';
      runId: string;
      at: number;
      reason: 'webhook' | 'budget' | 'gate';
      resumeToken: string;
    }
  | { kind: 'run-resumed'; runId: string; at: number; fromStepId: string }
  | { kind: 'run-completed'; runId: string; at: number; totalCostUsd: number }
  | { kind: 'run-failed'; runId: string; at: number; code: string; terminalReason: string };

export interface RunFilter {
  status?: PipelineRunStatus | PipelineRunStatus[];
  /** Filter by tenant (F18 multi-tenant). */
  tenantId?: string;
  /** Lookup the run associated with a given idempotency key (F1). */
  idempotencyKey?: string;
  /** ISO 8601 lower bound on createdAt for time-window queries. */
  since?: string;
  /** Optional upper bound on createdAt. */
  until?: string;
  limit?: number;
  offset?: number;
}

export interface PipelineStateStore {
  create(run: PipelineRun): Promise<void>;
  /** Returns null on miss — callers nullcheck rather than try/catch. */
  get(runId: string): Promise<PipelineRun | null>;
  update(runId: string, patch: Partial<PipelineRun>, expectedVersion?: number): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  appendEvent(runId: string, event: PipelineEvent): Promise<void>;
  /** Replay events from `sinceSeq` (exclusive). Used by F6 reconnect to fast-forward. */
  listEvents(runId: string, sinceSeq?: number): Promise<PipelineEvent[]>;
  listRuns(filter?: RunFilter): Promise<PipelineRun[]>;
  findByExternalJobId(provider: string, jobId: string): Promise<PipelineRun | null>;
  /**
   * Acquire an exclusive write lock for the duration of `fn`. Blocks up to `timeoutMs`
   * (default 5000ms); throws `RunInProgressError` on timeout. In-memory implementations
   * are single-process; production deployments must use a backing store with cross-process
   * locking semantics (Redis SET NX EX, Postgres advisory locks).
   */
  withLock<T>(runId: string, fn: (run: PipelineRun) => Promise<T>, timeoutMs?: number): Promise<T>;
}
