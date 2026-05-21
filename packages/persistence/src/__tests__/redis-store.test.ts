import {
  RunInProgressError,
  RunNotFoundError,
  StateStoreUnavailableError,
} from '@reaatech/media-pipeline-mcp-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RedisClientLike, RedisPipelineStateStore } from '../redis-store.js';
import type { PipelineEvent, PipelineRun } from '../types.js';

function createTestRun(overrides?: Partial<PipelineRun>): PipelineRun {
  const now = new Date().toISOString();
  return {
    runId: 'run-1',
    pipelineId: 'pipeline-1',
    status: 'pending',
    pipelineDefHash: 'hash-1',
    externalJobIds: {},
    currentStepIndex: 0,
    steps: [],
    events: [],
    costUsd: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Minimal in-memory fake of the subset of ioredis we use. Lets us cover the
 * full RedisPipelineStateStore surface without booting a real Redis server.
 * (Behavior of SET NX, EX, ZADD, ZRANGEBYSCORE, LRANGE, RPUSH, DEL, EXPIRE,
 * GET, PING is sufficient for the store's needs.)
 */
class FakeRedis implements RedisClientLike {
  strings = new Map<string, string>();
  lists = new Map<string, string[]>();
  zsets = new Map<string, Array<{ score: number; member: string }>>();
  expires = new Map<string, number>(); // unused except to satisfy the API
  failNext = false;

  private maybeFail() {
    if (this.failNext) {
      this.failNext = false;
      const err = new Error('Redis connection refused');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
    }
  }

  async get(key: string): Promise<string | null> {
    this.maybeFail();
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    this.maybeFail();
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const flag = String(args[i]).toUpperCase();
      if (flag === 'NX') nx = true;
      // EX is no-op for the fake (we don't model TTL expiration).
      if (flag === 'EX') i++;
    }
    if (nx && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.maybeFail();
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) n++;
      if (this.lists.delete(k)) n++;
      if (this.zsets.delete(k)) n++;
    }
    return n;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.maybeFail();
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.maybeFail();
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    this.maybeFail();
    const set = this.zsets.get(key) ?? [];
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      const idx = set.findIndex((e) => e.member === member);
      if (idx >= 0) set[idx]!.score = score;
      else set.push({ score, member });
    }
    this.zsets.set(key, set);
    return set.length;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    this.maybeFail();
    const set = [...(this.zsets.get(key) ?? [])].sort((a, b) => a.score - b.score);
    const end = stop === -1 ? set.length : stop + 1;
    return set.slice(start, end).map((e) => e.member);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    this.maybeFail();
    const lo = typeof min === 'number' ? min : Number(min);
    const hi = typeof max === 'number' ? max : Number(max);
    const set = [...(this.zsets.get(key) ?? [])]
      .filter((e) => e.score >= lo && e.score <= hi)
      .sort((a, b) => a.score - b.score);
    return set.map((e) => e.member);
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    this.maybeFail();
    return 1;
  }

  async ping(): Promise<string> {
    this.maybeFail();
    return 'PONG';
  }
}

