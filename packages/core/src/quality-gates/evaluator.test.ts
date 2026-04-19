import { describe, it, expect } from 'vitest';
import {
  ThresholdEvaluator,
  DimensionCheckEvaluator,
  LLMJudgeEvaluator,
  createQualityGateEvaluator,
} from './evaluator.js';
import type { QualityGate, Artifact } from '../types/index.js';

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

        expect(result.passed).toBe(expected, `Operator ${operator} ${value}`);
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
        type: 'unknown' as any,
        config: {},
        action: 'fail' as const,
      };

      expect(() => createQualityGateEvaluator(gate)).toThrow('Unknown quality gate type');
    });
  });
});
