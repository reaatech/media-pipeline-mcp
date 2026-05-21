import {
  RunInProgressError,
  RunNotFoundError,
  StateStoreUnavailableError,
} from '@reaatech/media-pipeline-mcp-core';
import type { PipelineEvent, PipelineRun, PipelineStateStore, RunFilter } from './types.js';

/**
 * Minimal slice of the ioredis API that this store relies on. Importing the real
 * type would force `ioredis` to be a hard dep; declaring locally keeps it optional
 * (plan §0.1 — Redis is an opt-in backend).
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, ...args: (string | number)[]): Promise<number | string>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...args: unknown[]
  ): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  ping(): Promise<string>;
  quit?(): Promise<unknown>;
}

export interface RedisPipelineStateStoreConfig {
  client: RedisClientLike;
  /** Key namespace. Default `mp`. */
  prefix?: string;
  /** TTL for run, events, tenant index. Default 30d (plan §0.1 table). */
  runTtlSeconds?: number;
  /** Lock TTL (plan §0.1 — `SET key 1 NX EX 60`). Default 60s. */
  lockTtlSeconds?: number;
  /** Idempotency entry TTL. Default 24h. */
  idempotencyTtlSeconds?: number;
  /** External-job mapping TTL. Default 7d. */
  externalJobTtlSeconds?: number;
  /** Hard upper bound on lock acquisition wait. Default 5_000ms. */
  lockAcquireTimeoutMs?: number;
  /** Lock acquisition poll interval. Default 100ms. */
  lockPollIntervalMs?: number;
}

const DAY = 86_400;

/**
 * Redis-backed PipelineStateStore. Implements the schema in plan §0.1:
 *
 * | Key                          | Type   | Value             | TTL  |
 * |------------------------------|--------|-------------------|------|
 * | `mp:run:<runId>`             | string | JSON(PipelineRun) | 30d  |
 * | `mp:run:<runId>:events`      | list   | JSON event lines  | 30d  |
 * | `mp:run:<runId>:lock`        | string | "1" (SET NX EX)   | 60s  |
 * | `mp:idem:<key>`              | string | runId             | 24h  |
 * | `mp:job:<provider>:<jobId>`  | string | runId             | 7d   |
 * | `mp:tenant:<tenantId>:runs`  | zset   | runId (createdAt) | 30d  |
 *
 * Locking is `SET NX EX <lockTtlSeconds>` with up to `lockAcquireTimeoutMs` of
 * polling. On Redis errors, `StateStoreUnavailableError` is thrown (retryable).
 */
export class RedisPipelineStateStore implements PipelineStateStore {
  private readonly client: RedisClientLike;
  private readonly prefix: string;
  private readonly runTtlSeconds: number;
  private readonly lockTtlSeconds: number;
  private readonly idempotencyTtlSeconds: number;
  private readonly externalJobTtlSeconds: number;
  private readonly lockAcquireTimeoutMs: number;
  private readonly lockPollIntervalMs: number;

  constructor(config: RedisPipelineStateStoreConfig) {
    this.client = config.client;
    this.prefix = config.prefix ?? 'mp';
    this.runTtlSeconds = config.runTtlSeconds ?? 30 * DAY;
    this.lockTtlSeconds = config.lockTtlSeconds ?? 60;
    this.idempotencyTtlSeconds = config.idempotencyTtlSeconds ?? DAY;
    this.externalJobTtlSeconds = config.externalJobTtlSeconds ?? 7 * DAY;
    this.lockAcquireTimeoutMs = config.lockAcquireTimeoutMs ?? 5_000;
    this.lockPollIntervalMs = config.lockPollIntervalMs ?? 100;
  }

  private runKey(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }
  private eventsKey(runId: string): string {
    return `${this.prefix}:run:${runId}:events`;
  }
  private lockKey(runId: string): string {
    return `${this.prefix}:run:${runId}:lock`;
  }
  private idempotencyKey(key: string): string {
    return `${this.prefix}:idem:${key}`;
  }
  private jobKey(provider: string, jobId: string): string {
    return `${this.prefix}:job:${provider}:${jobId}`;
  }
  private tenantKey(tenantId: string): string {
    return `${this.prefix}:tenant:${tenantId}:runs`;
  }

