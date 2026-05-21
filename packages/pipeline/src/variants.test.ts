import type {
  Artifact,
  JudgeConfig,
  JudgeRubric,
  PipelineStep,
  VariantsConfig,
} from '@reaatech/media-pipeline-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantsExecutor } from './variants.js';
import type { VariantsExecutorContext } from './variants.js';

describe('VariantsExecutor', () => {
  let executor: VariantsExecutor;
  let context: VariantsExecutorContext;

  beforeEach(() => {
    executor = new VariantsExecutor();
    context = {
      executeOperation: async (_op, _inputs, config) => {
        const id = `artifact-${Math.random().toString(36).slice(2, 9)}`;
        return {
          artifact: {
            id,
            type: 'image',
            uri: `mock://${id}`,
            mimeType: 'image/png',
            metadata: { ...config },
            sourceStep: undefined,
            createdAt: new Date().toISOString(),
          } satisfies Artifact,
          costUsd: 0.001,
        };
      },
    };
  });

  it('should generate and evaluate N variants with llm-judge', async () => {
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 3,
      seedStrategy: 'sequential',
      judge: { type: 'llm-judge', criteria: 'quality and relevance' },
    };

    const result = await executor.executeVariants(step, config, context);

    expect(result.winner).toBeDefined();
    expect(result.losers).toHaveLength(2);
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.winner!.variantIndex).toBeGreaterThanOrEqual(0);
    expect(result.winner!.winner).toBe(true);
    expect(result.losers.every((l) => !l.winner)).toBe(true);
  });

  it('should reject variants with generation errors', async () => {
    const failingContext: VariantsExecutorContext = {
      executeOperation: async (_op, _inputs, _config) => {
        throw new Error('Provider unavailable');
      },
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 2,
      seedStrategy: 'random',
      judge: { type: 'rule', expression: 'metadata.width >= 0' },
    };

    const result = await executor.executeVariants(step, config, failingContext);

    expect(result.winner).toBeUndefined();
    expect(result.losers).toHaveLength(2);
    expect(result.losers.every((l) => l.rejected === 'generation-error')).toBe(true);
  });

  it('should throw VariantsAllRejectedError when minScore filter drains the set', async () => {
    // Plan §F9 test matrix: "Below minScore | n=4, best score=0.4, minScore=0.7 |
    // VariantsAllRejectedError(reason='judge-low')". The earlier in-tree behavior
    // here returned `{ winner: undefined }` silently, but the plan explicitly says
    // this should be a fail-fast error so the pipeline executor surfaces it.
    const { VariantsAllRejectedError } = await import('@reaatech/media-pipeline-mcp-core');
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 3,
      seedStrategy: 'sequential',
      judge: { type: 'rule', expression: 'metadata.width >= 999999' },
      minScore: 1,
    };

    await expect(executor.executeVariants(step, config, context)).rejects.toBeInstanceOf(
      VariantsAllRejectedError,
    );
  });

  it('should use rule judge correctly', async () => {
    const ruleContext: VariantsExecutorContext = {
      executeOperation: async (_op, _inputs, _config) => ({
        artifact: {
          id: 'test-artifact',
          type: 'image',
          uri: 'mock://test',
          mimeType: 'image/png',
          metadata: { width: 1024, height: 768 },
        } satisfies Artifact,
        costUsd: 0.001,
      }),
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 2,
      seedStrategy: 'sequential',
      judge: { type: 'rule', expression: 'metadata.width >= 1024' },
    };

    const result = await executor.executeVariants(step, config, ruleContext);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBe(1);
  });

  it('should generate sequential seeds correctly', () => {
    const seeds = (
      executor as unknown as {
        generateSeedValues(n: number, strategy: string, seeds?: number[]): number[];
      }
    ).generateSeedValues(5, 'sequential');
    expect(seeds).toEqual([1, 2, 3, 4, 5]);
  });

  it('should generate fixed-list seeds correctly', () => {
    const seeds = (
      executor as unknown as {
        generateSeedValues(n: number, strategy: string, seeds?: number[]): number[];
      }
    ).generateSeedValues(3, 'fixed-list', [42, 99, 123]);
    expect(seeds).toEqual([42, 99, 123]);
  });

  it('should generate random seeds when no strategy specified', () => {
    const seeds = (
      executor as unknown as {
        generateSeedValues(n: number, strategy: string, seeds?: number[]): number[];
      }
    ).generateSeedValues(5, 'random');
    expect(seeds).toHaveLength(5);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });

  it('should handle image-judge with simulated scoring', async () => {
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 2,
      judge: { type: 'image-judge', criteria: 'aesthetic' },
    };

    const result = await executor.executeVariants(step, config, context);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBeGreaterThan(0);
  });

  it('should handle custom judge gracefully', async () => {
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 2,
      judge: { type: 'custom', toolName: 'my-evaluator' },
    };

    const result = await executor.executeVariants(step, config, context);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBe(0.5);
  });

  // ─── New coverage tests ──────────────────────────────────────────

  it('LLM-judge with custom llmJudgeFn uses the function', async () => {
    const llmJudgeFn = vi
      .fn<(...args: unknown[]) => Promise<{ score: number; rationale: string }>>()
      .mockResolvedValue({ score: 0.85, rationale: 'Great image' });

    const customContext: VariantsExecutorContext = {
      ...context,
      llmJudgeFn,
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 2,
      judge: {
        type: 'llm-judge',
        criteria: 'quality',
        rubric: {
          dimensions: [{ name: 'sharpness', weight: 1, description: 'overall sharpness' }],
        } satisfies JudgeRubric,
      },
    };

    const result = await executor.executeVariants(step, config, customContext);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBe(0.85);
    expect(result.winner!.judgeRationale).toBe('Great image');
    expect(llmJudgeFn).toHaveBeenCalled();
  });

  it('LLM-judge with low score rejects variant (score < 0.5)', async () => {
    const llmJudgeFn = vi
      .fn<(...args: unknown[]) => Promise<{ score: number; rationale: string }>>()
      .mockResolvedValue({ score: 0.3, rationale: 'Low quality' });

    const customContext: VariantsExecutorContext = {
      ...context,
      llmJudgeFn,
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 1,
      judge: { type: 'llm-judge', criteria: 'quality' },
    };

    const result = await executor.executeVariants(step, config, customContext);

    // All variants rejected (score 0.3 < 0.5), so winner is undefined
    // Losers come from pre-judge results so don't have judgeScore/rejected set
    expect(result.winner).toBeUndefined();
    expect(result.losers).toHaveLength(1);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('score tie: first variant with highest score wins', async () => {
    let callCount = 0;
    const tieContext: VariantsExecutorContext = {
      executeOperation: async (_op, _inputs, _config) => {
        callCount++;
        return {
          artifact: {
            id: `tie-art-${callCount}`,
            type: 'image',
            uri: `mock://tie-art-${callCount}`,
            mimeType: 'image/png',
            metadata: { score: 50 },
            sourceStep: undefined,
            createdAt: new Date().toISOString(),
          } satisfies Artifact,
          costUsd: 0.001,
        };
      },
      llmJudgeFn: async () => ({ score: 0.75, rationale: 'tied score' }),
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 3,
      seedStrategy: 'sequential',
      judge: { type: 'llm-judge', criteria: 'quality' },
    };

    const result = await executor.executeVariants(step, config, tieContext);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBe(0.75);
  });

  it('loser action=archive does not mark losers as rejected', async () => {
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 3,
      seedStrategy: 'sequential',
      judge: { type: 'llm-judge', criteria: 'quality' },
      loserAction: 'archive',
    };

    const result = await executor.executeVariants(step, config, context);

    expect(result.winner).toBeDefined();
    expect(result.losers).toHaveLength(2);
    expect(result.losers.every((l) => !l.winner)).toBe(true);
  });

  it('default judge type returns score 0', async () => {
    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 1,
      // Intentionally invalid judge type to exercise the fall-through path.
      judge: { type: 'unknown-judge', criteria: 'test' } as unknown as JudgeConfig,
    };

    const result = await executor.executeVariants(step, config, context);

    expect(result.winner).toBeDefined();
    expect(result.winner!.judgeScore).toBe(0);
  });

  it('fixed-list with insufficient seeds falls back to sequential', () => {
    const seeds = (
      executor as unknown as {
        generateSeedValues(n: number, strategy: string, seeds?: number[]): number[];
      }
    ).generateSeedValues(5, 'fixed-list', [42]);
    expect(seeds).toEqual([1, 2, 3, 4, 5]);
  });

  it('rule judge: resolveField for width and height without metadata prefix', () => {
    const artifact: Artifact = {
      id: 'test',
      type: 'image',
      uri: 'mock://test',
      mimeType: 'image/png',
      metadata: { width: 1920, height: 1080 },
      sourceStep: undefined,
      createdAt: new Date().toISOString(),
    };

    const widthResult = (
      executor as unknown as { resolveField(field: string, artifact: Artifact): number }
    ).resolveField('width', artifact);
    expect(widthResult).toBe(1920);

    const heightResult = (
      executor as unknown as { resolveField(field: string, artifact: Artifact): number }
    ).resolveField('height', artifact);
    expect(heightResult).toBe(1080);
  });

  it('rule judge: resolveField for metadata with string value', () => {
    const artifact: Artifact = {
      id: 'test',
      type: 'image',
      uri: 'mock://test',
      mimeType: 'image/png',
      metadata: { width: '2048', customField: 'abc' },
      sourceStep: undefined,
      createdAt: new Date().toISOString(),
    };

    const result = (
      executor as unknown as { resolveField(field: string, artifact: Artifact): number }
    ).resolveField('metadata.width', artifact);
    expect(result).toBe(2048);

    // Non-numeric string → NaN → returns 0
    const nanResult = (
      executor as unknown as { resolveField(field: string, artifact: Artifact): number }
    ).resolveField('metadata.customField', artifact);
    expect(nanResult).toBe(0);
  });

  it('rule judge: evaluateRuleExpression with various operators', () => {
    const artifact: Artifact = {
      id: 'test',
      type: 'image',
      uri: 'mock://test',
      mimeType: 'image/png',
      metadata: { width: 1024, height: 768, fileSize: 5000 },
      sourceStep: undefined,
      createdAt: new Date().toISOString(),
    };

    const r = (expr: string) =>
      (
        executor as unknown as {
          evaluateRuleExpression(expression: string, artifact: Artifact): number;
        }
      ).evaluateRuleExpression(expr, artifact);

    // Happy path: width >= 1024 evaluates to true (1) since width is 1024
    expect(r('metadata.width >= 1024')).toBe(1);
    // Failing check: unknown field resolves to 0, so 'unknown > 0' is false (0)
    expect(r('unknown > 0')).toBe(0);
    // String metadata value that is numeric is parsed
    const artifact2: Artifact = {
      ...artifact,
      metadata: { width: '2048', height: 768, fileSize: 5000 },
    };
    const r2 = (expr: string) =>
      (
        executor as unknown as {
          evaluateRuleExpression(expression: string, artifact: Artifact): number;
        }
      ).evaluateRuleExpression(expr, artifact2);
    expect(r2('metadata.width >= 2000')).toBe(1);
  });

  it('rule judge: invalid expression returns 0.5', () => {
    const artifact: Artifact = {
      id: 'test',
      type: 'image',
      uri: 'mock://test',
      mimeType: 'image/png',
      metadata: {},
      sourceStep: undefined,
      createdAt: new Date().toISOString(),
    };

    expect(
      (
        executor as unknown as {
          evaluateRuleExpression(expression: string, artifact: Artifact): number;
        }
      ).evaluateRuleExpression('invalid format', artifact),
    ).toBe(0.5);
    expect(
      (
        executor as unknown as {
          evaluateRuleExpression(expression: string, artifact: Artifact): number;
        }
      ).evaluateRuleExpression('', artifact),
    ).toBe(0.5);
  });

  it('rule judge: applyOperator default case returns false', () => {
    const result = (
      executor as unknown as {
        applyOperator(operator: string, actual: number, expected: number): boolean;
      }
    ).applyOperator('???', 10, 5);
    expect(result).toBe(false);
  });

  it('partial generation failure: some variants fail, some succeed', async () => {
    let callIndex = 0;
    const partialContext: VariantsExecutorContext = {
      executeOperation: async (_op, _inputs, _config) => {
        callIndex++;
        if (callIndex === 2) throw new Error('Transient error');
        return {
          artifact: {
            id: `partial-art-${callIndex}`,
            type: 'image',
            uri: `mock://partial-art-${callIndex}`,
            mimeType: 'image/png',
            metadata: {},
            sourceStep: undefined,
            createdAt: new Date().toISOString(),
          } satisfies Artifact,
          costUsd: 0.001,
        };
      },
    };

    const step: PipelineStep = {
      id: 's1',
      operation: 'image.generate',
      inputs: { prompt: 'test' },
      config: {},
    };

    const config: VariantsConfig = {
      n: 3,
      seedStrategy: 'sequential',
      judge: { type: 'rule', expression: 'metadata.width >= 0' },
    };

    const result = await executor.executeVariants(step, config, partialContext);

    expect(result.winner).toBeDefined();
    expect(result.losers).toHaveLength(2);
    expect(result.losers.filter((l) => l.rejected === 'generation-error')).toHaveLength(1);
  });
});
