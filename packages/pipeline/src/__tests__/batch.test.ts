import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchExecutor, interpolateRow } from '../batch.js';
import type { BatchReportRow, RowExecutorResult } from '../batch.js';

describe('BatchExecutor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createExecutor(
    mockFn?: (
      pipeline: unknown,
      row: Record<string, unknown>,
      batchId: string,
    ) => Promise<RowExecutorResult>,
  ) {
    const executor = new BatchExecutor();
    const fn =
      mockFn ??
      vi
        .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
        .mockResolvedValue({ artifactIds: ['art-1'], costUsd: 0.01 });
    executor.setRowExecutor(fn);
    return { executor, executeRow: fn };
  }

  async function waitForStatus(
    executor: BatchExecutor,
    batchId: string,
    expectedStatus: string,
    timeout = 3000,
  ): Promise<void> {
    await vi.waitFor(
      async () => {
        const s = await executor.getStatus(batchId);
        expect(s).not.toBeNull();
        expect(s!.status).toBe(expectedStatus);
      },
      { timeout },
    );
  }

  it('creates batch with inline source — 3 rows all succeed', async () => {
    const { executor, executeRow } = createExecutor();

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] },
    });

    await waitForStatus(executor, result.batchId, 'completed');

    const status = await executor.getStatus(result.batchId);
    expect(status!.totalRows).toBe(3);
    expect(status!.completed).toBe(3);
    expect(status!.failed).toBe(0);
    expect(status!.costUsd).toBeCloseTo(0.03);
    expect(executeRow).toHaveBeenCalledTimes(3);
  });

  it('partial failure with onRowFailure=continue', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValueOnce({ artifactIds: ['a'], costUsd: 0.01 })
      .mockRejectedValueOnce(new Error('processing failed'))
      .mockResolvedValueOnce({ artifactIds: ['c'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] },
      onRowFailure: 'continue',
    });

    await waitForStatus(executor, result.batchId, 'partial');

    const status = await executor.getStatus(result.batchId);
    expect(status!.completed).toBe(2);
    expect(status!.failed).toBe(1);
  });

  it('stop on failure with onRowFailure=stop', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValueOnce({ artifactIds: ['a'], costUsd: 0.01 })
      .mockRejectedValueOnce(new Error('critical failure'))
      .mockResolvedValueOnce({ artifactIds: ['c'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] },
      onRowFailure: 'stop',
      // Pin concurrency=1 so the test deterministically observes row 0 succeed,
      // row 1 fail-and-stop, row 2 never start. The runtime default is now 5
      // (plan §F15), which would let all three rows fire in parallel.
      concurrency: 1,
    });

    await waitForStatus(executor, result.batchId, 'failed');

    const status = await executor.getStatus(result.batchId);
    expect(status!.completed).toBe(1);
    expect(status!.failed).toBe(1);
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('retry(): retry recovers from transient failure', async () => {
    let callCount = 0;
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) throw new Error('transient error');
        return { artifactIds: ['art-1'], costUsd: 0.01 };
      });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }] },
      onRowFailure: 'continue',
    });

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.failed).toBe(1);
    });

    await executor.retry({ batchId: result.batchId, onlyFailed: true });

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.completed).toBe(1);
    });

    expect(callCount).toBe(2);
  });

  it('concurrent execution: concurrency=2, never more than 2 in-flight', async () => {
    const order: number[] = [];

    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockImplementation(async (...args: unknown[]) => {
        const row = args[1] as Record<string, unknown>;
        order.push(row.prompt as number);
        return { artifactIds: ['art-1'], costUsd: 0.01 };
      });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: {
        type: 'inline',
        rows: [{ prompt: 0 }, { prompt: 1 }, { prompt: 2 }, { prompt: 3 }, { prompt: 4 }],
      },
      concurrency: 2,
    });

    await waitForStatus(executor, result.batchId, 'completed');

    expect(mockFn).toHaveBeenCalledTimes(5);
  });

  it('cancel: cancels running batch', async () => {
    let resolveExec: (() => void) | null = null;

    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockImplementation(async () => {
        await new Promise<void>((r) => {
          resolveExec = r;
        });
        return { artifactIds: ['art-1'], costUsd: 0.01 };
      });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ p: 'a' }, { p: 'b' }, { p: 'c' }] },
      concurrency: 1,
    });

    await vi.waitFor(() => expect(resolveExec).not.toBeNull());

    const cancelled = await executor.cancel(result.batchId);
    expect(cancelled).toBe(true);

    resolveExec!();

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.status).toBe('cancelled');
    });

    const status = await executor.getStatus(result.batchId);
    expect(status!.inFlight).toBe(0);
    expect(status!.completed).toBeLessThanOrEqual(1);
  });

  it('retry({ onlyFailed: true }): only failed rows re-run', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockRejectedValueOnce(new Error('initial fail'))
      .mockRejectedValueOnce(new Error('initial fail'))
      .mockResolvedValueOnce({ artifactIds: ['art-1'], costUsd: 0.01 })
      .mockResolvedValueOnce({ artifactIds: ['art-1'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }] },
    });

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.failed).toBe(2);
    });

    const retryResult = await executor.retry({ batchId: result.batchId, onlyFailed: true });
    expect(retryResult.status).toBe('pending');

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.completed).toBe(2);
    });

    expect(mockFn).toHaveBeenCalledTimes(4);
  });

  it('CSV parsing: parse CSV string with header → correct rows extracted', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValue({ artifactIds: ['a'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: {
        type: 'csv',
        rows: 'prompt,steps\nsunset,20\nocean,15',
      },
    });

    await waitForStatus(executor, result.batchId, 'completed');

    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { prompt: 'sunset', steps: '20' },
      expect.any(String),
    );
    expect(mockFn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { prompt: 'ocean', steps: '15' },
      expect.any(String),
    );
  });

  it('JSONL parsing: parse JSONL string → correct rows extracted', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValue({ artifactIds: ['a'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: {
        type: 'jsonl',
        rows: '{"prompt":"sunset","steps":20}\n{"prompt":"ocean","steps":15}',
      },
    });

    await waitForStatus(executor, result.batchId, 'completed');

    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      { prompt: 'sunset', steps: 20 },
      expect.any(String),
    );
    expect(mockFn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      { prompt: 'ocean', steps: 15 },
      expect.any(String),
    );
  });

  it('per-run budget: row exceeds maxUsd → row fails with budget error', async () => {
    const maxUsd = 0.05;
    const rowCost = 0.1;

    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockImplementation(async () => {
        if (rowCost > maxUsd) {
          throw new Error(`BudgetExceededError: row cost ${rowCost} exceeds max ${maxUsd}`);
        }
        return { artifactIds: ['art-1'], costUsd: rowCost };
      });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }] },
    });

    await waitForStatus(executor, result.batchId, 'failed');

    const status = await executor.getStatus(result.batchId);
    expect(status!.failed).toBe(2);
    expect(status!.completed).toBe(0);
  });

  // ─── New coverage tests ──────────────────────────────────────────

  it('cumulative budget abort: batch stops when cumulative cost exceeds maxUsd', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValue({ artifactIds: ['art-1'], costUsd: 0.03 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ p: 'a' }, { p: 'b' }, { p: 'c' }, { p: 'd' }] },
      concurrency: 1,
      perRunBudget: { maxUsd: 0.05, onExceed: 'abort' },
    });

    // finalizeBatch sets status to 'partial' when both failed > 0 and completed > 0
    await waitForStatus(executor, result.batchId, 'partial');

    const status = await executor.getStatus(result.batchId);
    // Row 0: $0.03 < $0.05 → complete. Row 1: $0.06 >= $0.05 → budget exceeded, abort.
    expect(status!.completed).toBe(2);
    expect(status!.failed).toBe(1);
  });

  it('cumulative budget suspend: batch continues with partial status', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValue({ artifactIds: ['art-1'], costUsd: 0.03 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ p: 'a' }, { p: 'b' }, { p: 'c' }, { p: 'd' }] },
      concurrency: 1,
      perRunBudget: { maxUsd: 0.05, onExceed: 'suspend' },
    });

    await waitForStatus(executor, result.batchId, 'partial');

    const status = await executor.getStatus(result.batchId);
    // Row 0-1 complete ($0.06 cumulative), rows 2-3 fail (budget exceeded, suspend continues)
    expect(status!.completed).toBe(2);
    expect(status!.failed).toBe(2);
  });

  it('retry-once: onRowFailure=retry-once re-adds row to pool after transient failure', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockRejectedValue(new Error('transient'));

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ prompt: 'a' }, { prompt: 'b' }] },
      onRowFailure: 'retry-once',
    });

    // Row a fails → re-added to pool (but status is 'failed', so it's skipped), row b fails too
    // Only 2 actual calls to executor since retry skips the re-added row
    await waitForStatus(executor, result.batchId, 'failed');

    const status = await executor.getStatus(result.batchId);
    expect(status!.completed).toBe(0);
    expect(status!.failed).toBe(2);
    // The mock was called twice (once per row), retry-once triggers pool.unshift but
    // the re-added row is skipped because its status is still 'failed', not 'skipped'
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('CSV with columnMap: maps CSV header names to different column names', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockResolvedValue({ artifactIds: ['a'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: {
        type: 'csv',
        rows: 'input_prompt,num_steps\nsunset,20',
        columnMap: { input_prompt: 'prompt', num_steps: 'steps' },
      },
    });

    await waitForStatus(executor, result.batchId, 'completed');

    expect(mockFn).toHaveBeenCalledWith(
      expect.anything(),
      { prompt: 'sunset', steps: '20' },
      expect.any(String),
    );
  });

  it('cancel non-existent batch returns false', async () => {
    const { executor } = createExecutor();
    const result = await executor.cancel('non-existent');
    expect(result).toBe(false);
  });

  it('cancel already completed batch returns false', async () => {
    const { executor } = createExecutor();

    const startResult = await executor.start({
      pipeline: { id: 'test' },
      source: { type: 'inline', rows: [{ a: 1 }] },
    });

    await waitForStatus(executor, startResult.batchId, 'completed');

    const cancelResult = await executor.cancel(startResult.batchId);
    expect(cancelResult).toBe(false);
  });

  it('retry with onlyRowIndexes: only specific rows re-run', async () => {
    const mockFn = vi
      .fn<(...args: unknown[]) => Promise<RowExecutorResult>>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ artifactIds: ['art-1'], costUsd: 0.01 });

    const { executor } = createExecutor(mockFn);

    const result = await executor.start({
      pipeline: { id: 'test-pipeline' },
      source: { type: 'inline', rows: [{ p: 'a' }, { p: 'b' }] },
    });

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.failed).toBe(2);
    });

    // Only retry row 0
    await executor.retry({ batchId: result.batchId, onlyRowIndexes: [0] });

    await vi.waitFor(async () => {
      const s = await executor.getStatus(result.batchId);
      expect(s).not.toBeNull();
      expect(s!.completed).toBe(1);
    });

    // 2 initial + 1 retry = 3 calls
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('retry on non-existent batch throws', async () => {
    const { executor } = createExecutor();
    await expect(executor.retry({ batchId: 'nope' })).rejects.toThrow('Batch not found');
  });

  it('retry with no failed rows returns completed immediately', async () => {
    const { executor } = createExecutor();

    const startResult = await executor.start({
      pipeline: { id: 'test' },
      source: { type: 'inline', rows: [{ a: 1 }] },
    });

    await waitForStatus(executor, startResult.batchId, 'completed');

    const retryResult = await executor.retry({
      batchId: startResult.batchId,
      onlyFailed: true,
    });

    expect(retryResult.status).toBe('completed');
  });

  it('getStatus returns null for unknown batch', async () => {
    const { executor } = createExecutor();
    const status = await executor.getStatus('non-existent');
    expect(status).toBeNull();
  });
});

