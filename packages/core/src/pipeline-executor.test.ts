import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineExecutor } from './pipeline-executor.js';
import { MockProvider } from './mock-provider.js';
import type { PipelineDefinition } from './types/index.js';

describe('PipelineExecutor', () => {
  let mockProvider: MockProvider;
  let executor: PipelineExecutor;
  let events: any[] = [];
  let costs: any[] = [];

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
      (a) => a.sourceStep === 'step1'
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
