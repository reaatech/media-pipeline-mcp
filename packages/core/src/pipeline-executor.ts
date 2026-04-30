import { randomUUID } from 'node:crypto';
import { ArtifactRegistry } from './artifact-registry.js';
import { createQualityGateEvaluator } from './quality-gates/index.js';
import type {
  Artifact,
  CostRecord,
  Pipeline,
  PipelineDefinition,
  PipelineEvent,
  PipelineStep,
  QualityGateResult,
} from './types/index.js';

export interface Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  execute(
    operation: string,
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<{
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    cost_usd?: number;
    duration_ms?: number;
  }>;
  healthCheck(): Promise<boolean>;
}

export interface PipelineExecutorOptions {
  providers: Provider[];
  defaultPipelineTimeoutMs?: number;
  llmJudgeFn?: (
    prompt: string,
    artifact: Artifact,
  ) => Promise<{ pass: boolean; reasoning: string; score?: number }>;
  customCheckFn?: (
    artifact: Artifact,
    config: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  prepareInputs?: (
    operation: string,
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  persistArtifact?: (params: {
    artifactId: string;
    operation: string;
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    pipelineId: string;
    stepId: string;
  }) => Promise<{ uri?: string } | undefined>;
  onEvent?: (event: PipelineEvent) => void;
  onCost?: (record: CostRecord) => void;
}

export class PipelineExecutor {
  private registry: ArtifactRegistry;
  private providers: Map<string, Provider> = new Map();
  private readonly defaultPipelineTimeoutMs: number;
  private llmJudgeFn?: (
    prompt: string,
    artifact: Artifact,
  ) => Promise<{ pass: boolean; reasoning: string; score?: number }>;
  private customCheckFn?: (
    artifact: Artifact,
    config: Record<string, unknown>,
  ) => boolean | Promise<boolean>;
  private prepareInputs?: (
    operation: string,
    inputs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  private persistArtifact?: (params: {
    artifactId: string;
    operation: string;
    data?: Buffer | NodeJS.ReadableStream;
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    pipelineId: string;
    stepId: string;
  }) => Promise<{ uri?: string } | undefined>;
  private onEvent?: (event: PipelineEvent) => void;
  private onCost?: (record: CostRecord) => void;

  constructor(options: PipelineExecutorOptions) {
    this.registry = new ArtifactRegistry();
    this.defaultPipelineTimeoutMs = options.defaultPipelineTimeoutMs ?? 300000;
    this.llmJudgeFn = options.llmJudgeFn;
    this.customCheckFn = options.customCheckFn;
    this.prepareInputs = options.prepareInputs;
    this.persistArtifact = options.persistArtifact;

    for (const provider of options.providers) {
      for (const op of provider.supportedOperations) {
        this.providers.set(op, provider);
      }
    }

    this.onEvent = options.onEvent;
    this.onCost = options.onCost;
  }

  async execute(definition: PipelineDefinition): Promise<Pipeline> {
    const pipeline: Pipeline = {
      id: definition.id,
      steps: definition.steps,
      status: 'running',
      artifacts: new Map(),
      completedSteps: [],
      startedAt: new Date().toISOString(),
    };

    this.emitEvent({
      type: 'pipeline:start',
      pipelineId: pipeline.id,
      timestamp: new Date().toISOString(),
    });

    const pipelineTimeout = setTimeout(() => {
      if (pipeline.status === 'running') {
        pipeline.status = 'failed';
        pipeline.failedStep = pipeline.currentStep;
        this.emitEvent({
          type: 'pipeline:failed',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
          data: { reason: 'Pipeline timeout exceeded' },
        });
      }
    }, this.defaultPipelineTimeoutMs);

    try {
      for (let stepIndex = 0; stepIndex < pipeline.steps.length; stepIndex++) {
        const step = pipeline.steps[stepIndex];
        pipeline.currentStep = step.id;

        const result = await this.executeStep(step, pipeline);

        if (pipeline.status === 'failed') {
          break;
        }

        if (result.status === 'failed') {
          pipeline.status = 'failed';
          pipeline.failedStep = step.id;
          this.emitEvent({
            type: 'pipeline:failed',
            pipelineId: pipeline.id,
            stepId: step.id,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        if (result.status === 'gated') {
          pipeline.status = 'gated';
          pipeline.gatedStep = step.id;
          this.emitEvent({
            type: 'pipeline:gated',
            pipelineId: pipeline.id,
            stepId: step.id,
            timestamp: new Date().toISOString(),
          });
          break;
        }

        // Add artifact to pipeline
        if (result.artifact) {
          pipeline.artifacts.set(result.artifact.id, result.artifact);
        }

        pipeline.completedSteps.push(step.id);
      }

      if (pipeline.status === 'running') {
        pipeline.status = 'completed';
        this.emitEvent({
          type: 'pipeline:complete',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      pipeline.status = 'failed';
      pipeline.failedStep = pipeline.currentStep;
      this.emitEvent({
        type: 'pipeline:failed',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
      });
    } finally {
      clearTimeout(pipelineTimeout);
      pipeline.completedAt = new Date().toISOString();
      pipeline.currentStep = undefined;
    }

    return pipeline;
  }

  async resume(pipeline: Pipeline, action: 'retry' | 'skip' | 'abort'): Promise<Pipeline> {
    if (pipeline.status !== 'gated' && pipeline.status !== 'failed') {
      throw new Error(`Cannot resume pipeline with status: ${pipeline.status}`);
    }

    if (action === 'abort') {
      pipeline.status = 'failed';
      pipeline.completedAt = new Date().toISOString();
      return pipeline;
    }

    const resumeStepId = pipeline.status === 'gated' ? pipeline.gatedStep : pipeline.failedStep;
    const resumeStepLabel = pipeline.status === 'gated' ? 'gated' : 'failed';
    const resumeStepIndex = pipeline.steps.findIndex((s) => s.id === resumeStepId);

    if (!resumeStepId || resumeStepIndex === -1) {
      throw new Error(
        `${resumeStepLabel[0].toUpperCase() + resumeStepLabel.slice(1)} step not found`,
      );
    }

    if (action === 'skip') {
      const resumeStep = pipeline.steps[resumeStepIndex];
      if (!pipeline.completedSteps.includes(resumeStep.id)) {
        pipeline.completedSteps.push(resumeStep.id);
      }
      pipeline.status = 'running';
      pipeline.gatedStep = undefined;
      pipeline.failedStep = undefined;

      // Continue with remaining steps
      for (let i = resumeStepIndex + 1; i < pipeline.steps.length; i++) {
        const step = pipeline.steps[i];
        pipeline.currentStep = step.id;

        const result = await this.executeStep(step, pipeline);

        if (result.status === 'failed') {
          pipeline.status = 'failed';
          pipeline.failedStep = step.id;
          break;
        }

        if (result.status === 'gated') {
          pipeline.status = 'gated';
          pipeline.gatedStep = step.id;
          break;
        }

        if (result.artifact) {
          pipeline.artifacts.set(result.artifact.id, result.artifact);
        }

        pipeline.completedSteps.push(step.id);
      }

      if (pipeline.status === 'running') {
        pipeline.status = 'completed';
      }
    } else if (action === 'retry') {
      // Re-execute the gated step
      const step = pipeline.steps[resumeStepIndex];

      // Remove previous artifact
      const existingArtifact = this.registry.findBySourceStep(step.id);
      if (existingArtifact) {
        this.registry.delete(existingArtifact.id);
        pipeline.artifacts.delete(existingArtifact.id);
      }

      // Remove completed steps after the gated step
      const stepsAfterGate = pipeline.completedSteps.filter((s) => {
        const index = pipeline.steps.findIndex((ps) => ps.id === s);
        return index >= resumeStepIndex;
      });

      pipeline.completedSteps = pipeline.completedSteps.filter((s) => !stepsAfterGate.includes(s));

      // Re-execute from gated step
      pipeline.status = 'running';
      pipeline.gatedStep = undefined;
      pipeline.failedStep = undefined;

      for (let i = resumeStepIndex; i < pipeline.steps.length; i++) {
        const currentStep = pipeline.steps[i];
        pipeline.currentStep = currentStep.id;

        const result = await this.executeStep(currentStep, pipeline);

        if (result.status === 'failed') {
          pipeline.status = 'failed';
          pipeline.failedStep = currentStep.id;
          break;
        }

        if (result.status === 'gated') {
          pipeline.status = 'gated';
          pipeline.gatedStep = currentStep.id;
          break;
        }

        if (result.artifact) {
          pipeline.artifacts.set(result.artifact.id, result.artifact);
        }

        if (!pipeline.completedSteps.includes(currentStep.id)) {
          pipeline.completedSteps.push(currentStep.id);
        }
      }

      if (pipeline.status === 'running') {
        pipeline.status = 'completed';
      }
    }

    pipeline.completedAt = new Date().toISOString();
    pipeline.currentStep = undefined;

    return pipeline;
  }

  private async executeStep(
    step: PipelineStep,
    pipeline: Pipeline,
  ): Promise<{
    status: 'completed' | 'failed' | 'gated';
    artifact?: Artifact;
  }> {
    const maxRetries =
      step.qualityGate?.action === 'retry' ? (step.qualityGate.maxRetries ?? 1) : 0;
    let lastResult: { status: 'completed' | 'failed' | 'gated'; artifact?: Artifact } | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        this.registry.deleteBySourceStep(step.id);
        this.emitEvent({
          type: 'step:retry',
          pipelineId: pipeline.id,
          stepId: step.id,
          timestamp: new Date().toISOString(),
          data: { attempt: attempt + 1, maxRetries },
        });
      }

      this.emitEvent({
        type: 'step:start',
        pipelineId: pipeline.id,
        stepId: step.id,
        timestamp: new Date().toISOString(),
        data: { attempt: attempt + 1 },
      });

      try {
        const result = await this.executeStepOnce(step, pipeline);

        if (!result) {
          return { status: 'failed' };
        }

        // Run quality gate if configured
        if (step.qualityGate) {
          const gateResult = await this.evaluateQualityGate(step.qualityGate, result.artifact);

          if (!gateResult.passed) {
            if (gateResult.action === 'fail') {
              this.emitEvent({
                type: 'step:failed',
                pipelineId: pipeline.id,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                data: { reason: gateResult.reasoning },
              });
              return { status: 'failed', artifact: result.artifact };
            }

            if (gateResult.action === 'retry' && attempt < maxRetries) {
              this.emitEvent({
                type: 'step:gated',
                pipelineId: pipeline.id,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                data: { reason: gateResult.reasoning, willRetry: true },
              });
              lastResult = { status: 'completed', artifact: result.artifact };
              continue; // Retry
            }

            if (gateResult.action === 'retry' && attempt >= maxRetries) {
              this.emitEvent({
                type: 'step:gated',
                pipelineId: pipeline.id,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                data: { reason: gateResult.reasoning, maxRetriesExceeded: true },
              });
              return { status: 'gated', artifact: result.artifact };
            }

            if (gateResult.action === 'warn') {
              console.warn(`Quality gate warning for step ${step.id}: ${gateResult.reasoning}`);
            }
          }
        }

        this.emitEvent({
          type: 'step:complete',
          pipelineId: pipeline.id,
          stepId: step.id,
          timestamp: new Date().toISOString(),
          data: { artifactId: result.artifact.id },
        });

        return { status: 'completed', artifact: result.artifact };
      } catch (error) {
        this.emitEvent({
          type: 'step:failed',
          pipelineId: pipeline.id,
          stepId: step.id,
          timestamp: new Date().toISOString(),
          data: { error: error instanceof Error ? error.message : 'Unknown error' },
        });

        if (attempt < maxRetries) {
          continue; // Retry on error
        }

        return { status: 'failed' };
      }
    }

    return lastResult ?? { status: 'failed' };
  }

  private async executeStepOnce(
    step: PipelineStep,
    pipeline: Pipeline,
  ): Promise<{ artifact: Artifact } | null> {
    // Resolve inputs
    const resolvedInputs = await this.resolveInputs(step.inputs);

    // Find provider
    const provider = this.providers.get(step.operation);
    if (!provider) {
      throw new Error(`No provider available for operation: ${step.operation}`);
    }

    // Execute
    const providerInputs = this.prepareInputs
      ? await this.prepareInputs(step.operation, resolvedInputs)
      : resolvedInputs;
    const result = await provider.execute(step.operation, providerInputs, step.config);

    const artifactId = randomUUID();
    const persisted = this.persistArtifact
      ? await this.persistArtifact({
          artifactId,
          operation: step.operation,
          data: result.data,
          artifact: {
            ...result.artifact,
            sourceStep: step.id,
          },
          pipelineId: pipeline.id,
          stepId: step.id,
        })
      : undefined;

    // Register artifact
    const artifact = this.registry.registerWithId(artifactId, {
      ...result.artifact,
      uri: persisted?.uri ?? result.artifact.uri,
      sourceStep: step.id,
    });

    // Record cost
    if (result.cost_usd !== undefined) {
      this.onCost?.({
        operation: step.operation,
        provider: provider.name,
        model: step.config.model as string | undefined,
        cost_usd: result.cost_usd,
        artifactId: artifact.id,
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
      });
    }

    return { artifact };
  }

  private async resolveInputs(inputSpec: Record<string, string>): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(inputSpec)) {
      // Check for artifact reference
      const match = value.match(/^\{\{(\w+)\.output\}\}$/);
      if (match) {
        const stepId = match[1];
        const artifact = this.registry.findBySourceStep(stepId);

        if (!artifact) {
          throw new Error(`Artifact not found for step '${stepId}' referenced in input '${key}'`);
        }

        resolved[key] = artifact.id;
      } else {
        // Literal value
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private async evaluateQualityGate(
    _gate: import('./types/index.js').QualityGate,
    artifact: Artifact,
  ): Promise<QualityGateResult> {
    const evaluator = createQualityGateEvaluator(_gate, this.llmJudgeFn, this.customCheckFn);
    return await evaluator.evaluate(_gate, artifact);
  }

  private emitEvent(event: PipelineEvent) {
    this.onEvent?.(event);
  }

  getRegistry(): ArtifactRegistry {
    return this.registry;
  }
}
