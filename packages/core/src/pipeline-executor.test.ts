import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactNotFoundError, RunInProgressError, RunNotResumableError } from './errors.js';
import { MockProvider } from './mock-provider.js';
import { PipelineExecutor, createStepStateRecord } from './pipeline-executor.js';
import type {
  PipelineDefinition,
  PipelineRunRecord,
  PipelineStateStore,
  PipelineStep,
  ProviderOutput,
  QualityGate,
} from './types/index.js';

describe('PipelineExecutor', () => {
  let mockProvider: MockProvider;
  let executor: PipelineExecutor;
  let events: Array<{ type: string }>;
  let costs: Array<{ operation: string; cost_usd: number }>;

  beforeEach(() => {
    events = [];
    costs = [];
    mockProvider = new MockProvider({
      name: 'mock',
      operations: [
        'mock.generate',
        'mock.transform',
        'mock.extract',
        'image.generate',
        'image.upscale',
      ],
      delay: 10,
      failureRate: 0,
    });

    executor = new PipelineExecutor({
      providers: [mockProvider],
      defaultStepTimeoutMs: 5000,
      defaultPipelineTimeoutMs: 30000,
      onEvent: (event) => events.push(event),
      onCost: (record) => costs.push(record),
    });
  });

  it('should execute 3-step pipeline successfully', async () => {
    const definition: PipelineDefinition = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test prompt' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
        {
          id: 'step3',
          operation: 'mock.extract',
          inputs: { artifact_id: '{{step2.output}}' },
          config: {},
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('completed');
    expect(result.artifacts.size).toBe(3);
    expect(result.completedSteps).toEqual(['step1', 'step2', 'step3']);
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
  });

  it('should halt on quality gate failure with action=fail', async () => {
    const definition: PipelineDefinition = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }],
            },
            action: 'fail',
          },
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('step1');
  });

  it('should retry on quality gate failure with action=retry', async () => {
    // Create a provider that fails quality check first two times
    let attemptCount = 0;
    const failingProvider = new MockProvider({
      name: 'failing-mock',
      operations: ['mock.generate'],
      delay: 10,
    });

    // Override execute to control quality
    const originalExecute = failingProvider.execute.bind(failingProvider);
    failingProvider.execute = async (op, inputs, config) => {
      attemptCount++;
      const result = await originalExecute(op, inputs, config);
      // First two attempts have low quality, third has high quality
      if (attemptCount < 3) {
        result.artifact.metadata = { ...result.artifact.metadata, quality: 0.5 };
      } else {
        result.artifact.metadata = { ...result.artifact.metadata, quality: 0.9 };
      }
      return result;
    };

    executor = new PipelineExecutor({
      providers: [failingProvider],
      onEvent: (event) => events.push(event),
    });

    const definition: PipelineDefinition = {
      id: 'retry-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.quality', operator: '>=', value: 0.8 }],
            },
            action: 'retry',
            maxRetries: 3,
          },
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('completed');
    expect(attemptCount).toBe(3);
  });

  it('should gate pipeline when maxRetries exceeded', async () => {
    const definition: PipelineDefinition = {
      id: 'gated-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.quality', operator: '>=', value: 0.99 }],
            },
            action: 'retry',
            maxRetries: 2,
          },
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('gated');
    expect(result.gatedStep).toBe('step1');
  });

  it('should pass artifact between steps', async () => {
    const definition: PipelineDefinition = {
      id: 'artifact-pass-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'generate something' },
          config: { dimensions: '1024x1024' },
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('completed');
    expect(result.artifacts.size).toBe(2);

    // Verify step2 received the artifact from step1
    const step1Artifact = Array.from(result.artifacts.values()).find(
      (a) => a.sourceStep === 'step1',
    );
    expect(step1Artifact).toBeDefined();
  });

  it('should fail when referencing non-existent step', async () => {
    const definition: PipelineDefinition = {
      id: 'invalid-ref-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { artifact_id: '{{nonexistent.output}}' },
          config: {},
        },
      ],
    };

    const result = await executor.execute(definition);

    expect(result.status).toBe('failed');
  });

  it('should emit events during execution', async () => {
    const definition: PipelineDefinition = {
      id: 'events-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
      ],
    };

    await executor.execute(definition);

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('pipeline:start');
    expect(eventTypes).toContain('step:start');
    expect(eventTypes).toContain('step:complete');
    expect(eventTypes).toContain('pipeline:complete');
  });

  it('should record costs during execution', async () => {
    const definition: PipelineDefinition = {
      id: 'cost-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
      ],
    };

    await executor.execute(definition);

    expect(costs.length).toBe(2);
    expect(costs[0].operation).toBe('mock.generate');
    expect(costs[1].operation).toBe('mock.transform');
    expect(costs.every((c) => c.cost_usd > 0)).toBe(true);
  });

  it('should resume gated pipeline with retry action', async () => {
    // Create a provider that always returns low quality
    const retryProvider = new MockProvider({
      name: 'retry-mock',
      operations: ['mock.generate', 'mock.transform', 'mock.extract'],
      delay: 10,
    });

    // Override execute to always return low quality
    const originalExecute = retryProvider.execute.bind(retryProvider);
    retryProvider.execute = async (op, inputs, config) => {
      const result = await originalExecute(op, inputs, config);
      result.artifact.metadata = { ...result.artifact.metadata, quality: 0.5 };
      return result;
    };

    const retryExecutor = new PipelineExecutor({
      providers: [retryProvider],
      defaultStepTimeoutMs: 5000,
      onEvent: (event) => events.push(event),
    });

    // First, create a pipeline that gets gated (maxRetries exceeded)
    const definition: PipelineDefinition = {
      id: 'resume-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.quality', operator: '>=', value: 0.8 }],
            },
            action: 'retry',
            maxRetries: 1,
          },
        },
      ],
    };

    let pipeline = await retryExecutor.execute(definition);
    expect(pipeline.status).toBe('gated');

    // Now override the provider to return high quality for the resume
    retryProvider.execute = async (op, inputs, config) => {
      const result = await originalExecute(op, inputs, config);
      result.artifact.metadata = { ...result.artifact.metadata, quality: 0.99 };
      return result;
    };

    // Resume with retry
    pipeline = await retryExecutor.resume(pipeline, 'retry');
    expect(pipeline.status).toBe('completed');
  });

  it('should resume gated pipeline with skip action', async () => {
    const definition: PipelineDefinition = {
      id: 'skip-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.quality', operator: '>=', value: 0.99 }],
            },
            action: 'retry',
            maxRetries: 1,
          },
        },
        {
          id: 'step3',
          operation: 'mock.extract',
          inputs: { artifact_id: '{{step2.output}}' },
          config: {},
        },
      ],
    };

    let pipeline = await executor.execute(definition);
    expect(pipeline.status).toBe('gated');

    // Resume with skip
    pipeline = await executor.resume(pipeline, 'skip');
    expect(pipeline.status).toBe('completed');
    expect(pipeline.completedSteps).toContain('step3');
  });

  it('should abort gated pipeline', async () => {
    const definition: PipelineDefinition = {
      id: 'abort-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: {
              checks: [{ field: 'metadata.quality', operator: '>=', value: 0.99 }],
            },
            action: 'retry',
            maxRetries: 1,
          },
        },
      ],
    };

    let pipeline = await executor.execute(definition);
    expect(pipeline.status).toBe('gated');

    pipeline = await executor.resume(pipeline, 'abort');
    expect(pipeline.status).toBe('failed');
  });

  it('should resume failed pipeline with retry action', async () => {
    let shouldFail = true;
    const flakyProvider = new MockProvider({
      name: 'flaky-mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 10,
    });

    const originalExecute = flakyProvider.execute.bind(flakyProvider);
    flakyProvider.execute = async (op, inputs, config) => {
      if (op === 'mock.transform' && shouldFail) {
        throw new Error('transient failure');
      }
      return originalExecute(op, inputs, config);
    };

    const retryExecutor = new PipelineExecutor({
      providers: [flakyProvider],
    });

    const definition: PipelineDefinition = {
      id: 'failed-retry-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
      ],
    };

    let pipeline = await retryExecutor.execute(definition);
    expect(pipeline.status).toBe('failed');
    expect(pipeline.failedStep).toBe('step2');

    shouldFail = false;
    pipeline = await retryExecutor.resume(pipeline, 'retry');

    expect(pipeline.status).toBe('completed');
    expect(pipeline.completedSteps).toEqual(['step1', 'step2']);
  });

  it('should resume failed pipeline with skip action', async () => {
    const failingProvider = new MockProvider({
      name: 'skip-failed-mock',
      operations: ['mock.generate', 'mock.transform', 'mock.extract'],
      delay: 10,
    });

    const originalExecute = failingProvider.execute.bind(failingProvider);
    failingProvider.execute = async (op, inputs, config) => {
      if (op === 'mock.transform') {
        throw new Error('non-retryable failure');
      }
      return originalExecute(op, inputs, config);
    };

    const skipExecutor = new PipelineExecutor({
      providers: [failingProvider],
    });

    const definition: PipelineDefinition = {
      id: 'failed-skip-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
        {
          id: 'step3',
          operation: 'mock.extract',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {},
        },
      ],
    };

    let pipeline = await skipExecutor.execute(definition);
    expect(pipeline.status).toBe('failed');
    expect(pipeline.failedStep).toBe('step2');

    pipeline = await skipExecutor.resume(pipeline, 'skip');

    expect(pipeline.status).toBe('completed');
    expect(pipeline.completedSteps).toEqual(['step1', 'step2', 'step3']);
  });
});