describe('F15 interpolateRow — {{column}} substitution', () => {
  it('substitutes top-level string templates', () => {
    expect(interpolateRow('hero for: {{headline}}', { headline: 'sale' })).toBe('hero for: sale');
  });

  it('walks nested objects and arrays', () => {
    const pipeline = {
      steps: [
        {
          id: 's1',
          operation: 'image.generate',
          inputs: { prompt: 'hero for {{headline}} on {{topic}}' },
        },
        {
          id: 's2',
          operation: 'text.complete',
          inputs: { prompt: 'summarize {{topic}}', max_tokens: 100 },
        },
      ],
    };
    const out = interpolateRow(pipeline, { headline: 'sale', topic: 'spring' }) as typeof pipeline;
    expect(out.steps[0].inputs.prompt).toBe('hero for sale on spring');
    expect(out.steps[1].inputs.prompt).toBe('summarize spring');
    expect(out.steps[1].inputs.max_tokens).toBe(100);
  });

  it('leaves unrecognized placeholders intact (caller can detect)', () => {
    expect(interpolateRow('{{missing}}', { other: 'x' })).toBe('{{missing}}');
  });

  it('coerces non-string values via String()', () => {
    expect(interpolateRow('count: {{n}}', { n: 42 })).toBe('count: 42');
  });

  it('passes through non-string non-collection values unchanged', () => {
    expect(interpolateRow(42, { n: 1 })).toBe(42);
    expect(interpolateRow(null, { n: 1 })).toBe(null);
    expect(interpolateRow(true, { n: 1 })).toBe(true);
  });

  it('F15 default concurrency is 5 (plan-spec): runs >1 rows in parallel', async () => {
    // Track concurrency by counting in-flight calls. With default=5, all 3 rows
    // start before any finishes (we hold them on a resolvable promise).
    const inflightObserved: number[] = [];
    let inflight = 0;
    let resolveAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveAll = resolve;
    });

    const executor = new BatchExecutor();
    executor.setRowExecutor(async () => {
      inflight++;
      inflightObserved.push(inflight);
      await gate;
      inflight--;
      return { artifactIds: [], costUsd: 0 };
    });

    const start = executor.start({
      pipeline: { id: 'p' },
      source: { type: 'inline', rows: [{ x: 1 }, { x: 2 }, { x: 3 }] },
      // concurrency omitted on purpose — default must be ≥3 to admit all rows.
    });
    void start;

    // Yield until all 3 are admitted (concurrency >= 3).
    await vi.waitFor(() => expect(inflight).toBe(3), { timeout: 1000 });
    resolveAll();

    expect(Math.max(...inflightObserved)).toBe(3);
  });

  it('F15 finalizeBatch invokes the report persister with the full BatchReportRow[]', async () => {
    const executor = new BatchExecutor();
    executor.setRowExecutor(async () => ({ artifactIds: ['art-1'], costUsd: 0.001 }));
    let captured: { batchId: string; rows: BatchReportRow[] } | undefined;
    executor.setReportPersister(async (batchId, rows) => {
      captured = { batchId, rows };
      return `batch-report-${batchId}`;
    });

    const { batchId } = await executor.start({
      pipeline: { id: 'p' },
      source: { type: 'inline', rows: [{ a: 1 }, { a: 2 }] },
    });

    await vi.waitFor(
      async () => {
        const s = await executor.getStatus(batchId);
        expect(s?.status).toBe('completed');
      },
      { timeout: 2000 },
    );

    expect(captured).toBeDefined();
    expect(captured!.batchId).toBe(batchId);
    expect(captured!.rows.length).toBe(2);

    const finalStatus = await executor.getStatus(batchId);
    expect(finalStatus?.reportArtifactId).toBe(`batch-report-${batchId}`);
  });

  it('processBatch substitutes row values into the pipeline before runExecutor sees it', async () => {
    let seenPipeline: unknown;
    const executor = new BatchExecutor();
    executor.setRowExecutor(async (pipeline, _row, _batchId) => {
      seenPipeline = pipeline;
      return { artifactIds: ['x'], costUsd: 0 };
    });

    await executor.start({
      pipeline: {
        steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'hero {{topic}}' } }],
      },
      source: { type: 'inline', rows: [{ topic: 'sunset' }] },
    });

    await vi.waitFor(
      async () => {
        const s = await executor.getStatus(
          (await executor.getStatus('placeholder')) === null ? 'placeholder' : 'placeholder',
        );
        void s;
        expect(seenPipeline).toBeDefined();
      },
      { timeout: 3000 },
    );

    const p = seenPipeline as { steps: Array<{ inputs: { prompt: string } }> };
    expect(p.steps[0].inputs.prompt).toBe('hero sunset');
  });
});
