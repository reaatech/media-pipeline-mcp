import type { PipelineDefinition } from '@reaatech/media-pipeline-mcp-core';

export type BatchSource =
  | {
      type: 'csv';
      uri?: string;
      columnMap?: Record<string, string>;
      delimiter?: ',' | ';' | '\t';
      hasHeader?: boolean;
      rows?: string;
    }
  | { type: 'jsonl'; uri?: string; rows?: string }
  | { type: 'inline'; rows: Record<string, unknown>[] };

/**
 * Plan §F15 mechanism: "each row's values substitute `{{column}}` placeholders" inside
 * the pipeline template. Walks any string/object/array recursively so substitutions
 * fire wherever {{column}} appears (typically `inputs.prompt`, but also `config`).
 *
 * Exported because the batch executor uses it AND consumers (server, tests) want to
 * preview the resolved pipeline without running it.
 */
export function interpolateRow<T>(pipeline: T, row: Record<string, unknown>): T {
  if (typeof pipeline === 'string') {
    return pipeline.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const k = key.trim();
      const v = row[k];
      if (v === undefined || v === null) return _match;
      return typeof v === 'string' ? v : String(v);
    }) as T;
  }
  if (Array.isArray(pipeline)) {
    return pipeline.map((item) => interpolateRow(item, row)) as T;
  }
  if (pipeline && typeof pipeline === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pipeline as Record<string, unknown>)) {
      out[k] = interpolateRow(v, row);
    }
    return out as T;
  }
  return pipeline;
}

export interface BatchRequest {
  pipeline: PipelineDefinition;
  source: BatchSource;
  concurrency?: number;
  onRowFailure?: 'continue' | 'stop' | 'retry-once';
  perRunBudget?: { maxUsd: number; onExceed: 'abort' | 'suspend' };
  artifactTags?: string[];
  idempotencyKey?: string;
}

export interface BatchStatus {
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';
  totalRows: number;
  completed: number;
  failed: number;
  inFlight: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  reportArtifactId?: string;
}

export type BatchRowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface BatchReportRow {
  rowIndex: number;
  runId?: string;
  status: BatchRowStatus;
  costUsd: number;
  artifactIds: string[];
  error?: { code: string; message: string };
  rowInput: Record<string, unknown>;
}

export interface BatchRetryRequest {
  batchId: string;
  onlyFailed?: boolean;
  onlyRowIndexes?: number[];
}

export interface RowExecutorResult {
  artifactIds: string[];
  costUsd: number;
  error?: { code: string; message: string };
}

/**
 * Plan §F15: "On terminal: assemble BatchReportRow[] as a JSONL artifact, store, return
 * reportArtifactId." The persister abstracts the storage backend so the BatchExecutor
 * package doesn't need a hard dep on @reaatech/media-pipeline-mcp-storage.
 */
export type BatchReportPersister = (batchId: string, rows: BatchReportRow[]) => Promise<string>;

export class BatchExecutor {
  private batches: Map<
    string,
    { request: BatchRequest; status: BatchStatus; rows: BatchReportRow[] }
  > = new Map();
  private runExecutor?: (
    pipeline: PipelineDefinition,
    row: Record<string, unknown>,
    batchId: string,
  ) => Promise<RowExecutorResult>;
  private reportPersister?: BatchReportPersister;

  setRowExecutor(
    fn: (
      pipeline: PipelineDefinition,
      row: Record<string, unknown>,
      batchId: string,
    ) => Promise<RowExecutorResult>,
  ): void {
    this.runExecutor = fn;
  }

  /**
   * Register a callback that takes the final BatchReportRow[] and stores it as a JSONL
   * artifact, returning the artifact id. When absent, the batch still finalizes but
   * `reportArtifactId` stays undefined.
   */
  setReportPersister(fn: BatchReportPersister): void {
    this.reportPersister = fn;
  }

  async start(request: BatchRequest): Promise<{ batchId: string; status: string }> {
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let rows: Record<string, unknown>[] = [];
    if (request.source.type === 'inline') {
      rows = request.source.rows;
    } else if (request.source.type === 'csv' && request.source.rows) {
      rows = this.parseCSV(request.source.rows, request.source.columnMap);
    } else if (request.source.type === 'jsonl' && request.source.rows) {
      rows = this.parseJSONL(request.source.rows);
    }

    const totalRows = rows.length;
    this.batches.set(batchId, {
      request,
      status: {
        batchId,
        status: 'pending',
        totalRows,
        completed: 0,
        failed: 0,
        inFlight: 0,
        costUsd: 0,
        startedAt: new Date().toISOString(),
      },
      rows: rows.map((row, i) => ({
        rowIndex: i,
        status: 'skipped' as const,
        costUsd: 0,
        artifactIds: [],
        rowInput: row,
      })),
    });

    void this.processBatch(batchId);

    return { batchId, status: 'pending' };
  }

  async getStatus(batchId: string): Promise<BatchStatus | null> {
    return this.batches.get(batchId)?.status ?? null;
  }

  async cancel(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    if (
      batch.status.status === 'completed' ||
      batch.status.status === 'cancelled' ||
      batch.status.status === 'failed'
    )
      return false;
    batch.status.status = 'cancelled';
    batch.status.completedAt = new Date().toISOString();
    for (const row of batch.rows) {
      if (row.status === 'skipped') {
        row.status = 'cancelled';
      }
    }
    return true;
  }