describe('PipelineExecutor — F3 Resume with persistence', () => {
  let mockProvider: MockProvider;
  let events: Array<{ type: string }>;
  let persistence: PipelineStateStore & {
    runs: Map<string, PipelineRunRecord>;
    locks: Map<string, boolean>;
  };

  beforeEach(() => {
    events = [];
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 5,
    });
    persistence = {
      runs: new Map<string, PipelineRunRecord>(),
      locks: new Map<string, boolean>(),
      async createRun(run: PipelineRunRecord) {
        this.runs.set(run.runId, { ...run });
        return run.runId;
      },
      async getRun(runId: string) {
        return this.runs.get(runId);
      },
      async updateRun(runId: string, patch: Partial<PipelineRunRecord>) {
        const existing = this.runs.get(runId);
        if (existing) {
          Object.assign(existing, patch);
        }
      },
      async acquireLock(runId: string) {
        if (this.locks.get(runId)) return false;
        this.locks.set(runId, true);
        return true;
      },
      async releaseLock(runId: string) {
        this.locks.delete(runId);
      },
      async listRuns() {
        return [];
      },
    };
  });

  it('should throw RunInProgressError if lock fails', async () => {
    const executor = new PipelineExecutor({
      providers: [mockProvider],
      persistence,
      onEvent: (e) => events.push(e),
    });

    // Acquire lock first
    await persistence.acquireLock('run-1');

    // Create a minimal run
    await persistence.createRun({
      runId: 'run-1',
      pipelineId: 'test',
      status: 'gated',
      definition: { id: 'test', steps: [] },
      stepStates: [],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });

    await expect(executor.resume('run-1')).rejects.toThrow(RunInProgressError);
  });

  it('should throw RunNotResumableError if run is completed', async () => {
    const executor = new PipelineExecutor({
      providers: [mockProvider],
      persistence,
      onEvent: (e) => events.push(e),
    });

    await persistence.createRun({
      runId: 'run-2',
      pipelineId: 'test',
      status: 'completed',
      definition: { id: 'test', steps: [] },
      stepStates: [],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });

    await expect(executor.resume('run-2')).rejects.toThrow(RunNotResumableError);
  });

  it('should resume from a specific step', async () => {
    const executor = new PipelineExecutor({
      providers: [mockProvider],
      persistence,
      onEvent: (e) => events.push(e),
    });

    const definition: PipelineDefinition = {
      id: 'resume-test',
      steps: [
        { id: 's1', operation: 'mock.generate', inputs: { prompt: 'first' }, config: {} },
        {
          id: 's2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{s1.output}}' },
          config: {},
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');

    // Create a persisted gated run manually
    await persistence.createRun({
      runId: 'run-3',
      pipelineId: 'test',
      status: 'gated',
      definition: {
        id: 'test',
        steps: [
          { id: 's1', operation: 'mock.generate', inputs: { prompt: 'first' }, config: {} },
          {
            id: 's2',
            operation: 'mock.transform',
            inputs: { artifact_id: '{{s1.output}}' },
            config: {},
          },
        ],
      },
      stepStates: [
        { stepId: 's1', status: 'completed', attempts: 1 },
        { stepId: 's2', status: 'gated', attempts: 2 },
      ],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });

    const resumed = await executor.resume('run-3', 's2');
    expect(resumed.status).toBe('completed');
  });
});

