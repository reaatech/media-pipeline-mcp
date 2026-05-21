import { describe, expect, it, vi } from 'vitest';
import { PipelineEstimator } from './pipeline-estimator.js';
import type { PipelineDefinition, PipelineStep } from './types/index.js';

describe('PipelineEstimator', () => {
  it('should estimate a pipeline with estimateOperation callback', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async (op) => {
        const map: Record<string, { usdLow: number; usdHigh: number }> = {
          'image.generate': { usdLow: 0.003, usdHigh: 0.008 },
          'image.upscale': { usdLow: 0.002, usdHigh: 0.005 },
        };
        return map[op] ?? null;
      },
    });

    const pipeline: PipelineDefinition = {
      id: 'test',
      steps: [
        { id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} },
        {
          id: 's2',
          operation: 'image.upscale',
          inputs: { artifact_id: '{{s1.output}}' },
          config: {},
        },
      ],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.totalUsdLow).toBe(0.005);
    expect(result.totalUsdHigh).toBeCloseTo(0.013, 10);
    expect(result.perStep).toHaveLength(2);
    // Step 2 has prior-step dependency => warning emitted
    expect(result.warnings.some((w) => w.code === 'depends-on-prior-step')).toBe(true);
  });

  it('should warn for operations without estimator', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => null,
    });

    const pipeline: PipelineDefinition = {
      id: 'test',
      steps: [{ id: 's1', operation: 'unknown.op', inputs: {}, config: {} }],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.perStep[0].estimable).toBe(false);
    expect(result.perStep[0].fallbackUsed).toBe('default-bound');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('no-estimator');
  });

  it('should warn for prior-step dependencies', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.001, usdHigh: 0.01 }),
    });

    const pipeline: PipelineDefinition = {
      id: 'test',
      steps: [
        { id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} },
        {
          id: 's2',
          operation: 'image.upscale',
          inputs: { artifact_id: '{{s1.output}}' },
          config: {},
        },
      ],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.warnings.some((w) => w.code === 'depends-on-prior-step')).toBe(true);
  });

  it('should warn for router-spread when route has candidates', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.001, usdHigh: 0.01 }),
    });

    const pipeline: PipelineDefinition = {
      id: 'test',
      steps: [
        {
          id: 's1',
          operation: 'image.generate',
          inputs: { prompt: 'test' },
          config: {},
        },
      ],
    };
    (pipeline.steps[0] as PipelineStep).route = {
      candidates: [
        { provider: 'provider-a', model: 'm' },
        { provider: 'provider-b', model: 'm' },
      ],
      strategy: 'first-success',
    };

    const result = await estimator.estimate(pipeline);

    expect(result.warnings.some((w) => w.code === 'router-spread')).toBe(true);
  });

  it('should handle empty pipeline', async () => {
    const estimator = new PipelineEstimator();

    const pipeline: PipelineDefinition = {
      id: 'empty',
      steps: [],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.totalUsdLow).toBe(0);
    expect(result.totalUsdHigh).toBe(0);
    expect(result.perStep).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should fall back to default bounds when no estimateOperation is provided', async () => {
    const estimator = new PipelineEstimator();
    const pipeline: PipelineDefinition = {
      id: 'no-op',
      steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.perStep[0].estimable).toBe(false);
    expect(result.perStep[0].fallbackUsed).toBe('default-bound');
    expect(result.perStep[0].usdLow).toBe(0.001);
    expect(result.perStep[0].usdHigh).toBe(0.01);
  });

  it('should use cached-stats fallback when ledger has historical costs', async () => {
    const ledger = {
      charge: vi.fn(),
      getRunCost: vi.fn(),
      getTotalCost: vi.fn().mockResolvedValue(5.0),
    };
    const estimator = new PipelineEstimator({
      estimateOperation: async () => null,
      ledger,
    });
    const pipeline: PipelineDefinition = {
      id: 'cached',
      steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.perStep[0].fallbackUsed).toBe('cached-stats');
    expect(ledger.getTotalCost).toHaveBeenCalled();
  });

  it('should handle ledger getTotalCost throwing an error', async () => {
    const ledger = {
      charge: vi.fn(),
      getRunCost: vi.fn(),
      getTotalCost: vi.fn().mockRejectedValue(new Error('ledger error')),
    };
    const estimator = new PipelineEstimator({
      estimateOperation: async () => null,
      ledger,
    });
    const pipeline: PipelineDefinition = {
      id: 'ledger-error',
      steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await estimator.estimate(pipeline);
    // Should not throw, should use default-bound as fallback
    expect(result.perStep[0].fallbackUsed).toBe('default-bound');
  });

  it('should use estimate operation values when provided', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.005, usdHigh: 0.02 }),
    });
    const pipeline: PipelineDefinition = {
      id: 'custom-est',
      steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
    };

    const result = await estimator.estimate(pipeline);

    expect(result.perStep[0].usdLow).toBe(0.005);
    expect(result.perStep[0].usdHigh).toBe(0.02);
    expect(result.perStep[0].estimable).toBe(true);
  });

  it('should emit depends-on-prior-step warning for chained steps', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.001, usdHigh: 0.01 }),
    });
    const pipeline: PipelineDefinition = {
      id: 'chained',
      steps: [
        { id: 's1', operation: 'generate', inputs: { prompt: 'test' }, config: {} },
        { id: 's2', operation: 'transform', inputs: { artifact_id: '{{s1.output}}' }, config: {} },
        { id: 's3', operation: 'extract', inputs: { artifact_id: '{{s2.output}}' }, config: {} },
      ],
    };

    const result = await estimator.estimate(pipeline);
    const dependsWarnings = result.warnings.filter((w) => w.code === 'depends-on-prior-step');
    expect(dependsWarnings).toHaveLength(2);
  });

  it('should warn on router-spread when route has multiple candidates', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.001, usdHigh: 0.01 }),
    });
    const pipeline: PipelineDefinition = {
      id: 'router',
      steps: [{ id: 's1', operation: 'generate', inputs: {}, config: {} }],
    };
    (pipeline.steps[0] as PipelineStep).route = {
      candidates: [
        { provider: 'a', model: 'm' },
        { provider: 'b', model: 'm' },
        { provider: 'c', model: 'm' },
      ],
      strategy: 'first-success',
    };

    const result = await estimator.estimate(pipeline);
    expect(result.warnings.some((w) => w.code === 'router-spread')).toBe(true);
    expect(result.warnings.some((w) => w.message.includes('3 candidates'))).toBe(true);
  });

  it('should not warn on router-spread when single candidate', async () => {
    const estimator = new PipelineEstimator({
      estimateOperation: async () => ({ usdLow: 0.001, usdHigh: 0.01 }),
    });
    const pipeline: PipelineDefinition = {
      id: 'single-router',
      steps: [{ id: 's1', operation: 'generate', inputs: {}, config: {} }],
    };
    (pipeline.steps[0] as PipelineStep).route = {
      candidates: [{ provider: 'a', model: 'm' }],
      strategy: 'first-success',
    };

    const result = await estimator.estimate(pipeline);
    expect(result.warnings.filter((w) => w.code === 'router-spread')).toHaveLength(0);
  });
});
