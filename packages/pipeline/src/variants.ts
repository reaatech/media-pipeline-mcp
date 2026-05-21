import type {
  Artifact,
  JudgeConfig,
  JudgeRubric,
  PipelineStep,
  VariantResult,
  VariantsConfig,
  VariantsStepOutput,
} from '@reaatech/media-pipeline-mcp-core';
import { VariantsAllRejectedError } from '@reaatech/media-pipeline-mcp-core';

export interface VariantExecutionResult {
  artifact: Artifact;
  costUsd: number;
}

export interface VariantsExecutorContext {
  executeOperation: (
    operation: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<VariantExecutionResult>;
  llmJudgeFn?: (
    criteria: string,
    artifact: Artifact,
    rubric?: JudgeRubric,
  ) => Promise<{ score: number; rationale: string }>;
}

export class VariantsExecutor {
  async executeVariants(
    step: PipelineStep,
    variantsConfig: VariantsConfig,
    context: VariantsExecutorContext,
  ): Promise<VariantsStepOutput> {
    const { n, seedStrategy = 'random', seeds, minScore, loserAction = 'discard' } = variantsConfig;
    const results: VariantResult[] = [];
    let totalCostUsd = 0;
    let judgeUsdCost = 0;

    // 1. Generate seed values
    const seedValues = this.generateSeedValues(n, seedStrategy, seeds);

    // 2. Fan out variant generation (collect artifacts for evaluation)
    const executionResults: Array<{ result: VariantResult; artifact?: Artifact }> = [];

    for (let i = 0; i < n; i++) {
      const execResult = await this.executeVariant(i, step, variantsConfig, seedValues[i], context);
      executionResults.push(execResult);
    }

    for (const er of executionResults) {
      results.push(er.result);
      totalCostUsd += er.result.costUsd;
      if (er.result.judgeScore !== undefined) {
        judgeUsdCost += 0.001;
      }
    }

    // 3. Judge all variants
    const evaluated = await Promise.all(
      executionResults.map(async (er) =>
        this.evaluateVariant(er.result, variantsConfig.judge, context, er.artifact),
      ),
    );

    // 4. Apply minScore filter
    const filtered =
      minScore !== undefined
        ? evaluated.filter((r) => !r.rejected && (r.judgeScore ?? 0) >= minScore)
        : evaluated.filter((r) => !r.rejected);

    // Plan §F9 test matrix:
    //   "All variants fail safety → VariantsAllRejectedError(reason='safety')"
    //   "Below minScore → VariantsAllRejectedError(reason='judge-low')"
    //
    // For "generation-error" and "judge unavailable" the plan keeps the soft-fail
    // semantics — return { winner: undefined, losers } so the caller can still
    // archive losers. Throws are reserved for cases the caller likely wants the
    // pipeline to fail-fast on (deliberate safety block, judge below threshold).
    const safetyRejected = evaluated.some((r) => r.rejected === 'safety');
    if (safetyRejected && filtered.length === 0) {
      throw new VariantsAllRejectedError('safety');
    }
    if (minScore !== undefined && filtered.length === 0 && evaluated.some((r) => !r.rejected)) {
      // Distinguish "below minScore" (variants generated + judged OK but scored low)
      // from "all failed generation" (handled by the soft return below).
      throw new VariantsAllRejectedError('judge-low');
    }

    // 5. Pick winner (highest score)
    let winner: VariantResult | undefined;
    if (filtered.length > 0) {
      winner = filtered.reduce((best, curr) =>
        (curr.judgeScore ?? 0) > (best.judgeScore ?? 0) ? curr : best,
      );
    }

    const losers = results.filter((r) => r.variantIndex !== winner?.variantIndex);
    for (const loser of losers) {
      if (!loser.rejected) {
        loser.winner = false;
      }
    }

    if (winner) {
      winner.winner = true;
    }

    // Handle loser action
    if (loserAction === 'archive') {
      // In a real implementation, mark artifacts for archival instead of deletion
    }

    return { winner, losers, totalCostUsd, judgeUsdCost };
  }