describe('PipelineExecutor — F4 Budget preflight', () => {
  let mockProvider: MockProvider;
  let executor: PipelineExecutor;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate'],
      delay: 5,
    });
  });

  it('should abort pipeline when budget exceeded', async () => {
    executor = new PipelineExecutor({
      providers: [mockProvider],
    });

    const definition: PipelineDefinition = {
      id: 'budget-test',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    definition.budget = { maxUsd: 0.0005, onExceed: 'abort' };

    const result = await executor.execute(definition);

    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('s1');
  });

  it('should suspend pipeline when budget exceeded with suspend action', async () => {
    executor = new PipelineExecutor({
      providers: [mockProvider],
    });

    const definition: PipelineDefinition = {
      id: 'budget-suspend',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    definition.budget = { maxUsd: 0.0005, onExceed: 'suspend' };

    const result = await executor.execute(definition);

    expect(result.status).toBe('gated');
    expect(result.gatedStep).toBe('s1');
  });

  it('emits a step-progress event with budgetWarning when warnAtPct is crossed', async () => {
    // Per plan §F4: "at warnAtPct × maxUsd, emit a step-progress event carrying
    // budgetWarning: true." Use baseCost=0.4 with maxUsd=1.0 + warnAtPct=0.8 so
    // two steps cross the 0.8 threshold (cumulative cost 0.8 ≥ threshold).
    const costlyProvider = new MockProvider({ baseCost: 0.4 });
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    executor = new PipelineExecutor({
      providers: [costlyProvider],
      onEvent: (e) =>
        events.push({ type: e.type, data: e.data as Record<string, unknown> | undefined }),
    });

    const definition: PipelineDefinition = {
      id: 'warn-test',
      steps: [
        { id: 's1', operation: 'mock.generate', inputs: { prompt: 'one' }, config: {} },
        { id: 's2', operation: 'mock.generate', inputs: { prompt: 'two' }, config: {} },
        { id: 's3', operation: 'mock.generate', inputs: { prompt: 'three' }, config: {} },
      ],
    };
    definition.budget = { maxUsd: 1.0, onExceed: 'abort', warnAtPct: 0.8 };

    await executor.execute(definition);

    const warning = events.find(
      (e) =>
        e.type === 'step-progress' && (e.data as Record<string, unknown>)?.budgetWarning === true,
    );
    expect(warning).toBeDefined();
    expect((warning!.data as Record<string, unknown>).costUsdAccrued).toBeGreaterThanOrEqual(0.8);
    // Fires exactly once across the run (no repeated warnings after the threshold).
    const warningCount = events.filter(
      (e) =>
        e.type === 'step-progress' && (e.data as Record<string, unknown>)?.budgetWarning === true,
    ).length;
    expect(warningCount).toBe(1);
  });

  it('does not emit budgetWarning when warnAtPct is not crossed', async () => {
    const cheapProvider = new MockProvider({ baseCost: 0.01 });
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    executor = new PipelineExecutor({
      providers: [cheapProvider],
      onEvent: (e) =>
        events.push({ type: e.type, data: e.data as Record<string, unknown> | undefined }),
    });

    const definition: PipelineDefinition = {
      id: 'no-warn-test',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    definition.budget = { maxUsd: 10.0, onExceed: 'abort', warnAtPct: 0.8 };

    await executor.execute(definition);

    const warning = events.find((e) => (e.data as Record<string, unknown>)?.budgetWarning === true);
    expect(warning).toBeUndefined();
  });
});

describe('PipelineExecutor — F5 estimate', () => {
  let mockProvider: MockProvider;
  let executor: PipelineExecutor;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 5,
    });
    executor = new PipelineExecutor({
      providers: [mockProvider],
    });
  });

  it('should estimate a pipeline', async () => {
    const definition: PipelineDefinition = {
      id: 'estimate-test',
      steps: [
        { id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} },
        {
          id: 's2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{s1.output}}' },
          config: {},
        },
      ],
    };

    const estimate = await executor.estimate(definition);

    expect(estimate.perStep).toHaveLength(2);
    expect(estimate.totalUsdLow).toBeGreaterThan(0);
    expect(estimate.totalUsdHigh).toBeGreaterThanOrEqual(estimate.totalUsdLow);

    // Step 2 depends on step 1 output
    expect(estimate.warnings.some((w) => w.code === 'depends-on-prior-step')).toBe(true);
  });

  it('should warn when no provider available', async () => {
    const definition: PipelineDefinition = {
      id: 'no-provider',
      steps: [{ id: 's1', operation: 'unknown.op', inputs: {}, config: {} }],
    };

    const estimate = await executor.estimate(definition);

    expect(estimate.warnings.some((w) => w.code === 'no-estimator')).toBe(true);
    expect(estimate.perStep[0].estimable).toBe(false);
  });

  it('should warn on router spread in estimate', async () => {
    const definition: PipelineDefinition = {
      id: 'router-spread',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    (definition.steps[0] as PipelineStep).route = {
      candidates: [
        { provider: 'p1', model: 'm' },
        { provider: 'p2', model: 'm' },
        { provider: 'p3', model: 'm' },
      ],
      strategy: 'first-success',
    };

    const estimate = await executor.estimate(definition);

    expect(estimate.warnings.some((w) => w.code === 'router-spread')).toBe(true);
  });
});

