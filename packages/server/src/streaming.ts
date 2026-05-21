import type { PipelineEvent } from '@reaatech/media-pipeline-mcp-core';
import type { EventBus } from './config.js';
import type { MCPProgressValue } from './types.js';

export interface ProgressNotification {
  method: 'notifications/progress';
  params: {
    progressToken: string | number;
    progress: MCPProgressValue;
  };
}

export class StreamingBridge {
  private subscriptions = new Map<string, () => void>();
  private lastEmit = new Map<string, number>();
  private readonly throttleMs: number;

  constructor(
    private eventBus: EventBus<PipelineEvent>,
    throttleMs = 500,
  ) {
    this.throttleMs = throttleMs;
  }

  subscribe(
    runId: string,
    progressToken: string,
    onProgress?: (notification: ProgressNotification) => void,
  ): void {
    if (this.subscriptions.has(progressToken)) {
      return;
    }

    const disposer = this.eventBus.subscribe(`pipeline:${runId}:*`, (event: PipelineEvent) => {
      if (event.pipelineId !== runId) {
        return;
      }

      const stepId = event.stepId || 'unknown';
      const emitKey = `${runId}:${stepId}`;
      const now = Date.now();
      const last = this.lastEmit.get(emitKey) ?? 0;

      // Both event taxonomies are recognized: legacy colon-namespaced (what
      // PipelineExecutor still emits) AND the kebab-case spec events from plan §0.1
      // (what the new persistence layer emits). Coalescing applies to progress events;
      // status changes bypass the throttle so terminal/start signals are never dropped.
      const statusEvents = new Set([
        'step:start',
        'step:complete',
        'step:failed',
        'pipeline:start',
        'pipeline:complete',
        'pipeline:failed',
        // spec-compliant names
        'step-started',
        'step-completed',
        'step-failed',
        'step-cached',
        'step-gated',
        'run-started',
        'run-completed',
        'run-failed',
        'run-suspended',
        'run-resumed',
        'run-created',
      ]);

      const isStatusChange = statusEvents.has(event.type);

      if (!isStatusChange && now - last < this.throttleMs) {
        return;
      }

      this.lastEmit.set(emitKey, now);

      const notification = this.buildNotification(event, progressToken);
      if (notification && onProgress) {
        onProgress(notification);
      }
    });

    this.subscriptions.set(progressToken, disposer);
  }

  unsubscribe(progressToken: string): void {
    const disposer = this.subscriptions.get(progressToken);
    if (disposer) {
      disposer();
      this.subscriptions.delete(progressToken);
    }
  }

  unsubscribeAll(): void {
    for (const disposer of this.subscriptions.values()) {
      disposer();
    }
    this.subscriptions.clear();
    this.lastEmit.clear();
  }

  private buildNotification(
    event: PipelineEvent,
    progressToken: string,
  ): ProgressNotification | null {
    let value: MCPProgressValue;

    switch (event.type) {
      // S3: the PipelineExecutor dual-emits legacy + canonical names for the same
      // logical event. To avoid firing $/progress twice per event, we ignore the
      // legacy forms here and only build notifications from the canonical names.
      // External event sources that emit only legacy names will not receive
      // $/progress notifications — they should adopt the §0.1 canonical taxonomy.
      case 'pipeline:start':
      case 'pipeline:complete':
      case 'pipeline:failed':
      case 'pipeline:gated':
      case 'step:start':
      case 'step:complete':
      case 'step:failed':
      case 'step:gated':
      case 'step:retry':
        return null;
      case 'run-started':
        value = { kind: 'pipeline-progress', runId: event.pipelineId, message: 'Pipeline started' };
        break;
      case 'run-completed':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          message: 'Pipeline completed',
        };
        break;
      case 'run-failed':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          message: `Pipeline failed: ${event.data?.error ?? 'Unknown error'}`,
        };
        break;
      case 'run-suspended':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Pipeline suspended at ${event.stepId ?? 'unknown step'}`,
        };
        break;
      case 'step-started':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Step ${event.stepId} started`,
        };
        break;
      case 'step-completed':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Step ${event.stepId} completed`,
        };
        break;
      case 'step-failed':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Step ${event.stepId} failed`,
        };
        break;
      case 'step-gated':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Step ${event.stepId} gated`,
        };
        break;
      case 'step-progress': {
        // Spec §F6: progress events carry pct, etaMs, message, costUsdAccrued.
        const data = event.data ?? {};
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          currentStepPct: data.pct as number | undefined,
          etaMs: data.etaMs as number | undefined,
          message: data.message as string | undefined,
          costUsdAccrued: data.costUsdAccrued as number | undefined,
          budgetWarning: data.budgetWarning as boolean | undefined,
        };
        break;
      }
      case 'step-cached':
        value = {
          kind: 'pipeline-progress',
          runId: event.pipelineId,
          stepId: event.stepId,
          message: `Step ${event.stepId} served from cache`,
        };
        break;
      default:
        return null;
    }

    return {
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: value,
      },
    };
  }
}
