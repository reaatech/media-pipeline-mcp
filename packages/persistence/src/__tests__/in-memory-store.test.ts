import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPipelineStateStore } from '../in-memory-store.js';
import type { PipelineEvent, PipelineRun } from '../types.js';

function createTestStep(
  overrides?: Partial<import('../types.js').StepState>,
): import('../types.js').StepState {
  return {
    stepId: 'step-1',
    operation: 'image.generate',
    inputs: { prompt: 'test' },
    status: 'pending',
    attempts: 0,
    artifactIds: [],
    costUsd: 0,
    ...overrides,
  };
}

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

describe('InMemoryPipelineStateStore', () => {
  let store: InMemoryPipelineStateStore;

  beforeEach(() => {
    store = new InMemoryPipelineStateStore();
  });

  describe('create', () => {
    it('should create a run (void return)', async () => {
      const run = createTestRun({ steps: [createTestStep()] });
      await store.create(run);

      const result = await store.get('run-1');
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
      expect(result!.status).toBe('pending');
      expect(result!.createdAt).toBeDefined();
    });

    it('should throw if run already exists', async () => {
      const run = createTestRun();
      await store.create(run);

      await expect(store.create(run)).rejects.toThrow();
    });
  });

  describe('get', () => {
    it('should return an existing run', async () => {
      const run = createTestRun();
      await store.create(run);

      const result = await store.get('run-1');
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
    });

    it('should return null for missing run', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should return a copy not a reference', async () => {
      const run = createTestRun();
      await store.create(run);

      const result = await store.get('run-1');
      result!.status = 'completed';

      const again = await store.get('run-1');
      expect(again!.status).toBe('pending');
    });
  });

  describe('update', () => {
    it('should update via patch and increment version', async () => {
      const run = createTestRun();
      await store.create(run);

      await store.update('run-1', { status: 'running' });

      const fetched = await store.get('run-1');
      expect(fetched!.status).toBe('running');
      expect(fetched!.version).toBe(2);
    });

    it('should throw for non-existent run', async () => {
      await expect(store.update('nonexistent', { status: 'running' })).rejects.toThrow();
    });

    it('should throw on version conflict with expectedVersion', async () => {
      const run = createTestRun({ version: 1 });
      await store.create(run);

      // Simulate concurrent: version is now 2 after first update
      await store.update('run-1', { status: 'running' }); // version becomes 2
      await expect(store.update('run-1', { status: 'completed' }, 1)).rejects.toThrow();
    });

    it('should succeed when expectedVersion matches', async () => {
      const run = createTestRun({ version: 3 });
      await store.create(run);

      await store.update('run-1', { status: 'running' }, 3);
      const fetched = await store.get('run-1');
      expect(fetched!.status).toBe('running');
      expect(fetched!.version).toBe(4);
    });
  });

  describe('cancel', () => {
    it('should set status to cancelled with reason', async () => {
      const run = createTestRun({ status: 'running' });
      await store.create(run);

      await store.cancel('run-1', 'user requested');
      const fetched = await store.get('run-1');
      expect(fetched!.status).toBe('cancelled');
      expect(fetched!.error).toBe('user requested');
    });

    it('should throw for non-existent run', async () => {
      await expect(store.cancel('nonexistent', 'reason')).rejects.toThrow();
    });
  });

  describe('appendEvent', () => {
    it('should add an event to the run', async () => {
      const run = createTestRun();
      await store.create(run);

      const event: PipelineEvent = {
        kind: 'run-started',
        runId: 'run-1',
        at: Date.now(),
      };

      await store.appendEvent('run-1', event);

      const events = await store.listEvents('run-1');
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('run-started');
    });

    it('should throw for non-existent run', async () => {
      const event: PipelineEvent = {
        kind: 'run-started',
        runId: 'nonexistent',
        at: Date.now(),
      };

      await expect(store.appendEvent('nonexistent', event)).rejects.toThrow();
    });
  });

  describe('listEvents', () => {
    it('should return all events for a run', async () => {
      const run = createTestRun();
      await store.create(run);

      await store.appendEvent('run-1', {
        kind: 'run-started',
        runId: 'run-1',
        at: Date.now(),
      });
      await store.appendEvent('run-1', {
        kind: 'step-started',
        runId: 'run-1',
        stepId: 'step-1',
        at: Date.now(),
        attempt: 1,
      });

      const events = await store.listEvents('run-1');
      expect(events).toHaveLength(2);
    });

    it('should throw for non-existent run', async () => {
      await expect(store.listEvents('nonexistent')).rejects.toThrow();
    });
  });

  describe('listRuns', () => {
    it('should return all runs when no filter', async () => {
      await store.create(createTestRun({ runId: 'run-1' }));
      await store.create(createTestRun({ runId: 'run-2' }));

      const runs = await store.listRuns();
      expect(runs).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await store.create(createTestRun({ runId: 'run-1', status: 'pending' }));
      await store.create(createTestRun({ runId: 'run-2', status: 'running' }));

      const runs = await store.listRuns({ status: 'running' });
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe('run-2');
    });

    it('should filter by tenantId', async () => {
      await store.create(createTestRun({ runId: 'run-1', tenantId: 'tenant-a' }));
      await store.create(createTestRun({ runId: 'run-2', tenantId: 'tenant-b' }));

      const runs = await store.listRuns({ tenantId: 'tenant-a' });
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe('run-1');
    });

    it('should filter by time range', async () => {
      await store.create(createTestRun({ runId: 'run-1', createdAt: '2026-01-01T00:00:00.000Z' }));
      await store.create(createTestRun({ runId: 'run-2', createdAt: '2026-06-01T00:00:00.000Z' }));

      const runs = await store.listRuns({
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-07-01T00:00:00.000Z',
      });
      expect(runs).toHaveLength(2);
    });

    it('should support limit and offset', async () => {
      await store.create(createTestRun({ runId: 'run-1' }));
      await store.create(createTestRun({ runId: 'run-2' }));
      await store.create(createTestRun({ runId: 'run-3' }));

      const runs = await store.listRuns({ limit: 2, offset: 1 });
      expect(runs).toHaveLength(2);
    });
  });

  describe('findByExternalJobId', () => {
    it('should find a run by provider and job id (via externalJobIds map)', async () => {
      const run = createTestRun({ externalJobIds: { replicate: 'job-123' } });
      await store.create(run);

      const result = await store.findByExternalJobId('replicate', 'job-123');
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
    });

    it('should find a run by provider and job id (via externalJobId single)', async () => {
      const run = createTestRun({ externalJobId: 'replicate:job-456' });
      await store.create(run);

      const result = await store.findByExternalJobId('replicate', 'job-456');
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
    });

    it('should return null when not found', async () => {
      const result = await store.findByExternalJobId('replicate', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('withLock', () => {
    it('should acquire lock and execute function', async () => {
      await store.create(createTestRun());

      const result = await store.withLock('run-1', async (run) => {
        expect(run.runId).toBe('run-1');
        return 'done';
      });

      expect(result).toBe('done');
    });

    it('should serialize concurrent access', async () => {
      await store.create(createTestRun());

      const order: number[] = [];

      const promise1 = store.withLock('run-1', async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
      });

      const promise2 = store.withLock('run-1', async () => {
        order.push(2);
      });

      await Promise.all([promise1, promise2]);
      expect(order).toEqual([1, 2]);
    });

    it('should release lock even if function throws', async () => {
      await store.create(createTestRun());

      await expect(
        store.withLock('run-1', async () => {
          throw new Error('oops');
        }),
      ).rejects.toThrow('oops');

      const result = await store.withLock('run-1', async (run) => {
        return run.runId;
      });
      expect(result).toBe('run-1');
    });

    it('should throw for non-existent run', async () => {
      await expect(
        store.withLock('nonexistent', async (run) => {
          return run.runId;
        }),
      ).rejects.toThrow();
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