describe('PipelineExecutor — Phase 2 features', () => {
  let mockProvider: MockProvider;
  let executor: PipelineExecutor;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 5,
    });
  });

  it('should use prepareInputs callback', async () => {
    const prepareInputs = vi.fn(async (_op: string, inputs: Record<string, unknown>) => ({
      ...inputs,
      enhanced: true,
    }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      prepareInputs,
    });

    const definition: PipelineDefinition = {
      id: 'prepare-inputs',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(prepareInputs).toHaveBeenCalledOnce();
  });

  it('should use persistArtifact callback', async () => {
    const persistArtifact = vi.fn(async () => ({ uri: 'custom://artifact-uri' }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      persistArtifact,
    });

    const definition: PipelineDefinition = {
      id: 'persist-artifact',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(persistArtifact).toHaveBeenCalledOnce();
    const artifact = Array.from(result.artifacts.values())[0];
    expect(artifact.uri).toBe('custom://artifact-uri');
  });

  it('should use route step function', async () => {
    let capturedGetProvider: ((name: string) => unknown) | undefined;
    const routeStepFn = vi.fn(async (params) => {
      capturedGetProvider = params.getProviderByName;
      return {
        artifact: {
          id: 'route-artifact',
          type: 'image' as const,
          uri: 'route://artifact',
          mimeType: 'image/png',
          metadata: {},
          sourceStep: 's1',
          createdAt: new Date().toISOString(),
        },
        providerName: 'mock',
      };
    });
    executor = new PipelineExecutor({
      providers: [mockProvider],
      routeStepFn,
    });

    const definition: PipelineDefinition = {
      id: 'route-step',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    definition.steps[0].route = {
      candidates: [{ provider: 'p1', model: 'm1' }],
      strategy: 'cheapest-acceptable',
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(routeStepFn).toHaveBeenCalledOnce();
    expect(result.artifacts.size).toBe(1);

    // Verify getProviderByName works for both direct map and iterating values
    const found = capturedGetProvider!('mock');
    expect(found).toBeDefined();
    const notFound = capturedGetProvider!('nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('should use route step function returning null and fall through', async () => {
    const routeStepFn = vi.fn(async () => null);
    executor = new PipelineExecutor({
      providers: [mockProvider],
      routeStepFn,
    });

    const definition: PipelineDefinition = {
      id: 'route-fallthrough',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    definition.steps[0].route = {
      candidates: [{ provider: 'p1', model: 'm1' }],
      strategy: 'first-success',
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(routeStepFn).toHaveBeenCalledOnce();
  });

  it('should use variants step function', async () => {
    const variantsStepFn = vi.fn(async () => ({
      artifact: {
        id: 'variants-artifact',
        type: 'image' as const,
        uri: 'variants://artifact',
        mimeType: 'image/png',
        metadata: {},
        sourceStep: 's1',
        createdAt: new Date().toISOString(),
      },
    }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      variantsStepFn,
    });

    const definition: PipelineDefinition = {
      id: 'variants-step',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    definition.steps[0].variants = {
      n: 3,
      judge: { type: 'llm-judge', criteria: 'quality' },
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(variantsStepFn).toHaveBeenCalledOnce();
  });

  it('should use variants step function returning null and fall through', async () => {
    const variantsStepFn = vi.fn(async () => null);
    executor = new PipelineExecutor({
      providers: [mockProvider],
      variantsStepFn,
    });

    const definition: PipelineDefinition = {
      id: 'variants-fallthrough',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    definition.steps[0].variants = { n: 3, judge: { type: 'llm-judge', criteria: 'quality' } };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });

  it('should use ratios step function', async () => {
    const ratiosStepFn = vi.fn(async () => ({
      artifact: {
        id: 'ratios-artifact',
        type: 'image' as const,
        uri: 'ratios://artifact',
        mimeType: 'image/png',
        metadata: {},
        sourceStep: 's1',
        createdAt: new Date().toISOString(),
      },
    }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      ratiosStepFn,
    });

    const definition: PipelineDefinition = {
      id: 'ratios-step',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    (definition.steps[0] as unknown as { ratios: string[] }).ratios = ['1:1', '16:9', '4:5'];

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(ratiosStepFn).toHaveBeenCalledOnce();
  });

  it('should use context resolution', async () => {
    const contextResolveFn = vi.fn(() => ({ prompt: 'resolved prompt' }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      context: { voices: { narrator: { provider: 'elevenlabs', voiceId: 'v1' } } },
      contextResolveFn,
    });

    const definition: PipelineDefinition = {
      id: 'context-resolve',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };
    (definition.steps[0] as unknown as { contextRefs: { voice: string } }).contextRefs = {
      voice: 'narrator',
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(contextResolveFn).toHaveBeenCalledOnce();
  });

  it('should use ledger for cost tracking', async () => {
    const charge = vi.fn(async () => {});
    const ledger = {
      charge,
      getRunCost: vi.fn(async () => 0),
      getTotalCost: vi.fn(async () => 0),
    };
    executor = new PipelineExecutor({
      providers: [mockProvider],
      ledger,
      onCost: () => {},
    });

    const definition: PipelineDefinition = {
      id: 'ledger-test',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(charge).toHaveBeenCalledOnce();
  });

  it('should sign provenance when configured', async () => {
    const signProvenance = vi.fn(async () => ({
      signedArtifactId: 'signed-123',
      manifestUri: 'c2pa://manifest',
    }));
    executor = new PipelineExecutor({
      providers: [mockProvider],
      signProvenance,
    });

    const definition: PipelineDefinition = {
      id: 'provenance-test',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'hello' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(signProvenance).toHaveBeenCalledOnce();
  });

  it('should use warn quality gate action', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    executor = new PipelineExecutor({
      providers: [mockProvider],
    });

    const definition: PipelineDefinition = {
      id: 'warn-gate',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }] },
            action: 'warn',
          },
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});

describe('PipelineExecutor — F3 Resume persistence edge cases', () => {
  let mockProvider: MockProvider;
  let persistence: PipelineStateStore & {
    runs: Map<string, PipelineRunRecord>;
    locks: Map<string, boolean>;
  };

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 5,
    });
    persistence = {
      runs: new Map<string, PipelineRunRecord>(),
      locks: new Map<string, boolean>(),
      async createRun(run: PipelineRunRecord) {
        this.runs.set(run.runId, { ...run });
        return run.runId;
      },
      async getRun(runId: string) {
        return this.runs.get(runId);
      },
      async updateRun(runId: string, patch: Partial<PipelineRunRecord>) {
        const existing = this.runs.get(runId);
        if (existing) Object.assign(existing, patch);
      },
      async acquireLock(runId: string) {
        if (this.locks.get(runId)) return false;
        this.locks.set(runId, true);
        return true;
      },
      async releaseLock(runId: string) {
        this.locks.delete(runId);
      },
      async listRuns() {
        return [];
      },
    };
  });

  it('should throw RunNotResumableError if run is cancelled', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    await persistence.createRun({
      runId: 'cancelled-run',
      pipelineId: 'test',
      status: 'cancelled',
      definition: { id: 'test', steps: [] },
      stepStates: [],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });
    await expect(executor.resume('cancelled-run')).rejects.toThrow(RunNotResumableError);
  });

  it('should throw RunNotResumableError if run is non-resumable', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    await persistence.createRun({
      runId: 'non-resume',
      pipelineId: 'test',
      status: 'gated',
      resumable: false,
      definition: { id: 'test', steps: [] },
      stepStates: [],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });
    await expect(executor.resume('non-resume')).rejects.toThrow(RunNotResumableError);
  });

  it('should resume and complete when all steps are already done', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    const steps: PipelineDefinition['steps'] = [
      { id: 's1', operation: 'mock.generate', inputs: { prompt: 'a' }, config: {} },
      {
        id: 's2',
        operation: 'mock.transform',
        inputs: { artifact_id: '{{s1.output}}' },
        config: {},
      },
    ];
    await persistence.createRun({
      runId: 'all-done',
      pipelineId: 'test',
      status: 'running',
      definition: { id: 'test', steps },
      stepStates: [
        { stepId: 's1', status: 'completed', attempts: 1, artifactId: 'a1' },
        { stepId: 's2', status: 'completed', attempts: 1, artifactId: 'a2' },
      ],
      artifacts: { s1: 'a1', s2: 'a2' },
      totalCostUsd: 0.01,
      startedAt: new Date().toISOString(),
    });

    const resumed = await executor.resume('all-done');
    expect(resumed.status).toBe('completed');
  });

  it('should resume with budget abort in persistence resume', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    const steps = [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'a' }, config: {} }];
    await persistence.createRun({
      runId: 'budget-abort',
      pipelineId: 'test',
      status: 'gated',
      definition: { id: 'test', steps, budget: { maxUsd: 0.0001, onExceed: 'abort' } },
      stepStates: [{ stepId: 's1', status: 'gated', attempts: 1 }],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });

    await expect(executor.resume('budget-abort')).rejects.toThrow();
  });

  it('should resume with budget suspend in persistence resume', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    const steps = [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'a' }, config: {} }];
    await persistence.createRun({
      runId: 'budget-suspend',
      pipelineId: 'test',
      status: 'gated',
      definition: { id: 'test', steps, budget: { maxUsd: 0.0001, onExceed: 'suspend' } },
      stepStates: [{ stepId: 's1', status: 'gated', attempts: 1 }],
      artifacts: {},
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
    });

    const resumed = await executor.resume('budget-suspend');
    expect(resumed.status).toBe('gated');
  });

  it('should skip already completed steps during resume', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    const steps: PipelineDefinition['steps'] = [
      { id: 's1', operation: 'mock.generate', inputs: { prompt: 'a' }, config: {} },
      {
        id: 's2',
        operation: 'mock.transform',
        inputs: { artifact_id: '{{s1.output}}' },
        config: {},
      },
      { id: 's3', operation: 'mock.generate', inputs: { prompt: 'c' }, config: {} },
    ];
    await persistence.createRun({
      runId: 'skip-completed',
      pipelineId: 'test',
      status: 'gated',
      definition: { id: 'test', steps },
      stepStates: [
        { stepId: 's1', status: 'completed', attempts: 1, artifactId: 'a1' },
        { stepId: 's2', status: 'cached', attempts: 0, artifactId: 'a2' },
        { stepId: 's3', status: 'gated', attempts: 2 },
      ],
      artifacts: { s1: 'a1', s2: 'a2' },
      totalCostUsd: 0.01,
      startedAt: new Date().toISOString(),
    });

    const resumed = await executor.resume('skip-completed');
    expect(resumed.status).toBe('completed');
    expect(resumed.completedSteps).toContain('s1');
    expect(resumed.completedSteps).toContain('s2');
    expect(resumed.completedSteps).toContain('s3');
  });

  it('should throw error when run not found', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider], persistence });
    await expect(executor.resume('nonexistent-run')).rejects.toThrow('Run not found');
  });

  it('should error when persistence missing for resume by runId', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    await expect(executor.resume('run-1')).rejects.toThrow('Persistence store required');
  });
});