describe('RedisPipelineStateStore', () => {
  let fake: FakeRedis;
  let store: RedisPipelineStateStore;

  beforeEach(() => {
    fake = new FakeRedis();
    store = new RedisPipelineStateStore({ client: fake, prefix: 'mp' });
  });

  it('creates and gets a run', async () => {
    const run = createTestRun();
    await store.create(run);
    const loaded = await store.get('run-1');
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.status).toBe('pending');
  });

  it('returns null on get for unknown run', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('throws RunInProgressError on duplicate create', async () => {
    await store.create(createTestRun());
    await expect(store.create(createTestRun())).rejects.toBeInstanceOf(RunInProgressError);
  });

  it('updates with version check', async () => {
    await store.create(createTestRun({ version: 1 }));
    await store.update('run-1', { status: 'running' }, 1);
    const r = await store.get('run-1');
    expect(r?.status).toBe('running');
    expect(r?.version).toBe(2);
  });

  it('rejects update on version conflict', async () => {
    await store.create(createTestRun({ version: 1 }));
    await expect(store.update('run-1', { status: 'running' }, 99)).rejects.toBeInstanceOf(
      RunInProgressError,
    );
  });

  it('throws RunNotFoundError on update of missing run', async () => {
    await expect(store.update('ghost', { status: 'running' })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it('appends and lists events', async () => {
    await store.create(createTestRun());
    const event: PipelineEvent = {
      kind: 'step-started',
      runId: 'run-1',
      stepId: 's1',
      at: Date.now(),
      attempt: 1,
    };
    await store.appendEvent('run-1', event);
    await store.appendEvent('run-1', {
      ...event,
      kind: 'step-completed',
      artifactIds: [],
      costUsd: 0,
    } as PipelineEvent);
    const events = await store.listEvents('run-1');
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe('step-started');
  });

  it('lists events from a starting sequence', async () => {
    await store.create(createTestRun());
    for (let i = 0; i < 3; i++) {
      await store.appendEvent('run-1', {
        kind: 'step-started',
        runId: 'run-1',
        stepId: `s${i}`,
        at: Date.now(),
        attempt: 1,
      });
    }
    const events = await store.listEvents('run-1', 1);
    expect(events).toHaveLength(2);
  });

  it('cancels a run and bumps version', async () => {
    await store.create(createTestRun({ version: 1 }));
    await store.cancel('run-1', 'user requested');
    const r = await store.get('run-1');
    expect(r?.status).toBe('cancelled');
    expect(r?.error).toBe('user requested');
    expect(r?.version).toBe(2);
  });

  it('indexes external job ids and finds runs by them', async () => {
    await store.create(createTestRun({ externalJobIds: { replicate: 'pred_123' } }));
    const run = await store.findByExternalJobId('replicate', 'pred_123');
    expect(run?.runId).toBe('run-1');
  });

  it('returns null for unknown external job', async () => {
    expect(await store.findByExternalJobId('replicate', 'nope')).toBeNull();
  });

  it('writes new external jobs on update', async () => {
    await store.create(createTestRun());
    await store.update('run-1', { externalJobIds: { fal: 'fal_999' } });
    const run = await store.findByExternalJobId('fal', 'fal_999');
    expect(run?.runId).toBe('run-1');
  });

  it('lists tenant runs scoped by time window', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() + 60_000).toISOString();
    await store.create(createTestRun({ runId: 'a', tenantId: 'acme' }));
    await store.create(createTestRun({ runId: 'b', tenantId: 'acme' }));
    await store.create(createTestRun({ runId: 'c', tenantId: 'other' }));
    const runs = await store.listRuns({ tenantId: 'acme', since: t0, until: t1 });
    expect(runs.map((r) => r.runId).sort()).toEqual(['a', 'b']);
  });

  it('looks up by idempotency key', async () => {
    await store.create(createTestRun({ idempotencyKey: 'idem-1' }));
    const runs = await store.listRuns({ idempotencyKey: 'idem-1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe('run-1');
  });

  it('runs work under withLock and releases lock after', async () => {
    await store.create(createTestRun());
    const result = await store.withLock('run-1', async (run) => `seen:${run.runId}`);
    expect(result).toBe('seen:run-1');
    // Lock released — a second acquire succeeds immediately.
    const second = await store.withLock('run-1', async () => 'ok');
    expect(second).toBe('ok');
  });

  it('throws RunInProgressError when lock cannot be acquired', async () => {
    await store.create(createTestRun());
    // Pre-occupy the lock key so SET NX fails for the duration of the test.
    await fake.set('mp:run:run-1:lock', '1');
    const tightStore = new RedisPipelineStateStore({
      client: fake,
      lockAcquireTimeoutMs: 100,
      lockPollIntervalMs: 20,
    });
    await expect(tightStore.withLock('run-1', async () => 'x')).rejects.toBeInstanceOf(
      RunInProgressError,
    );
  });

  it('maps Redis connection errors to StateStoreUnavailableError', async () => {
    fake.failNext = true;
    await expect(store.get('anything')).rejects.toBeInstanceOf(StateStoreUnavailableError);
  });

  it('preserves events across update calls', async () => {
    await store.create(createTestRun());
    await store.appendEvent('run-1', {
      kind: 'run-started',
      runId: 'run-1',
      at: Date.now(),
    });
    await store.update('run-1', { status: 'running' });
    const events = await store.listEvents('run-1');
    expect(events).toHaveLength(1);
  });
});