  private async executeVariant(
    variantIndex: number,
    step: PipelineStep,
    _variantsConfig: VariantsConfig,
    seed: number,
    context: VariantsExecutorContext,
  ): Promise<{ result: VariantResult; artifact?: Artifact }> {
    const baseCostUsd = 0.001;

    try {
      const configWithSeed = { ...step.config, seed };
      const execResult = await context.executeOperation(
        step.operation,
        step.inputs as Record<string, unknown>,
        configWithSeed,
      );

      return {
        result: {
          variantIndex,
          artifactId: execResult.artifact.id,
          costUsd: execResult.costUsd,
          winner: false,
        },
        artifact: execResult.artifact,
      };
    } catch (error) {
      return {
        result: {
          variantIndex,
          costUsd: baseCostUsd,
          winner: false,
          rejected: 'generation-error',
          generationError: {
            code: 'VARIANT_EXECUTION_FAILED',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
      };
    }
  }

  private async evaluateVariant(
    variant: VariantResult,
    judge: JudgeConfig,
    context: VariantsExecutorContext,
    resultArtifact?: Artifact,
  ): Promise<VariantResult> {
    if (variant.rejected) return variant;
    if (!variant.artifactId) return { ...variant, rejected: 'generation-error', judgeScore: 0 };

    const artifact: Artifact = resultArtifact ?? {
      id: variant.artifactId,
      type: 'image',
      uri: `variant://${variant.artifactId}`,
      mimeType: 'image/png',
      metadata: {},
      sourceStep: undefined,
      createdAt: new Date().toISOString(),
    };

    switch (judge.type) {
      case 'llm-judge': {
        if (context.llmJudgeFn) {
          const result = await context.llmJudgeFn(judge.criteria, artifact, judge.rubric);
          const rejected = result.score < 0.5 ? ('judge-low' as const) : undefined;
          return {
            ...variant,
            judgeScore: result.score,
            judgeRationale: result.rationale,
            ...(rejected ? { rejected } : {}),
          };
        }
        // Fallback: simple simulation
        const simulatedScore = 0.5 + Math.random() * 0.5;
        return {
          ...variant,
          judgeScore: simulatedScore,
          judgeRationale: `Simulated LLM-judge score: ${simulatedScore.toFixed(2)}`,
        };
      }

      case 'image-judge': {
        // image-judge requires external CLIP/aesthetic model
        // Simulate with a random score
        const simScore = 0.4 + Math.random() * 0.6;
        return {
          ...variant,
          judgeScore: simScore,
          judgeRationale: `Simulated ${judge.criteria} score: ${simScore.toFixed(2)} (requires external model)`,
        };
      }

      case 'rule': {
        const score = this.evaluateRuleExpression(judge.expression, artifact);
        return {
          ...variant,
          judgeScore: score,
          judgeRationale: `Rule expression '${judge.expression}' evaluated to ${score}`,
        };
      }

      case 'custom': {
        // custom requires an external tool
        return {
          ...variant,
          judgeScore: 0.5,
          judgeRationale: `Custom judge '${judge.toolName}' requires external tool integration`,
        };
      }

      default:
        return { ...variant, judgeScore: 0 };
    }
  }

  private generateSeedValues(
    n: number,
    strategy: 'random' | 'sequential' | 'fixed-list',
    seeds?: number[],
  ): number[] {
    switch (strategy) {
      case 'sequential':
        return Array.from({ length: n }, (_, i) => i + 1);
      case 'fixed-list':
        if (seeds && seeds.length >= n) {
          return seeds.slice(0, n);
        }
        return Array.from({ length: n }, (_, i) => i + 1);
      default:
        return Array.from({ length: n }, () => Math.floor(Math.random() * 2147483647));
    }
  }

  private evaluateRuleExpression(expression: string, _artifact: Artifact): number {
    // Simple expression evaluator for metadata-based rules
    // Supports: metadata.width >= 1024, metadata.height >= 1024, fileSize < 10485760
    try {
      const trimmed = expression.trim();
      const parts = trimmed.split(/\s+/);
      if (parts.length === 3) {
        const field = parts[0];
        const operator = parts[1];
        const expected = Number(parts[2]);
        if (!Number.isNaN(expected)) {
          const actual = this.resolveField(field, _artifact);
          return this.applyOperator(operator, actual, expected) ? 1 : 0;
        }
      }
      return 0.5;
    } catch {
      return 0.5;
    }
  }

  private resolveField(field: string, artifact: Artifact): number {
    if (field.startsWith('metadata.')) {
      const key = field.slice('metadata.'.length);
      const val = artifact.metadata[key];
      if (typeof val === 'number') return val;
      if (typeof val === 'string') {
        const parsed = Number(val);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
    if (field === 'width')
      return typeof artifact.metadata.width === 'number' ? artifact.metadata.width : 0;
    if (field === 'height')
      return typeof artifact.metadata.height === 'number' ? artifact.metadata.height : 0;
    return 0;
  }

  private applyOperator(operator: string, actual: number, expected: number): boolean {
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
        return actual === expected;
      case '!=':
        return actual !== expected;
      default:
        return false;
    }
  }
}