describe('PipelineExecutor — Legacy resume edge cases', () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate', 'mock.transform'],
      delay: 5,
    });
  });

  it('should throw error when resuming pipeline with invalid status', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const definition: PipelineDefinition = {
      id: 'invalid-status',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    const pipeline = await executor.execute(definition);
    expect(pipeline.status).toBe('completed');

    await expect(executor.resume(pipeline, 'retry')).rejects.toThrow(
      'Cannot resume pipeline with status: completed',
    );
  });

  it('should throw error when gated step not found', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const pipeline = {
      id: 'missing-step',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
      status: 'gated' as const,
      artifacts: new Map(),
      completedSteps: [],
      startedAt: new Date().toISOString(),
      gatedStep: 'nonexistent',
    };

    await expect(executor.resume(pipeline, 'skip')).rejects.toThrow('step not found');
  });

  it('should resume legacy retry with existing artifact deleted from registry', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const definition: PipelineDefinition = {
      id: 'legacy-retry-delete',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const pipeline = await executor.execute(definition);
    expect(pipeline.status).toBe('completed');

    const registry = executor.getRegistry();
    const registrySizeBefore = registry.list().length;

    expect(registrySizeBefore).toBeGreaterThan(0);
  });

  it('should abort on gated pipeline with abort action', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const definition: PipelineDefinition = {
      id: 'legacy-abort',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.quality', operator: '>=', value: 0.99 }] },
            action: 'retry',
            maxRetries: 1,
          },
        },
      ],
    };

    let pipeline = await executor.execute(definition);
    expect(pipeline.status).toBe('gated');

    pipeline = await executor.resume(pipeline, 'abort');
    expect(pipeline.status).toBe('failed');
  });
});

