import type { QualityGate, QualityGateResult, Artifact } from '../types/index.js';

export interface QualityGateEvaluator {
  evaluate(gate: QualityGate, artifact: Artifact): Promise<QualityGateResult>;
}

export class ThresholdEvaluator implements QualityGateEvaluator {
  async evaluate(gate: QualityGate, artifact: Artifact): Promise<QualityGateResult> {
    const checks = gate.config.checks as Array<{
      field: string;
      operator: string;
      value: number;
    }>;

    if (!Array.isArray(checks)) {
      return {
        passed: false,
        reasoning: 'Invalid threshold configuration: checks must be an array',
        action: gate.action,
      };
    }

    const failures: string[] = [];

    for (const check of checks) {
      const { field, operator, value } = check;
      // Support both 'width' (relative to metadata) and 'metadata.width' (relative to artifact)
      const actual = field.startsWith('metadata.')
        ? this.getNestedValue({ metadata: artifact.metadata }, field)
        : this.getNestedValue(artifact.metadata, field);

      if (actual === undefined) {
        failures.push(`Field '${field}' not found in artifact metadata`);
        continue;
      }

      const numActual = Number(actual);
      if (isNaN(numActual)) {
        failures.push(`Field '${field}' is not numeric: ${actual}`);
        continue;
      }

      const passed = this.compare(numActual, operator, value);
      if (!passed) {
        failures.push(`${field} (${numActual}) ${operator} ${value} failed`);
      }
    }

    return {
      passed: failures.length === 0,
      reasoning: failures.length > 0 ? failures.join('; ') : 'All checks passed',
      action: gate.action,
    };
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (current === null || current === undefined) return undefined;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      if (typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  private compare(actual: number, operator: string, expected: number): boolean {
    switch (operator) {
      case '>=':
        return actual >= expected;
      case '<=':
        return actual <= expected;
      case '>':
        return actual > expected;
      case '<':
        return actual < expected;
      case '==':
      case '===':
        return actual === expected;
      case '!=':
        return actual !== expected;
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }
}

export class DimensionCheckEvaluator implements QualityGateEvaluator {
  async evaluate(gate: QualityGate, artifact: Artifact): Promise<QualityGateResult> {
    const { expectedWidth, expectedHeight, tolerance = 0 } = gate.config;

    // Type assertion for config values
    const width = expectedWidth as number;
    const height = expectedHeight as number;
    const tol = tolerance as number;

    if (typeof width !== 'number' || typeof height !== 'number') {
      return {
        passed: false,
        reasoning:
          'Invalid dimension-check configuration: expectedWidth and expectedHeight must be numbers',
        action: gate.action,
      };
    }

    const actualWidth = artifact.metadata.width as number | undefined;
    const actualHeight = artifact.metadata.height as number | undefined;

    if (actualWidth === undefined || actualHeight === undefined) {
      return {
        passed: false,
        reasoning: 'Artifact missing width or height metadata',
        action: gate.action,
      };
    }

    const widthDiff = Math.abs(actualWidth - width);
    const heightDiff = Math.abs(actualHeight - height);
    const widthTolerance = width * tol;
    const heightTolerance = height * tol;

    const widthOk = widthDiff <= widthTolerance;
    const heightOk = heightDiff <= heightTolerance;

    if (widthOk && heightOk) {
      return {
        passed: true,
        reasoning: `Dimensions ${actualWidth}x${actualHeight} match expected ${width}x${height} within ${tol * 100}% tolerance`,
        action: gate.action,
      };
    }

    return {
      passed: false,
      reasoning: `Dimensions ${actualWidth}x${actualHeight} do not match expected ${width}x${height} within ${tol * 100}% tolerance`,
      action: gate.action,
    };
  }
}

export class LLMJudgeEvaluator implements QualityGateEvaluator {
  private evaluateFn: (
    prompt: string,
    artifact: Artifact
  ) => Promise<{ pass: boolean; reasoning: string; score?: number }>;

  constructor(
    evaluateFn: (
      prompt: string,
      artifact: Artifact
    ) => Promise<{ pass: boolean; reasoning: string; score?: number }>
  ) {
    this.evaluateFn = evaluateFn;
  }

  async evaluate(gate: QualityGate, artifact: Artifact): Promise<QualityGateResult> {
    const { prompt, timeout } = gate.config;

    if (typeof prompt !== 'string') {
      return {
        passed: false,
        reasoning: 'Invalid LLM-judge configuration: prompt must be a string',
        action: gate.action,
      };
    }

    const timeoutMs = typeof timeout === 'number' ? timeout : 30000;

    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.evaluateFn(prompt, artifact),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`LLM-judge timeout after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      return {
        passed: result.pass,
        reasoning: result.reasoning,
        score: result.score,
        action: gate.action,
      };
    } catch (error) {
      return {
        passed: false,
        reasoning: `LLM-judge evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        action: gate.action,
      };
    }
  }
}

export class CustomEvaluator implements QualityGateEvaluator {
  private checkFn: (
    artifact: Artifact,
    config: Record<string, unknown>
  ) => boolean | Promise<boolean>;

  constructor(
    checkFn: (artifact: Artifact, config: Record<string, unknown>) => boolean | Promise<boolean>
  ) {
    this.checkFn = checkFn;
  }

  async evaluate(gate: QualityGate, artifact: Artifact): Promise<QualityGateResult> {
    try {
      const passed = await this.checkFn(artifact, gate.config);
      return {
        passed,
        reasoning: passed ? 'Custom check passed' : 'Custom check failed',
        action: gate.action,
      };
    } catch (error) {
      return {
        passed: false,
        reasoning: `Custom check error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        action: gate.action,
      };
    }
  }
}

export function createQualityGateEvaluator(
  gate: QualityGate,
  llmJudgeFn?: (
    prompt: string,
    artifact: Artifact
  ) => Promise<{ pass: boolean; reasoning: string; score?: number }>,
  customCheckFn?: (
    artifact: Artifact,
    config: Record<string, unknown>
  ) => boolean | Promise<boolean>
): QualityGateEvaluator {
  switch (gate.type) {
    case 'threshold':
      return new ThresholdEvaluator();
    case 'dimension-check':
      return new DimensionCheckEvaluator();
    case 'llm-judge':
      if (!llmJudgeFn) {
        throw new Error('LLM-judge evaluator requires an evaluate function');
      }
      return new LLMJudgeEvaluator(llmJudgeFn);
    case 'custom':
      if (!customCheckFn) {
        throw new Error('Custom evaluator requires a check function to be provided');
      }
      return new CustomEvaluator(customCheckFn);
    default:
      throw new Error(`Unknown quality gate type: ${gate.type}`);
  }
}
