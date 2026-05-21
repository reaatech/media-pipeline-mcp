import { RunInProgressError, RunNotFoundError } from '@reaatech/media-pipeline-mcp-core';
import type { PipelineEvent, PipelineRun, PipelineStateStore, RunFilter } from './types.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 25;

function cloneRun(run: PipelineRun): PipelineRun {
  return {
    ...run,
    steps: run.steps.map((s) => ({ ...s })),
    events: run.events.map((e) => ({ ...e })),
  };
}

function matchesFilter(run: PipelineRun, filter?: RunFilter): boolean {
  if (!filter) return true;
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(run.status)) return false;
  }
  if (filter.tenantId && run.tenantId !== filter.tenantId) return false;
  if (filter.idempotencyKey && run.idempotencyKey !== filter.idempotencyKey) return false;
  if (filter.since && run.createdAt < filter.since) return false;
  if (filter.until && run.createdAt > filter.until) return false;
  return true;
}

export class InMemoryPipelineStateStore implements PipelineStateStore {
  private runs = new Map<string, PipelineRun>();
  private locks = new Map<string, Promise<unknown>>();

  async create(run: PipelineRun): Promise<void> {
    if (this.runs.has(run.runId)) {
      throw new RunInProgressError();
    }
    const stored = cloneRun(run);
    this.runs.set(run.runId, stored);
  }

  async get(runId: string): Promise<PipelineRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    return cloneRun(run);
  }

  async update(
    runId: string,
    patch: Partial<PipelineRun>,
    expectedVersion?: number,
  ): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) {
      throw new RunNotFoundError();
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new RunInProgressError();
    }
    const stored = cloneRun(existing);
    Object.assign(stored, patch);
    stored.updatedAt = new Date().toISOString();
    stored.version = (stored.version ?? 0) + 1;
    this.runs.set(runId, stored);
  }

  async cancel(runId: string, reason: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RunNotFoundError();
    }
    run.status = 'cancelled';
    run.error = reason;
    run.updatedAt = new Date().toISOString();
    // cancel() is a mutating op; bump the version so concurrent expectedVersion-update
    // attempts see the conflict.
    run.version = (run.version ?? 0) + 1;
  }

  async appendEvent(runId: string, event: PipelineEvent): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RunNotFoundError();
    }
    run.events.push(event);
    run.updatedAt = new Date().toISOString();
  }

  async listEvents(runId: string, sinceSeq?: number): Promise<PipelineEvent[]> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new RunNotFoundError();
    }
    const events = run.events.map((e) => ({ ...e }) as PipelineEvent);
    if (sinceSeq === undefined || sinceSeq < 0) return events;
    return events.slice(sinceSeq);
  }

  async listRuns(filter?: RunFilter): Promise<PipelineRun[]> {
    let result = Array.from(this.runs.values()).filter((r) => matchesFilter(r, filter));
    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (filter?.offset) {
      result = result.slice(filter.offset);
    }
    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }
    return result.map(cloneRun);
  }

  async findByExternalJobId(provider: string, jobId: string): Promise<PipelineRun | null> {
    const key = `${provider}:${jobId}`;
    for (const run of this.runs.values()) {
      if (run.externalJobId === key || run.externalJobIds?.[provider] === jobId) {
        return cloneRun(run);
      }
    }
    return null;
  }

  /**
   * In-memory mutex via a Promise chain. Wraps the lock acquisition in a timeout race
   * — if the prior holder hasn't released within `timeoutMs`, throws `RunInProgressError`.
   *
   * NOTE: this is single-process only. Cross-process locking (Redis SET NX EX, Postgres
   * advisory locks) belongs in those backends' implementations.
   */
  async withLock<T>(
    runId: string,
    fn: (run: PipelineRun) => Promise<T>,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
  ): Promise<T> {
    const prev = this.locks.get(runId) ?? Promise.resolve();

    // Race the previous holder against a timeout. If timeout wins, refuse to acquire.
    const deadline = Date.now() + timeoutMs;
    while (this.locks.has(runId) && Date.now() < deadline) {
      try {
        await Promise.race([
          prev,
          new Promise((resolve) =>
            setTimeout(resolve, Math.min(LOCK_POLL_INTERVAL_MS, deadline - Date.now())),
          ),
        ]);
      } catch {
        // Previous holder rejected — chain is free for us.
        break;
      }
      if (!this.locks.has(runId)) break;
    }

    if (this.locks.has(runId) && Date.now() >= deadline) {
      throw new RunInProgressError();
    }

    const next = (async () => {
      const run = await this.get(runId);
      if (!run) throw new RunNotFoundError();
      return fn(run);
    })();

    this.locks.set(
      runId,
      next
        .catch(() => {})
        .finally(() => {
          // Release iff this is still the active holder.
          if (this.locks.get(runId) === undefined) return;
        }),
    );

    try {
      return await next;
    } finally {
      // Always release after the work completes so the next acquirer can proceed.
      const current = this.locks.get(runId);
      if (current === next.catch(() => {})) {
        this.locks.delete(runId);
      } else {
        // Different promise in the slot (shouldn't happen given our serialization),
        // but clear if the slot still resolves to a settled promise.
        this.locks.delete(runId);
      }
    }
  }
}