describe('PipelineExecutor — executeStep error handling', () => {
  it('should handle errors in executeStepOnce with retry', async () => {
    let attempts = 0;
    const flakyProvider = new MockProvider({
      name: 'flaky',
      operations: ['mock.generate'],
      delay: 5,
    });
    const origExecute = flakyProvider.execute.bind(flakyProvider);
    flakyProvider.execute = async (op, inputs, config) => {
      attempts++;
      if (attempts < 3) throw new Error('transient error');
      return origExecute(op, inputs, config);
    };

    const executor = new PipelineExecutor({ providers: [flakyProvider] });
    const definition: PipelineDefinition = {
      id: 'error-retry',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.quality', operator: '>=', value: 0 }] },
            action: 'retry',
            maxRetries: 3,
          },
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('should handle provider returning null result', async () => {
    const nullProvider = new MockProvider({
      name: 'null-provider',
      operations: ['mock.generate'],
      delay: 5,
    });
    nullProvider.execute = async () => null as unknown as ProviderOutput;

    const executor = new PipelineExecutor({ providers: [nullProvider] });
    const definition: PipelineDefinition = {
      id: 'null-result',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('failed');
  });

  it('should fail when no provider found for operation', async () => {
    const executor = new PipelineExecutor({ providers: [] });
    const definition: PipelineDefinition = {
      id: 'no-op-provider',
      steps: [{ id: 's1', operation: 'nonexistent.op', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('failed');
  });

  it('should handle pipeline timeout', async () => {
    const slowProvider = new MockProvider({
      name: 'slow',
      operations: ['mock.generate'],
      delay: 5000,
    });
    const executor = new PipelineExecutor({
      providers: [slowProvider],
      defaultPipelineTimeoutMs: 100,
      defaultStepTimeoutMs: 10000,
    });

    const definition: PipelineDefinition = {
      id: 'timeout-pipeline',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('failed');
  }, 10000);
});

describe('PipelineExecutor — Additional gates array', () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate'],
      delay: 5,
      alwaysPass: true,
    });
  });

  it('should fail pipeline when additional gates array fails', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const definition: PipelineDefinition = {
      id: 'additional-gates',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [
            {
              type: 'threshold' as const,
              config: { checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }] },
              action: 'fail' as const,
            },
          ],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('gated');
  });

  it('should pass pipeline when additional gates pass', async () => {
    const executor = new PipelineExecutor({ providers: [mockProvider] });
    const definition: PipelineDefinition = {
      id: 'additional-gates-pass',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [
            {
              type: 'threshold' as const,
              config: { checks: [{ field: 'metadata.width', operator: '>=', value: 100 }] },
              action: 'fail' as const,
            },
          ],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });
});

describe('PipelineExecutor — Safety and loudness gates', () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider({
      name: 'mock',
      operations: ['mock.generate'],
      delay: 5,
      alwaysPass: true,
    });
  });

  it('should fail on safety gate rejection', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: false,
      action: 'fail' as const,
      resultArtifact: undefined,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'safety-fail',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'safety', config: {}, action: 'fail' }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('failed');
  });

  it('should gate on safety gate non-fail rejection', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: false,
      action: 'warn' as const,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'safety-gate',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'safety', config: {}, action: 'fail' }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('gated');
  });

  it('should pass safety gate', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: true,
      action: 'warn' as const,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'safety-pass',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'safety', config: {}, action: 'fail' }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });

  it('should gate on loudness gate failure', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: false,
      action: 'warn' as const,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'loudness-gate',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'loudness', config: {} }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('gated');
  });

  it('should fail on loudness gate rejection', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: false,
      action: 'fail' as const,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'loudness-fail',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'loudness', config: {} }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('failed');
  });

  it('should replace artifact on loudness gate with resultArtifact', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: true,
      action: 'warn' as const,
      resultArtifact: {
        id: 'normalized-artifact',
        type: 'audio' as const,
        uri: 'normalized://audio',
        mimeType: 'audio/wav',
        metadata: { normalized: true },
        sourceStep: 's1',
        createdAt: new Date().toISOString(),
      },
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'loudness-normalize',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'loudness', config: { target: -14 } }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });

  it('should pass loudness gate', async () => {
    const gateEvalFn = vi.fn(async () => ({
      passed: true,
      action: 'warn' as const,
    }));
    const executor = new PipelineExecutor({ providers: [mockProvider], gateEvalFn });

    const definition: PipelineDefinition = {
      id: 'loudness-pass',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          gates: [{ type: 'loudness', config: { target: -14 } }] as unknown as QualityGate[],
        },
      ],
    };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });
});