  private async wrap<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      const error = err as Error & { code?: string };
      if (
        error?.code === 'ECONNREFUSED' ||
        error?.code === 'ECONNRESET' ||
        error?.code === 'ETIMEDOUT' ||
        /redis|connection/i.test(error?.message ?? '')
      ) {
        throw new StateStoreUnavailableError();
      }
      throw err;
    }
  }

  async create(run: PipelineRun): Promise<void> {
    return this.wrap(async () => {
      const key = this.runKey(run.runId);
      const existing = await this.client.get(key);
      if (existing) {
        throw new RunInProgressError();
      }
      await this.client.set(key, JSON.stringify(run), 'EX', this.runTtlSeconds);
      if (run.tenantId) {
        const ts = Date.parse(run.createdAt) || Date.now();
        await this.client.zadd(this.tenantKey(run.tenantId), ts, run.runId);
        await this.client.expire(this.tenantKey(run.tenantId), this.runTtlSeconds);
      }
      if (run.idempotencyKey) {
        await this.client.set(
          this.idempotencyKey(run.idempotencyKey),
          run.runId,
          'EX',
          this.idempotencyTtlSeconds,
        );
      }
      for (const [provider, jobId] of Object.entries(run.externalJobIds ?? {})) {
        await this.client.set(
          this.jobKey(provider, jobId),
          run.runId,
          'EX',
          this.externalJobTtlSeconds,
        );
      }
    });
  }

  async get(runId: string): Promise<PipelineRun | null> {
    return this.wrap(async () => {
      const raw = await this.client.get(this.runKey(runId));
      if (!raw) return null;
      const run = JSON.parse(raw) as PipelineRun;
      // events are stored separately; hydrate so callers see the canonical shape.
      const evs = await this.client.lrange(this.eventsKey(runId), 0, -1);
      run.events = evs.map((s) => JSON.parse(s) as PipelineEvent);
      return run;
    });
  }

  async update(
    runId: string,
    patch: Partial<PipelineRun>,
    expectedVersion?: number,
  ): Promise<void> {
    return this.wrap(async () => {
      const raw = await this.client.get(this.runKey(runId));
      if (!raw) {
        throw new RunNotFoundError();
      }
      const existing = JSON.parse(raw) as PipelineRun;
      if (expectedVersion !== undefined && existing.version !== expectedVersion) {
        throw new RunInProgressError();
      }
      const previousJobs = existing.externalJobIds ?? {};
      const merged: PipelineRun = {
        ...existing,
        ...patch,
        // Don't let patch reset events; those live in a separate list.
        events: existing.events,
        updatedAt: new Date().toISOString(),
        version: (existing.version ?? 0) + 1,
      };
      await this.client.set(
        this.runKey(runId),
        JSON.stringify({ ...merged, events: [] }),
        'EX',
        this.runTtlSeconds,
      );
      // Update job index for any newly assigned external job ids.
      const newJobs = merged.externalJobIds ?? {};
      for (const [provider, jobId] of Object.entries(newJobs)) {
        if (previousJobs[provider] !== jobId) {
          await this.client.set(
            this.jobKey(provider, jobId),
            runId,
            'EX',
            this.externalJobTtlSeconds,
          );
        }
      }
    });
  }

  async cancel(runId: string, reason: string): Promise<void> {
    return this.wrap(async () => {
      const raw = await this.client.get(this.runKey(runId));
      if (!raw) {
        throw new RunNotFoundError();
      }
      const existing = JSON.parse(raw) as PipelineRun;
      existing.status = 'cancelled';
      existing.error = reason;
      existing.updatedAt = new Date().toISOString();
      existing.version = (existing.version ?? 0) + 1;
      await this.client.set(
        this.runKey(runId),
        JSON.stringify({ ...existing, events: [] }),
        'EX',
        this.runTtlSeconds,
      );
    });
  }

  async appendEvent(runId: string, event: PipelineEvent): Promise<void> {
    return this.wrap(async () => {
      const exists = await this.client.get(this.runKey(runId));
      if (!exists) throw new RunNotFoundError();
      await this.client.rpush(this.eventsKey(runId), JSON.stringify(event));
      await this.client.expire(this.eventsKey(runId), this.runTtlSeconds);
    });
  }

  async listEvents(runId: string, sinceSeq?: number): Promise<PipelineEvent[]> {
    return this.wrap(async () => {
      const exists = await this.client.get(this.runKey(runId));
      if (!exists) throw new RunNotFoundError();
      const start = sinceSeq !== undefined && sinceSeq >= 0 ? sinceSeq : 0;
      const raw = await this.client.lrange(this.eventsKey(runId), start, -1);
      return raw.map((s) => JSON.parse(s) as PipelineEvent);
    });
  }

  async listRuns(filter?: RunFilter): Promise<PipelineRun[]> {
    return this.wrap(async () => {
      // Fast path when scoped by tenant — use the per-tenant zset index.
      if (filter?.tenantId) {
        const min = filter.since ? Date.parse(filter.since) || 0 : 0;
        const max = filter.until
          ? Date.parse(filter.until) || Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
        const runIds = await this.client.zrangebyscore(this.tenantKey(filter.tenantId), min, max);
        const runs: PipelineRun[] = [];
        for (const id of runIds) {
          const run = await this.get(id);
          if (run && matchesFilter(run, filter)) runs.push(run);
        }
        runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return applyPaging(runs, filter);
      }
      // No tenant index — this is an O(N) op and is documented as such; Redis store
      // users querying without a tenant scope should keep result sets bounded.
      // (See plan §0.1: production deployments scope by tenant.)
      // For idempotency key lookups we have a direct index.
      if (filter?.idempotencyKey) {
        const runId = await this.client.get(this.idempotencyKey(filter.idempotencyKey));
        if (!runId) return [];
        const run = await this.get(runId);
        return run && matchesFilter(run, filter) ? [run] : [];
      }
      return [];
    });
  }

  async findByExternalJobId(provider: string, jobId: string): Promise<PipelineRun | null> {
    return this.wrap(async () => {
      const runId = await this.client.get(this.jobKey(provider, jobId));
      if (!runId) return null;
      return this.get(runId);
    });
  }

  async withLock<T>(
    runId: string,
    fn: (run: PipelineRun) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const deadline = Date.now() + (timeoutMs ?? this.lockAcquireTimeoutMs);
    const lockKey = this.lockKey(runId);
    let acquired = false;
    while (Date.now() < deadline) {
      const res = await this.wrap(() =>
        this.client.set(lockKey, '1', 'NX', 'EX', this.lockTtlSeconds),
      );
      if (res === 'OK' || res === 1) {
        acquired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, this.lockPollIntervalMs));
    }
    if (!acquired) {
      throw new RunInProgressError();
    }
    try {
      const run = await this.get(runId);
      if (!run) throw new RunNotFoundError();
      return await fn(run);
    } finally {
      // Best-effort release — TTL ensures locks never leak.
      await this.client.del(lockKey).catch(() => undefined);
    }
  }
}

function matchesFilter(run: PipelineRun, filter?: RunFilter): boolean {
  if (!filter) return true;
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(run.status)) return false;
  }
  if (filter.idempotencyKey && run.idempotencyKey !== filter.idempotencyKey) return false;
  if (filter.since && run.createdAt < filter.since) return false;
  if (filter.until && run.createdAt > filter.until) return false;
  return true;
}

function applyPaging(runs: PipelineRun[], filter?: RunFilter): PipelineRun[] {
  let result = runs;
  if (filter?.offset) result = result.slice(filter.offset);
  if (filter?.limit) result = result.slice(0, filter.limit);
  return result;
}