  async retry(request: BatchRetryRequest): Promise<{ batchId: string; status: string }> {
    const batch = this.batches.get(request.batchId);
    if (!batch) throw new Error(`Batch not found: ${request.batchId}`);

    const rowsToRetry = batch.rows.filter((r) => {
      if (request.onlyRowIndexes) return request.onlyRowIndexes.includes(r.rowIndex);
      if (request.onlyFailed) return r.status === 'failed';
      return r.status === 'failed' || r.status === 'cancelled';
    });

    if (rowsToRetry.length === 0) return { batchId: request.batchId, status: 'completed' };

    batch.status.status = 'running';
    for (const row of rowsToRetry) {
      row.status = 'skipped';
    }

    void this.processBatch(
      request.batchId,
      rowsToRetry.map((r) => r.rowIndex),
    );

    return { batchId: request.batchId, status: 'pending' };
  }

  private async processBatch(batchId: string, onlyIndexes?: number[]): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || !this.runExecutor) return;

    batch.status.status = 'running';

    const targets = onlyIndexes ?? batch.rows.map((r) => r.rowIndex);
    // Plan §F15: "Max in-flight rows. Default 5." Previously defaulted to 1,
    // which serialized batches and silently negated the documented throughput.
    const concurrency = batch.request.concurrency ?? 5;

    const pool = [...targets];
    const workers: Promise<void>[] = [];
    // CAPTURE the target worker count BEFORE the loop: workers consume `pool` via
    // pool.shift() during their synchronous prelude (before the first await), so
    // reading `pool.length` inside the loop condition would shrink it as we go and
    // cap the in-flight count below the configured concurrency. With pool=[0,1,2]
    // and concurrency=5 this used to spawn only 2 workers instead of 3.
    const workerCount = Math.min(concurrency, pool.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(this.workerLoop(batchId, pool));
    }
    await Promise.all(workers);

    this.finalizeBatch(batchId);
  }

  private async workerLoop(batchId: string, pool: number[]): Promise<void> {
    const batch = this.batches.get(batchId);
    if (!batch || !this.runExecutor) return;

    while (pool.length > 0) {
      if (batch.status.status === 'cancelled') break;

      const rowIndex = pool.shift();
      if (rowIndex === undefined) break;
      const rowState = batch.rows[rowIndex];
      if (!rowState || rowState.status !== 'skipped') continue;

      batch.status.inFlight++;
      rowState.status = 'running';

      // Per-run budget check
      if (batch.request.perRunBudget) {
        const budget = batch.request.perRunBudget;
        if (batch.status.costUsd >= budget.maxUsd) {
          batch.status.failed++;
          rowState.status = 'failed';
          rowState.error = {
            code: 'BUDGET_EXCEEDED',
            message: `Batch budget $${budget.maxUsd} exceeded`,
          };
          if (budget.onExceed === 'abort') {
            batch.status.status = 'failed';
            batch.status.completedAt = new Date().toISOString();
            break;
          }
          batch.status.inFlight--;
          continue;
        }
      }

      try {
        // Plan §F15: substitute `{{column}}` placeholders throughout the pipeline
        // template before handing it to the run executor. Previously this was a
        // no-op (the row was passed as-is to the executor as `interpolatedInput`),
        // which meant the example in the plan (`prompt: 'hero for: {{headline}}'`)
        // would have left the literal `{{headline}}` in the prompt.
        const interpolatedPipeline = interpolateRow(batch.request.pipeline, rowState.rowInput);
        const result = await this.runExecutor(interpolatedPipeline, rowState.rowInput, batchId);
        batch.status.completed++;
        rowState.status = 'completed';
        rowState.costUsd = result.costUsd;
        rowState.artifactIds = result.artifactIds;
        rowState.runId = `${batchId}-row-${rowIndex}`;
        batch.status.costUsd += result.costUsd;
      } catch (err) {
        batch.status.failed++;
        rowState.status = 'failed';
        const message = (err as Error).message;
        rowState.error = { code: 'ROW_ERROR', message };

        if (batch.request.onRowFailure === 'stop') {
          batch.status.status = 'failed';
          batch.status.completedAt = new Date().toISOString();
          break;
        }

        // Automatic retry-once mode
        if (batch.request.onRowFailure === 'retry-once') {
          pool.unshift(rowIndex);
        }
      } finally {
        batch.status.inFlight--;
      }
    }
  }

  private finalizeBatch(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) return;
    if (batch.status.status === 'cancelled') {
      void this.persistReport(batchId, batch.rows, batch.status);
      return;
    }

    if (batch.status.failed > 0 && batch.status.completed > 0) {
      batch.status.status = 'partial';
    } else if (batch.status.failed > 0) {
      batch.status.status = 'failed';
    } else {
      batch.status.status = 'completed';
    }
    batch.status.completedAt = new Date().toISOString();
    // Plan §F15: assemble the BatchReportRow[] as a JSONL artifact and set
    // status.reportArtifactId. Fire-and-forget so finalizeBatch stays sync.
    void this.persistReport(batchId, batch.rows, batch.status);
  }

  private async persistReport(
    batchId: string,
    rows: BatchReportRow[],
    status: BatchStatus,
  ): Promise<void> {
    if (!this.reportPersister) return;
    try {
      const reportArtifactId = await this.reportPersister(batchId, rows);
      status.reportArtifactId = reportArtifactId;
    } catch (err) {
      // Swallowing the failure here keeps a single-row reporting failure from
      // poisoning the batch status. Surfacing the error happens via the host
      // (which can wrap the persister to log/observe).
      void err;
    }
  }

  private parseCSV(csv: string, columnMap?: Record<string, string>): Record<string, unknown>[] {
    const lines = csv.trim().split('\n');
    if (lines.length === 0) return [];
    const headers = lines[0].split(',');
    const dataLines = lines.slice(1);

    return dataLines.map((line) => {
      const values = line.split(',');
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        const colName = columnMap?.[h] ?? h;
        row[colName] = values[i]?.trim() ?? '';
      });
      return row;
    });
  }

  private parseJSONL(jsonl: string): Record<string, unknown>[] {
    return jsonl
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