describe('PipelineExecutor — Cache integration', () => {
  it('should use provider executeWithCache when cache config present', async () => {
    const cacheProvider = new MockProvider({
      name: 'cached-mock',
      operations: ['mock.generate'],
      delay: 5,
    });
    const executeWithCache = vi.fn(async (_params: unknown, _cacheOpts?: unknown) => ({
      data: Buffer.from('cached'),
      artifact: {
        type: 'image',
        uri: 'cache://result',
        mimeType: 'image/png',
        metadata: {},
        sourceStep: undefined,
      },
      cost_usd: 0.001,
      duration_ms: 5,
    }));
    (
      cacheProvider as unknown as {
        executeWithCache: (
          params: unknown,
          cacheOpts?: unknown,
        ) => Promise<Record<string, unknown>>;
      }
    ).executeWithCache = executeWithCache;

    const executor = new PipelineExecutor({ providers: [cacheProvider] });
    const definition: PipelineDefinition = {
      id: 'cache-test',
      steps: [
        {
          id: 's1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
      ],
    };
    definition.steps[0].cache = { mode: 'write' as 'use', ttlSeconds: 3600 };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
    expect(executeWithCache).toHaveBeenCalledOnce();
  });

  it('should fall through to regular execute when cache config is present but no executeWithCache', async () => {
    const provider = new MockProvider({ name: 'nocache', operations: ['mock.generate'], delay: 5 });
    const executor = new PipelineExecutor({ providers: [provider] });
    const definition: PipelineDefinition = {
      id: 'no-cache-fn',
      steps: [{ id: 's1', operation: 'mock.generate', inputs: { prompt: 'test' }, config: {} }],
    };
    definition.steps[0].cache = { mode: 'read' as 'use' };

    const result = await executor.execute(definition);
    expect(result.status).toBe('completed');
  });
});

describe('PipelineExecutor — F3 lost-artifact handling', () => {
  it('throws ArtifactNotFoundError (typed) when an upstream artifact reference cannot be resolved', async () => {
    // Pipeline references {{step-missing.output}} in step1's inputs, but no step
    // 'step-missing' exists / produced an artifact. Plan §F3 test matrix:
    // "Lost artifact | artifact id from step 1 missing in registry | ArtifactNotFoundError, fail-fast".
    const provider = new MockProvider({
      name: 'mock',
      operations: ['mock.transform'],
      delay: 1,
      failureRate: 0,
    });
    const exec = new PipelineExecutor({ providers: [provider] });
    const def: PipelineDefinition = {
      id: 'lost-artifact-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.transform',
          // The placeholder must match the executor's regex `^\{\{(\w+)\.output\}\}$`
          // (i.e. word chars only); `step-missing` has a hyphen and wouldn't match.
          inputs: { in: '{{missingStep.output}}' },
          config: {},
        },
      ],
    };

    const result = await exec.execute(def);
    expect(result.status).toBe('failed');

    // The error surfaces through emitEvent → step:failed. Re-run via executeStepOnce
    // directly to capture the exact thrown type.
    try {
      await (
        exec as unknown as { executeStepOnce: (s: unknown, p: unknown) => Promise<unknown> }
      ).executeStepOnce(def.steps[0], {
        id: 'p',
        artifacts: new Map(),
        steps: def.steps,
        status: 'running',
        completedSteps: [],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactNotFoundError);
      expect((err as { code?: string }).code).toBe('ARTIFACT_NOT_FOUND');
    }
  });
});

describe('PipelineExecutor — createStepStateRecord', () => {
  it('should create step state record with defaults', () => {
    const record = createStepStateRecord('step1');
    expect(record.stepId).toBe('step1');
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
  });

  it('should create step state record with custom status', () => {
    const record = createStepStateRecord('step1', 'completed');
    expect(record.status).toBe('completed');
  });
});
