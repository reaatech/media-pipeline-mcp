import type {
  CostLedger,
  EstimateWarning,
  PipelineDefinition,
  PipelineEstimate,
  StepEstimate,
} from './types/index.js';

export interface PipelineEstimatorOptions {
  ledger?: CostLedger;
  estimateOperation?: (
    operation: string,
    config: Record<string, unknown>,
  ) => Promise<{ usdLow: number; usdHigh: number } | null>;
}

export class PipelineEstimator {
  private ledger?: CostLedger;
  private estimateOperation?: (
    operation: string,
    config: Record<string, unknown>,
  ) => Promise<{ usdLow: number; usdHigh: number } | null>;

  constructor(options: PipelineEstimatorOptions = {}) {
    this.ledger = options.ledger;
    this.estimateOperation = options.estimateOperation;
  }

  async estimate(pipeline: PipelineDefinition): Promise<PipelineEstimate> {
    const perStep: StepEstimate[] = [];
    const warnings: EstimateWarning[] = [];

    for (const step of pipeline.steps) {
      let usdLow = 0.001;
      let usdHigh = 0.01;
      let estimable = true;
      let fallbackUsed: StepEstimate['fallbackUsed'] | undefined;
      const provider = 'unknown';
      const modelId = (step.config.model as string) ?? 'default';

      if (this.estimateOperation) {
        const opEst = await this.estimateOperation(step.operation, step.config);
        if (opEst !== null) {
          usdLow = opEst.usdLow;
          usdHigh = opEst.usdHigh;
        } else {
          estimable = false;
          fallbackUsed = 'default-bound';
          warnings.push({
            stepId: step.id,
            code: 'no-estimator',
            message: `No estimator available for operation '${step.operation}'`,
          });
        }
      } else {
        estimable = false;
        fallbackUsed = 'default-bound';
      }

      // Use historical costs if persistent store available
      if (!estimable && this.ledger) {
        try {
          const historical = await this.ledger.getTotalCost();
          if (historical > 0) {
            fallbackUsed = 'cached-stats';
          }
        } catch {
          // ignore if ledger fails
        }
      }

      // Check for router spread warning
      const route = (step as { route?: { candidates?: string[] } }).route;
      if (route?.candidates && route.candidates.length > 1) {
        warnings.push({
          stepId: step.id,
          code: 'router-spread',
          message: `Step '${step.id}' routes across ${route.candidates.length} candidates, estimates may vary`,
        });
      }

      // Check for prior-step dependency
      for (const inputVal of Object.values(step.inputs)) {
        if (
          typeof inputVal === 'string' &&
          inputVal.includes('{{') &&
          inputVal.includes('.output}}')
        ) {
          warnings.push({
            stepId: step.id,
            code: 'depends-on-prior-step',
            message: `Step '${step.id}' cost depends on variable output from prior step`,
          });
          break;
        }
      }

      perStep.push({
        stepId: step.id,
        operation: step.operation,
        provider,
        modelId,
        usdLow,
        usdHigh,
        estimable,
        ...(fallbackUsed ? { fallbackUsed } : {}),
      });
    }

    const totalUsdLow = perStep.reduce((s, e) => s + e.usdLow, 0);
    const totalUsdHigh = perStep.reduce((s, e) => s + e.usdHigh, 0);

    return { totalUsdLow, totalUsdHigh, perStep, warnings };
  }
}
