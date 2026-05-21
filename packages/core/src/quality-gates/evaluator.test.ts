import { describe, expect, it, vi } from 'vitest';
import type { Artifact, QualityGate } from '../types/index.js';
import {
  CustomEvaluator,
  DimensionCheckEvaluator,
  LLMJudgeEvaluator,
  ThresholdEvaluator,
  createQualityGateEvaluator,
} from './evaluator.js';

describe('Quality Gate Evaluators', () => {
  const createMockArtifact = (metadata: Record<string, unknown> = {}): Artifact => ({
    id: 'test-artifact',
    type: 'image',
    uri: 'test://uri',
    mimeType: 'image/png',
    metadata: {
      width: 1024,
      height: 1024,
      quality: 0.9,
      ...metadata,
    },
    sourceStep: 'step1',
  });

  describe('ThresholdEvaluator', () => {
    const evaluator = new ThresholdEvaluator();

    it('should pass when all checks pass', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: {
          checks: [
            { field: 'metadata.width', operator: '>=', value: 1024 },
            { field: 'metadata.height', operator: '>=', value: 1024 },
          ],
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(true);
      expect(result.reasoning).toBe('All checks passed');
    });

    it('should fail when any check fails', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: {
          checks: [
            { field: 'metadata.width', operator: '>=', value: 2048 },
            { field: 'metadata.height', operator: '>=', value: 1024 },
          ],
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('width');
    });

    it('should fail when field is missing', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: {
          checks: [{ field: 'metadata.nonexistent', operator: '>=', value: 100 }],
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('not found');
    });

    it('should support different operators', async () => {
      const testCases = [
        { operator: '>', value: 1023, expected: true },
        { operator: '>', value: 1024, expected: false },
        { operator: '<', value: 1025, expected: true },
        { operator: '<', value: 1024, expected: false },
        { operator: '==', value: 1024, expected: true },
        { operator: '!=', value: 1024, expected: false },
      ];

      for (const { operator, value, expected } of testCases) {
        const gate: QualityGate = {
          type: 'threshold',
          config: {
            checks: [{ field: 'metadata.width', operator, value }],
          },
          action: 'fail',
        };

        const artifact = createMockArtifact();
        const result = await evaluator.evaluate(gate, artifact);

        // vitest's expect(...).toBe takes only one arg; the prior second-arg
        // message form was a chai holdover. Embed the context via a wrapper.
        expect(result.passed, `Operator ${operator} ${value}`).toBe(expected);
      }
    });
  });

  describe('DimensionCheckEvaluator', () => {
    const evaluator = new DimensionCheckEvaluator();

    it('should pass when dimensions match exactly', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: {
          expectedWidth: 1024,
          expectedHeight: 1024,
          tolerance: 0,
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(true);
    });

    it('should pass within tolerance', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: {
          expectedWidth: 1000,
          expectedHeight: 1000,
          tolerance: 0.05, // 5% tolerance = 50 pixels
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(true);
    });

    it('should fail when outside tolerance', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: {
          expectedWidth: 2048,
          expectedHeight: 2048,
          tolerance: 0,
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
    });

    it('should fail when metadata is missing', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: {
          expectedWidth: 1024,
          expectedHeight: 1024,
        },
        action: 'fail',
      };

      const artifact = createMockArtifact({ width: undefined, height: undefined });
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
    });
  });

  describe('LLMJudgeEvaluator', () => {
    it('should use provided evaluate function', async () => {
      const mockEvaluate = async (_prompt: string, _artifact: Artifact) => ({
        pass: true,
        reasoning: 'Image looks great!',
        score: 9.5,
      });

      const evaluator = new LLMJudgeEvaluator(mockEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: {
          prompt: 'Evaluate this image',
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(true);
      expect(result.reasoning).toBe('Image looks great!');
      expect(result.score).toBe(9.5);
    });

    it('should fail when evaluate function returns pass=false', async () => {
      const mockEvaluate = async (_prompt: string, _artifact: Artifact) => ({
        pass: false,
        reasoning: 'Image quality is poor',
      });

      const evaluator = new LLMJudgeEvaluator(mockEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: {
          prompt: 'Evaluate this image',
        },
        action: 'retry',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
      expect(result.action).toBe('retry');
    });

    it('should fail when prompt is missing', async () => {
      const evaluator = new LLMJudgeEvaluator(async () => ({ pass: true, reasoning: '' }));
      const gate: QualityGate = {
        type: 'llm-judge',
        config: {},
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('prompt must be a string');
    });

    it('should handle evaluate function errors', async () => {
      const mockEvaluate = async () => {
        throw new Error('API error');
      };

      const evaluator = new LLMJudgeEvaluator(mockEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: {
          prompt: 'Evaluate this image',
        },
        action: 'fail',
      };

      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('API error');
    });
  });

  describe('createQualityGateEvaluator', () => {
    it('should create ThresholdEvaluator for threshold gates', () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [] },
        action: 'fail',
      };

      const evaluator = createQualityGateEvaluator(gate);
      expect(evaluator).toBeInstanceOf(ThresholdEvaluator);
    });

    it('should create DimensionCheckEvaluator for dimension-check gates', () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: { expectedWidth: 1024, expectedHeight: 1024 },
        action: 'warn',
      };

      const evaluator = createQualityGateEvaluator(gate);
      expect(evaluator).toBeInstanceOf(DimensionCheckEvaluator);
    });

    it('should create LLMJudgeEvaluator for llm-judge gates', () => {
      const gate: QualityGate = {
        type: 'llm-judge',
        config: { prompt: 'test' },
        action: 'retry',
      };

      const mockFn = async () => ({ pass: true, reasoning: '' });
      const evaluator = createQualityGateEvaluator(gate, mockFn);
      expect(evaluator).toBeInstanceOf(LLMJudgeEvaluator);
    });

    it('should throw for unknown gate type', () => {
      const gate = {
        type: 'unknown' as string,
        config: {},
        action: 'fail' as const,
      };

      expect(() =>
        createQualityGateEvaluator(
          gate as unknown as Parameters<typeof createQualityGateEvaluator>[0],
        ),
      ).toThrow('Unknown quality gate type');
    });

    it('should create CustomEvaluator for custom gates', () => {
      const gate: QualityGate = {
        type: 'custom',
        config: {},
        action: 'fail',
      };
      const checkFn = vi.fn(() => true);
      const evaluator = createQualityGateEvaluator(gate, undefined, checkFn);
      expect(evaluator).toBeInstanceOf(CustomEvaluator);
    });

    it('should throw for custom gate without checkFn', () => {
      const gate: QualityGate = {
        type: 'custom',
        config: {},
        action: 'fail',
      };
      expect(() => createQualityGateEvaluator(gate)).toThrow(
        'Custom evaluator requires a check function',
      );
    });

    it('should throw for llm-judge without evaluateFn', () => {
      const gate: QualityGate = {
        type: 'llm-judge',
        config: { prompt: 'eval' },
        action: 'fail',
      };
      expect(() => createQualityGateEvaluator(gate)).toThrow(
        'LLM-judge evaluator requires an evaluate function',
      );
    });
  });

  describe('ThresholdEvaluator edge cases', () => {
    const evaluator = new ThresholdEvaluator();

    it('should fail when checks is not an array', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: 'not-an-array' },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('checks must be an array');
    });

    it('should fail when field value is not numeric', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.quality', operator: '>=', value: 0.5 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact({ quality: 'not-a-number' });
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('not numeric');
    });

    it('should support short field names without metadata prefix', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'width', operator: '>=', value: 1024 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact({ width: 1024 });
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });

    it('should throw for unknown operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '??', value: 100 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      await expect(evaluator.evaluate(gate, artifact)).rejects.toThrow('Unknown operator');
    });

    it('should handle == operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '==', value: 1024 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });

    it('should handle != operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '!=', value: 999 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });
  });

  describe('DimensionCheckEvaluator edge cases', () => {
    const evaluator = new DimensionCheckEvaluator();

    it('should fail when expectedWidth/Height are not numbers', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: { expectedWidth: 'abc', expectedHeight: 'def' },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('must be numbers');
    });

    it('should fail when artifact has no width/height metadata', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: { expectedWidth: 1024, expectedHeight: 1024 },
        action: 'fail',
      };
      const artifact = createMockArtifact({ width: undefined, height: undefined });
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('missing');
    });

    it('should pass with exact tolerance=0 match', async () => {
      const gate: QualityGate = {
        type: 'dimension-check',
        config: { expectedWidth: 1024, expectedHeight: 1024, tolerance: 0 },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });
  });

  describe('LLMJudgeEvaluator edge cases', () => {
    it('should timeout when evaluate function is slow', async () => {
      const slowEvaluate = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { pass: true, reasoning: 'ok' };
      });
      const evaluator = new LLMJudgeEvaluator(slowEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: { prompt: 'eval', timeout: 50 },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('timeout');
    });

    it('should return score when provided', async () => {
      const mockEvaluate = async () => ({ pass: true, reasoning: 'good', score: 8.5 });
      const evaluator = new LLMJudgeEvaluator(mockEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: { prompt: 'eval' },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.score).toBe(8.5);
    });

    it('should default to 30s timeout', async () => {
      const fastEvaluate = vi.fn(async () => ({ pass: true, reasoning: 'ok' }));
      const evaluator = new LLMJudgeEvaluator(fastEvaluate);
      const gate: QualityGate = {
        type: 'llm-judge',
        config: { prompt: 'eval' },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });
  });

  describe('CustomEvaluator', () => {
    it('should pass when check function returns true', async () => {
      const checkFn = vi.fn(async () => true);
      const evaluator = new CustomEvaluator(checkFn);
      const gate: QualityGate = { type: 'custom', config: {}, action: 'fail' };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
      expect(result.reasoning).toBe('Custom check passed');
    });

    it('should fail when check function returns false', async () => {
      const checkFn = vi.fn(() => false);
      const evaluator = new CustomEvaluator(checkFn);
      const gate: QualityGate = { type: 'custom', config: {}, action: 'warn' };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toBe('Custom check failed');
      expect(result.action).toBe('warn');
    });

    it('should handle errors thrown by check function', async () => {
      const checkFn = vi.fn(() => {
        throw new Error('check error');
      });
      const evaluator = new CustomEvaluator(checkFn);
      const gate: QualityGate = { type: 'custom', config: {}, action: 'fail' };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('check error');
    });

    it('should support synchronous check functions', async () => {
      const checkFn = vi.fn(() => true);
      const evaluator = new CustomEvaluator(checkFn);
      const gate: QualityGate = { type: 'custom', config: { threshold: 0.5 }, action: 'fail' };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
      expect(checkFn).toHaveBeenCalledWith(artifact, { threshold: 0.5 });
    });
  });

  describe('getNestedValue prototype pollution protection', () => {
    const evaluator = new ThresholdEvaluator();

    it('should block __proto__ access', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.__proto__', operator: '>=', value: 100 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('not found');
    });

    it('should block constructor access', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.constructor', operator: '>=', value: 100 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('not found');
    });

    it('should handle non-object intermediate in nested path', async () => {
      // width is a number, so metadata.width.something hits a non-object intermediate
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'width.nonexistent', operator: '>=', value: 100 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('not found');
    });

    it('should support standalone < operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '<', value: 2000 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });

    it('should support <= operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '<=', value: 1024 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });

    it('should support === operator', async () => {
      const gate: QualityGate = {
        type: 'threshold',
        config: { checks: [{ field: 'metadata.width', operator: '===', value: 1024 }] },
        action: 'fail',
      };
      const artifact = createMockArtifact();
      const result = await evaluator.evaluate(gate, artifact);
      expect(result.passed).toBe(true);
    });
  });
});
