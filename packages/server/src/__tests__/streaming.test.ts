import type { PipelineEvent } from '@reaatech/media-pipeline-mcp-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../config.js';
import { StreamingBridge } from '../streaming.js';

describe('StreamingBridge', () => {
  let eventBus: EventBus<PipelineEvent>;
  let bridge: StreamingBridge;
  let subscribeHandler: ((event: PipelineEvent) => void) | null;
  let disposerFn: () => void;

  beforeEach(() => {
    disposerFn = vi.fn();
    subscribeHandler = null;

    eventBus = {
      subscribe: vi.fn((_pattern: string, handler: (event: PipelineEvent) => void) => {
        subscribeHandler = handler;
        return disposerFn;
      }),
      publish: vi.fn(),
    };

    bridge = new StreamingBridge(eventBus, 100);
  });

  afterEach(() => {
    bridge.unsubscribeAll();
  });

  it('should subscribe to events for a runId', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    expect(eventBus.subscribe).toHaveBeenCalledWith('pipeline:run-1:*', expect.any(Function));
  });

  // S3: the bridge ignores legacy colon-namespaced events. The executor dual-emits
  // both legacy and canonical names; the bridge fires notifications only on the
  // canonical (kebab-case) form to keep $/progress firing once per logical event.
  it('should emit progress notification for run-started', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-started',
      pipelineId: 'run-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'notifications/progress',
        params: expect.objectContaining({
          progressToken: 'token-1',
          progress: expect.objectContaining({
            kind: 'pipeline-progress',
            runId: 'run-1',
            message: 'Pipeline started',
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for run-completed', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-completed',
      pipelineId: 'run-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'notifications/progress',
        params: expect.objectContaining({
          progressToken: 'token-1',
          progress: expect.objectContaining({
            kind: 'pipeline-progress',
            runId: 'run-1',
            message: 'Pipeline completed',
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step events', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-completed',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'notifications/progress',
        params: expect.objectContaining({
          progressToken: 'token-1',
          progress: expect.objectContaining({
            kind: 'pipeline-progress',
            runId: 'run-1',
            stepId: 'step-1',
            message: 'Step step-1 completed',
          }),
        }),
      }),
    );
  });

  it('should reject events for different pipelineIds', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-started',
      pipelineId: 'run-2',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('should ignore legacy colon-namespaced events (S3 dedupe)', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    // These would have produced notifications pre-S3. Now the bridge ignores them
    // because the executor's canonical alias (e.g. run-started) carries the signal.
    const legacyTypes = [
      'pipeline:start',
      'pipeline:complete',
      'pipeline:failed',
      'step:start',
      'step:complete',
      'step:failed',
      'step:gated',
      'step:retry',
    ] as const;
    for (const type of legacyTypes) {
      subscribeHandler!({
        type,
        pipelineId: 'run-1',
        stepId: 'step-1',
        timestamp: new Date().toISOString(),
      });
    }

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('should fire status events without throttling', () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-started',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });
    subscribeHandler!({
      type: 'run-completed',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('should not throttle different step events', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-started',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });
    subscribeHandler!({
      type: 'run-completed',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('should unsubscribe by progressToken', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    bridge.unsubscribe('token-1');

    expect(disposerFn).toHaveBeenCalled();
  });

  it('should clean up all subscriptions with unsubscribeAll', () => {
    bridge.subscribe('run-1', 'token-1', vi.fn());
    bridge.subscribe('run-2', 'token-2', vi.fn());

    bridge.unsubscribeAll();

    expect(disposerFn).toHaveBeenCalled();
  });

  it('should skip duplicate subscriptions for same progressToken', () => {
    bridge.subscribe('run-1', 'token-1', vi.fn());
    bridge.subscribe('run-1', 'token-1', vi.fn());

    expect(eventBus.subscribe).toHaveBeenCalledTimes(1);
  });

  it('should emit progress notification for run-failed', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-failed',
      pipelineId: 'run-1',
      stepId: 'step-1',
      data: { error: 'something went wrong' },
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: expect.stringContaining('something went wrong'),
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for run-suspended', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-suspended',
      pipelineId: 'run-1',
      stepId: 'step-2',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: expect.stringContaining('suspended at step-2'),
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step-started', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-started',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: 'Step step-1 started',
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step-failed', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-failed',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: 'Step step-1 failed',
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step-gated', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-gated',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: 'Step step-1 gated',
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step-progress with data fields', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-progress',
      pipelineId: 'run-1',
      stepId: 'step-1',
      data: {
        pct: 50,
        etaMs: 30000,
        message: 'Processing...',
        costUsdAccrued: 0.05,
        budgetWarning: false,
      },
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            currentStepPct: 50,
            etaMs: 30000,
            message: 'Processing...',
            costUsdAccrued: 0.05,
            budgetWarning: false,
          }),
        }),
      }),
    );
  });

  it('should emit progress notification for step-cached', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-cached',
      pipelineId: 'run-1',
      stepId: 'step-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: 'Step step-1 served from cache',
          }),
        }),
      }),
    );
  });

  it('should return null for unknown event types', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      // Deliberately invalid event type to exercise the bridge's no-op path.
      type: 'unknown-type' as unknown as 'pipeline:start',
      pipelineId: 'run-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('should throttle non-status events (step-progress)', () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'step-progress',
      pipelineId: 'run-1',
      stepId: 'step-1',
      data: { pct: 10 },
      timestamp: new Date().toISOString(),
    });
    subscribeHandler!({
      type: 'step-progress',
      pipelineId: 'run-1',
      stepId: 'step-1',
      data: { pct: 20 },
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('should handle unsubscribe for non-existent token gracefully', () => {
    expect(() => bridge.unsubscribe('nonexistent')).not.toThrow();
  });

  it('run-failed should handle missing error data gracefully', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-failed',
      pipelineId: 'run-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: expect.stringContaining('Unknown error'),
          }),
        }),
      }),
    );
  });

  it('run-suspended should handle missing stepId gracefully', () => {
    const onProgress = vi.fn();
    bridge.subscribe('run-1', 'token-1', onProgress);

    subscribeHandler!({
      type: 'run-suspended',
      pipelineId: 'run-1',
      timestamp: new Date().toISOString(),
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          progress: expect.objectContaining({
            message: expect.stringContaining('unknown step'),
          }),
        }),
      }),
    );
  });
});
