import { randomUUID } from 'node:crypto';
import { ArtifactRegistry } from './artifact-registry.js';
import {
  ArtifactNotFoundError,
  BudgetExceededError,
  LoudnessGateFailedError,
  RunInProgressError,
  RunNotResumableError,
  SafetyGateRejectedError,
} from './errors.js';
import { createQualityGateEvaluator } from './quality-gates/index.js';
import type {
  Artifact,
  BudgetConfig,
  CostLedger,
  CostRecord,
  Pipeline,
  PipelineDefinition,
  PipelineEstimate,
  PipelineEvent,
  PipelineRunRecord,
  PipelineStateStore,
  PipelineStep,
  QualityGateResult,
  RunContext,
  StepStateRecord,
} from './types/index.js';

// S3: legacy → spec-canonical event-name map. Both forms are valid (see
// PipelineEventTypeSchema). step:retry has no §0.1 equivalent and is not aliased.
const LEGACY_TO_SPEC_EVENT: Partial<Record<PipelineEvent['type'], PipelineEvent['type']>> = {
  'pipeline:start': 'run-started',
  'pipeline:complete': 'run-completed',
  'pipeline:failed': 'run-failed',
  'pipeline:gated': 'run-suspended',
  'step:start': 'step-started',
  'step:complete': 'step-completed',
  'step:failed': 'step-failed',
  'step:gated': 'step-gated',
};

// ─── Injection callback types for Phase 2 features ──────────────────────────
// These are injected via PipelineExecutorOptions to avoid circular deps
// between @reaatech/media-pipeline-mcp-core and the feature packages.

export interface RouteStepParams {
  route: unknown;
  operation: string;
  resolvedInputs: Record<string, unknown>;
  stepConfig: Record<string, unknown>;
  pipelineId: string;
  stepId: string;
  getProviderByName: (name: string) => Provider | undefined;
}

export type RouteStepFn = (
  params: RouteStepParams,
) => Promise<{ artifact: Artifact; providerName: string } | null>;

export interface VariantsStepParams {
  variants: unknown;
  step: PipelineStep;
  resolvedInputs: Record<string, unknown>;
  pipelineId: string;
  stepId: string;
}

export type VariantsStepFn = (params: VariantsStepParams) => Promise<{ artifact: Artifact } | null>;

export interface RatiosStepParams {
  ratios: unknown;
  operation: string;
  resolvedInputs: Record<string, unknown>;
  stepConfig: Record<string, unknown>;
  stepId: string;
}

export type RatiosStepFn = (params: RatiosStepParams) => Promise<{ artifact: Artifact } | null>;

export interface GateEvalParams {
  gate: unknown;
  artifact: Artifact;
  artifactUri: string;
  stepId: string;
}

export type GateEvalFn = (
  params: GateEvalParams,
) => Promise<{ passed: boolean; action: string; resultArtifact?: Artifact } | null>;

export interface ContextResolveParams {
  inputs: Record<string, unknown>;
  context: RunContext;
  providerName: string;
}

export type ContextResolveFn = (params: ContextResolveParams) => Record<string, unknown>;

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
  /**
   * F4/F5 estimateCost — optional on the executor's narrow Provider shape because legacy
   * mock providers may not implement it. Real providers (MediaProvider subclasses) all do.
   * Returns a CostEstimate-like value the executor uses for budget preflight + dry-run.
   */
  estimateCost?(input: {
    operation: string;
    params: Record<string, unknown>;
    config: Record<string, unknown>;
  }): Promise<{ costUsd: number; estimatedDurationMs?: number }>;
}

export interface PipelineExecutorOptions {
  providers: Provider[];
  defaultPipelineTimeoutMs?: number;
  defaultStepTimeoutMs?: number;
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
  persistence?: PipelineStateStore;
  ledger?: CostLedger;
  // Phase 2: F8 — route-based provider selection
  routeStepFn?: RouteStepFn;
  // Phase 2: F9 — variants execution
  variantsStepFn?: VariantsStepFn;
  // Phase 2: F11 — ratio fan-out
  ratiosStepFn?: RatiosStepFn;
  // Phase 2: F13 — run context resolution
  context?: RunContext;
  contextResolveFn?: ContextResolveFn;
  // Phase 2: F14 — loudness gate evaluation
  gateEvalFn?: GateEvalFn;
  // Phase 2: F18 — per-tenant allow-list enforcement. Called before each step's
  // provider dispatch; throws TenantPolicyViolationError when the active tenant
  // is not permitted to use the selected provider/model.
  tenantPolicyEnforceFn?: (provider: string | undefined, model: string | undefined) => void;
  // Phase 2: F17 — C2PA provenance signing.
  // The callback receives the artifactId AND the run context needed to assemble a
  // real C2PA manifest: runId, pipelineDefHash, the step that produced this artifact,
  // and any upstream artifact ingredients. The previous signature (artifactId only)
  // forced the callback to assemble a manifest with empty runId/pipelineDefHash —
  // those then ended up in every "signed" manifest, defeating the audit-trail purpose.
  signProvenance?: (params: {
    artifactId: string;
    runId: string;
    pipelineDefHash: string;
    stepId: string;
    operation: string;
    providerId: string;
    modelId?: string;
    /** Upstream artifact ids that fed into this step. Become C2PA ingredients. */
    ingredientArtifactIds?: string[];
  }) => Promise<{ signedArtifactId: string; manifestUri: string }>;
}

export function createStepStateRecord(
  stepId: string,
  status?: StepStateRecord['status'],
): StepStateRecord {
  return { stepId, status: status ?? 'pending', attempts: 0 };
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
  private persistence?: PipelineStateStore;
  private ledger?: CostLedger;
  private routeStepFn?: RouteStepFn;
  private variantsStepFn?: VariantsStepFn;
  private ratiosStepFn?: RatiosStepFn;
  private context?: RunContext;
  private contextResolveFn?: ContextResolveFn;
  private gateEvalFn?: GateEvalFn;
  private tenantPolicyEnforceFn?: (provider: string | undefined, model: string | undefined) => void;
  private signProvenance?: PipelineExecutorOptions['signProvenance'];

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
    this.persistence = options.persistence;
    this.ledger = options.ledger;
    this.routeStepFn = options.routeStepFn;
    this.variantsStepFn = options.variantsStepFn;
    this.ratiosStepFn = options.ratiosStepFn;
    this.context = options.context;
    this.contextResolveFn = options.contextResolveFn;
    this.gateEvalFn = options.gateEvalFn;
    this.tenantPolicyEnforceFn = options.tenantPolicyEnforceFn;
    this.signProvenance = options.signProvenance;
  }

  async execute(definition: PipelineDefinition, options?: { runId?: string }): Promise<Pipeline> {
    const pipeline: Pipeline = {
      id: definition.id,
      steps: definition.steps,
      status: 'running',
      artifacts: new Map(),
      completedSteps: [],
      startedAt: new Date().toISOString(),
    };

    // Initialize step states for persistence
    const stepStates: StepStateRecord[] = definition.steps.map((s) =>
      createStepStateRecord(s.id, 'pending'),
    );

    // F1 ties the idempotency-stored runId to the actual pipeline run. When the caller
    // (server middleware) already minted a runId for the in-flight idempotency cache
    // entry, reuse it so a future pipeline.resume(runId) hits the same persisted run.
    // Falling back to randomUUID preserves the legacy behavior for direct callers.
    const runId = options?.runId ?? randomUUID();

    // F17: hash the pipeline definition so every manifest signed during this run
    // references the same audit identity. Persists for the duration of execute().
    this.currentPipelineDefHash = this.hashPipelineDefinition(definition);
    const budget: BudgetConfig | undefined = (definition as { budget?: BudgetConfig }).budget;
    let runCost = 0;

    // Persist run if store configured
    if (this.persistence) {
      const runRecord: PipelineRunRecord = {
        runId,
        pipelineId: definition.id,
        status: 'running',
        definition,
        stepStates,
        artifacts: {},
        totalCostUsd: 0,
        startedAt: pipeline.startedAt ?? new Date().toISOString(),
        resumable: definition.resumable ?? true,
      };
      await this.persistence.createRun(runRecord);
    }

    this.emitEvent({
      type: 'pipeline:start',
      pipelineId: pipeline.id,
      timestamp: new Date().toISOString(),
      data: { runId },
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

        // Budget preflight
        if (budget) {
          stepStates[stepIndex].status = 'running';
          await this.updateRunState(runId, stepStates);
          const estimate = await this.quickEstimateStep(step, budget);
          if (runCost + estimate.usdHigh > budget.maxUsd) {
            if (budget.onExceed === 'abort') {
              throw new BudgetExceededError(runCost + estimate.usdHigh, budget.maxUsd, 'run');
            }
            // suspend
            pipeline.status = 'gated';
            pipeline.gatedStep = step.id;
            stepStates[stepIndex].status = 'gated';
            await this.updateRunState(runId, stepStates, runCost);
            this.emitEvent({
              type: 'pipeline:gated',
              pipelineId: pipeline.id,
              stepId: step.id,
              timestamp: new Date().toISOString(),
              data: {
                reason: `Budget preflight: $${estimate.usdHigh} would exceed $${budget.maxUsd}`,
              },
            });
            break;
          }
        }

        const result = await this.executeStep(step, pipeline);

        if (pipeline.status === 'failed') {
          stepStates[stepIndex].status = 'failed';
          await this.updateRunState(runId, stepStates, runCost);
          break;
        }

        if (result.status === 'failed') {
          pipeline.status = 'failed';
          pipeline.failedStep = step.id;
          stepStates[stepIndex].status = 'failed';
          await this.updateRunState(runId, stepStates, runCost);
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
          stepStates[stepIndex].status = 'gated';
          await this.updateRunState(runId, stepStates, runCost);
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

        stepStates[stepIndex].status = 'completed';
        stepStates[stepIndex].artifactId = result.artifact?.id;
        pipeline.completedSteps.push(step.id);

        // F4: accumulate per-step cost into runCost and emit warn-threshold event
        // when the cumulative cost crosses `warnAtPct × maxUsd`. The threshold fires
        // once per crossing — we suppress repeated emissions by tracking the prior
        // value before increment.
        const stepCost = result.costUsd ?? 0;
        if (stepCost > 0) {
          const prior = runCost;
          runCost += stepCost;
          if (budget) {
            const warnAtPct = budget.warnAtPct ?? 0.8;
            const threshold = warnAtPct * budget.maxUsd;
            if (prior < threshold && runCost >= threshold) {
              this.emitEvent({
                type: 'step-progress',
                pipelineId: pipeline.id,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                data: {
                  budgetWarning: true,
                  costUsdAccrued: runCost,
                  warnAtPct,
                  maxUsd: budget.maxUsd,
                },
              });
            }
          }
        }
      }

      if (pipeline.status === 'running') {
        pipeline.status = 'completed';
        await this.updateRunState(runId, stepStates, runCost, 'completed');
        this.emitEvent({
          type: 'pipeline:complete',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      pipeline.status = 'failed';
      pipeline.failedStep = pipeline.currentStep;
      await this.updateRunState(runId, stepStates, runCost, 'failed', error);
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

  // ─── Resume overloads for backward compatibility ────────────────────────
  // resume(runId, fromStepId?)  – new F3 persistence-based resume
  // resume(pipeline, action)    – old legacy resume

  async resume(runId: string, fromStepId?: string): Promise<Pipeline>;
  async resume(pipeline: Pipeline, action: 'retry' | 'skip' | 'abort'): Promise<Pipeline>;
  async resume(
    first: string | Pipeline,
    second?: string | 'retry' | 'skip' | 'abort',
  ): Promise<Pipeline> {
    if (typeof first === 'string') {
      return this.resumeByRunId(first, second as string | undefined);
    }
    return this.resumeLegacy(first, second as 'retry' | 'skip' | 'abort');
  }

  private async resumeByRunId(runId: string, fromStepId?: string): Promise<Pipeline> {
    if (!this.persistence) {
      throw new Error('Persistence store required for resume');
    }

    const acquired = await this.persistence.acquireLock(runId);
    if (!acquired) {
      throw new RunInProgressError();
    }

    try {
      const run = await this.persistence.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.status === 'completed' || run.status === 'cancelled') {
        throw new RunNotResumableError();
      }

      if (run.resumable === false) {
        throw new RunNotResumableError();
      }

      const pipeline: Pipeline = {
        id: run.pipelineId,
        steps: run.definition.steps,
        status: 'running',
        artifacts: new Map(),
        completedSteps: [],
        startedAt: new Date().toISOString(),
      };

      const stepStates = [...run.stepStates];
      const runCost = run.totalCostUsd;
      const budget: BudgetConfig | undefined = (run.definition as { budget?: BudgetConfig }).budget;
      // F17: re-derive the pipeline definition hash so resumed-step manifests share
      // the same audit identity as the original run.
      this.currentPipelineDefHash = this.hashPipelineDefinition(run.definition);

      // Build artifact registry from run artifacts
      for (const [stepId, artifactId] of Object.entries(run.artifacts)) {
        const step = run.definition.steps.find((s) => s.id === stepId);
        if (step) {
          const art: Artifact = {
            id: artifactId,
            type: 'image',
            uri: `run://${runId}/${artifactId}`,
            mimeType: 'application/octet-stream',
            metadata: {},
            sourceStep: stepId,
            createdAt: new Date().toISOString(),
          };
          this.registry.registerWithId(artifactId, art);
          pipeline.artifacts.set(artifactId, art);
        }
      }

      // Determine start index
      const startStepIndex = fromStepId
        ? run.definition.steps.findIndex((s) => s.id === fromStepId)
        : run.stepStates.findIndex(
            (s) => s.status !== 'completed' && s.status !== 'skipped' && s.status !== 'cached',
          );

      if (startStepIndex === -1) {
        pipeline.status = 'completed';
        return pipeline;
      }

      // Mark earlier steps as completed
      for (let i = 0; i < startStepIndex; i++) {
        if (stepStates[i].status !== 'completed') {
          stepStates[i].status = 'skipped';
        }
        if (stepStates[i].artifactId) {
          pipeline.completedSteps.push(run.definition.steps[i].id);
        }
      }

      // Reset attempts for resumed failed/gated steps
      for (let i = startStepIndex; i < stepStates.length; i++) {
        stepStates[i].attempts = 0;
      }

      await this.persistence.updateRun(runId, {
        status: 'running',
        stepStates,
      });

      // Execute from startStepIndex
      for (let i = startStepIndex; i < run.definition.steps.length; i++) {
        const step = run.definition.steps[i];
        pipeline.currentStep = step.id;

        // Skip already completed/cached steps
        if (stepStates[i].status === 'completed' || stepStates[i].status === 'cached') {
          pipeline.completedSteps.push(step.id);
          continue;
        }

        // Budget preflight
        if (budget) {
          stepStates[i].status = 'running';
          await this.persistence.updateRun(runId, { stepStates });
          const estimate = await this.quickEstimateStep(step, budget);
          if (runCost + estimate.usdHigh > budget.maxUsd) {
            if (budget.onExceed === 'abort') {
              throw new BudgetExceededError(runCost + estimate.usdHigh, budget.maxUsd, 'run');
            }
            pipeline.status = 'gated';
            pipeline.gatedStep = step.id;
            stepStates[i].status = 'gated';
            await this.persistence.updateRun(runId, {
              status: 'gated',
              stepStates,
              totalCostUsd: runCost,
            });
            break;
          }
        }

        const result = await this.executeStep(step, pipeline);

        if (result.status === 'failed') {
          pipeline.status = 'failed';
          pipeline.failedStep = step.id;
          stepStates[i].status = 'failed';
          await this.persistence.updateRun(runId, {
            status: 'failed',
            stepStates,
            totalCostUsd: runCost,
          });
          break;
        }

        if (result.status === 'gated') {
          pipeline.status = 'gated';
          pipeline.gatedStep = step.id;
          stepStates[i].status = 'gated';
          await this.persistence.updateRun(runId, {
            status: 'gated',
            stepStates,
            totalCostUsd: runCost,
          });
          break;
        }

        if (result.artifact) {
          pipeline.artifacts.set(result.artifact.id, result.artifact);
        }

        stepStates[i].status = 'completed';
        stepStates[i].artifactId = result.artifact?.id;
        pipeline.completedSteps.push(step.id);
      }

      if (pipeline.status === 'running') {
        pipeline.status = 'completed';
        await this.persistence.updateRun(runId, {
          status: 'completed',
          stepStates,
          totalCostUsd: runCost,
          completedAt: new Date().toISOString(),
          error: undefined,
        });
      }

      pipeline.completedAt = new Date().toISOString();
      pipeline.currentStep = undefined;
      return pipeline;
    } finally {
      await this.persistence.releaseLock(runId);
    }
  }

  private async resumeLegacy(
    pipeline: Pipeline,
    action: 'retry' | 'skip' | 'abort',
  ): Promise<Pipeline> {
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
      const step = pipeline.steps[resumeStepIndex];

      const existingArtifact = this.registry.findBySourceStep(step.id);
      if (existingArtifact) {
        this.registry.delete(existingArtifact.id);
        pipeline.artifacts.delete(existingArtifact.id);
      }

      const stepsAfterGate = pipeline.completedSteps.filter((s) => {
        const index = pipeline.steps.findIndex((ps) => ps.id === s);
        return index >= resumeStepIndex;
      });

      pipeline.completedSteps = pipeline.completedSteps.filter((s) => !stepsAfterGate.includes(s));

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

  async estimate(definition: PipelineDefinition): Promise<PipelineEstimate> {
    const perStep: import('./types/index.js').StepEstimate[] = [];
    const warnings: import('./types/index.js').EstimateWarning[] = [];

    for (const step of definition.steps) {
      const provider = this.providers.get(step.operation);
      if (!provider) {
        warnings.push({
          stepId: step.id,
          code: 'no-estimator',
          message: `No provider available for operation '${step.operation}'`,
        });
        perStep.push({
          stepId: step.id,
          operation: step.operation,
          provider: 'unknown',
          modelId: (step.config as { model?: string } | undefined)?.model ?? 'default',
          usdLow: 0,
          usdHigh: 0.01,
          estimable: false,
          fallbackUsed: 'default-bound',
        });
        continue;
      }

      const estimate = await this.quickEstimateStep(step);
      const stepEntry: import('./types/index.js').StepEstimate = {
        stepId: step.id,
        operation: step.operation,
        provider: provider.name,
        modelId: (step.config as { model?: string } | undefined)?.model ?? 'default',
        usdLow: estimate.usdLow,
        usdHigh: estimate.usdHigh,
        estimable: estimate.estimable,
      };
      if (!estimate.estimable) {
        stepEntry.fallbackUsed = 'default-bound';
        warnings.push({
          stepId: step.id,
          code: 'no-estimator',
          message: `Provider '${provider.name}' did not return an estimate for '${step.operation}'`,
        });
      }
      // F5: flag variable-output ops so callers know the high band is `max_tokens × rate`.
      const maxTokens = (step.inputs as Record<string, unknown>)?.max_tokens;
      if (typeof maxTokens === 'number' && maxTokens > 0) {
        warnings.push({
          stepId: step.id,
          code: 'variable-output',
          message: `Step '${step.id}' has variable output (max_tokens=${maxTokens}); usdLow uses ~30% of cap, usdHigh uses 100%`,
        });
      }
      perStep.push(stepEntry);

      // Check for router spread warning
      const stepRoute = (step as { route?: { candidates?: unknown[] } }).route;
      if (stepRoute?.candidates && stepRoute.candidates.length > 1) {
        warnings.push({
          stepId: step.id,
          code: 'router-spread',
          message: `Step '${step.id}' routes across ${stepRoute.candidates.length} candidates, estimates may vary`,
        });
      }

      // Check for prior-step dependency (cost depends on previous step output)
      for (const inputVal of Object.values(step.inputs)) {
        if (inputVal.includes('{{') && inputVal.includes('.output}}')) {
          warnings.push({
            stepId: step.id,
            code: 'depends-on-prior-step',
            message: `Step '${step.id}' cost depends on variable output from prior step`,
          });
          break;
        }
      }
    }

    const totalUsdLow = perStep.reduce((s, e) => s + e.usdLow, 0);
    const totalUsdHigh = perStep.reduce((s, e) => s + e.usdHigh, 0);

    return { totalUsdLow, totalUsdHigh, perStep, warnings };
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private async updateRunState(
    runId: string,
    stepStates: StepStateRecord[],
    totalCostUsd?: number,
    status?: string,
    error?: unknown,
  ): Promise<void> {
    if (!this.persistence) return;
    const patch: Record<string, unknown> = { stepStates };
    if (totalCostUsd !== undefined) patch.totalCostUsd = totalCostUsd;
    if (status) patch.status = status;
    if (error) patch.error = error instanceof Error ? error.message : 'Unknown error';
    await this.persistence.updateRun(
      runId,
      patch as Parameters<typeof this.persistence.updateRun>[1],
    );
  }

  /**
   * Estimate the per-step cost band for budget preflight (F4) and dry-run (F5).
   *
   * Calls `provider.estimateCost` when available — that's what the spec wants, and
   * what makes preflight actually enforce caps against real pricing.
   *
   * When the provider doesn't implement estimateCost (legacy mocks, certain test fakes),
   * falls back to a tiny default band so preflight doesn't catastrophically block.
   * Variable-output ops widen the high band: when max_tokens is present, treat low as
   * ~30% of max and high as 100% per plan §F5.
   */
  private async quickEstimateStep(
    step: PipelineStep,
    _budget?: BudgetConfig,
  ): Promise<{
    usdLow: number;
    usdHigh: number;
    estimable: boolean;
    estimatedDurationMs?: number;
  }> {
    const provider = this.providers.get(step.operation);
    if (!provider) {
      return { usdLow: 0, usdHigh: 0.01, estimable: false };
    }
    if (typeof provider.estimateCost !== 'function') {
      // Legacy provider without estimator — best-effort band; budget caps may overshoot.
      return { usdLow: 0.001, usdHigh: 0.01, estimable: false };
    }

    try {
      const est = await provider.estimateCost({
        operation: step.operation,
        params: step.inputs as Record<string, unknown>,
        config: (step.config ?? {}) as Record<string, unknown>,
      });
      const baseHigh = est.costUsd;
      const maxTokens = (step.inputs as Record<string, unknown>)?.max_tokens;
      const isVariableOutput = typeof maxTokens === 'number' && maxTokens > 0;
      return {
        usdLow: isVariableOutput ? baseHigh * 0.3 : baseHigh,
        usdHigh: baseHigh,
        estimable: true,
        estimatedDurationMs: est.estimatedDurationMs,
      };
    } catch {
      return { usdLow: 0.001, usdHigh: 0.01, estimable: false };
    }
  }

  private async executeStep(
    step: PipelineStep,
    pipeline: Pipeline,
  ): Promise<{
    status: 'completed' | 'failed' | 'gated';
    artifact?: Artifact;
    /** Per-step cost (F4 accumulation). Undefined when provider didn't report a cost. */
    costUsd?: number;
  }> {
    const maxRetries =
      step.qualityGate?.action === 'retry' ? (step.qualityGate.maxRetries ?? 1) : 0;
    let lastResult: {
      status: 'completed' | 'failed' | 'gated';
      artifact?: Artifact;
      costUsd?: number;
    } | null = null;

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
              continue;
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

        // Run additional gates array if configured
        const gates = (step as { gates?: Array<{ type?: string }> }).gates;
        if (gates && gates.length > 0) {
          for (const gate of gates) {
            // F16: Handle safety gate via injected callback
            if (gate.type === 'safety' && this.gateEvalFn) {
              const gateResult = await this.gateEvalFn({
                gate,
                artifact: result.artifact,
                artifactUri: result.artifact.uri,
                stepId: step.id,
              });
              if (gateResult) {
                if (!gateResult.passed) {
                  const safetyResult = gateResult as typeof gateResult & {
                    reasoning?: string;
                    score?: number;
                  };
                  if (gateResult.action === 'fail') {
                    throw new SafetyGateRejectedError(
                      safetyResult.reasoning ?? 'csam',
                      safetyResult.score ?? 0,
                    );
                  }
                  this.emitEvent({
                    type: 'step:gated',
                    pipelineId: pipeline.id,
                    stepId: step.id,
                    timestamp: new Date().toISOString(),
                    data: { reason: `Safety gate rejected: ${safetyResult.reasoning}` },
                  });
                  return { status: 'gated', artifact: result.artifact };
                }
                continue;
              }
            }

            // F14: Handle loudness gate via injected callback
            if (gate.type === 'loudness' && this.gateEvalFn) {
              const gateResult = await this.gateEvalFn({
                gate,
                artifact: result.artifact,
                artifactUri: result.artifact.uri,
                stepId: step.id,
              });

              if (gateResult) {
                if (!gateResult.passed) {
                  if (gateResult.action === 'fail') {
                    throw new LoudnessGateFailedError();
                  }
                  this.emitEvent({
                    type: 'step:gated',
                    pipelineId: pipeline.id,
                    stepId: step.id,
                    timestamp: new Date().toISOString(),
                    data: { reason: 'Loudness gate failed' },
                  });
                  return { status: 'gated', artifact: result.artifact };
                }
                if (gateResult.resultArtifact) {
                  // Replace artifact with normalized version
                  return { status: 'completed', artifact: gateResult.resultArtifact };
                }
                // Passed or warn
                continue;
              }
            }

            const gateResult = await this.evaluateQualityGate(
              gate as import('./types/index.js').QualityGate,
              result.artifact,
            );
            if (!gateResult.passed) {
              this.emitEvent({
                type: 'step:gated',
                pipelineId: pipeline.id,
                stepId: step.id,
                timestamp: new Date().toISOString(),
                data: { reason: `Additional gate failed: ${gateResult.reasoning}` },
              });
              return { status: 'gated', artifact: result.artifact };
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

        return { status: 'completed', artifact: result.artifact, costUsd: result.costUsd };
      } catch (error) {
        this.emitEvent({
          type: 'step:failed',
          pipelineId: pipeline.id,
          stepId: step.id,
          timestamp: new Date().toISOString(),
          data: { error: error instanceof Error ? error.message : 'Unknown error' },
        });

        if (attempt < maxRetries) {
          continue;
        }

        return { status: 'failed' };
      }
    }

    return lastResult ?? { status: 'failed' };
  }

  private async executeStepOnce(
    step: PipelineStep,
    pipeline: Pipeline,
  ): Promise<{ artifact: Artifact; costUsd?: number } | null> {
    let resolvedInputs = await this.resolveInputs(step.inputs);
    const stepExt = step as PipelineStep & {
      contextRefs?: unknown;
      route?: unknown;
      variants?: unknown;
      ratios?: unknown;
      cache?: { mode?: string; ttlSeconds?: number };
    };

    // F13: Context resolution
    if (this.contextResolveFn && this.context && stepExt.contextRefs) {
      const providerName = this.providers.get(step.operation)?.name ?? 'unknown';
      resolvedInputs = this.contextResolveFn({
        inputs: resolvedInputs,
        context: this.context,
        providerName,
      });
    }

    // F8: Route-based provider selection
    const route = stepExt.route;
    if (route && this.routeStepFn) {
      const routeResult = await this.routeStepFn({
        route,
        operation: step.operation,
        resolvedInputs,
        stepConfig: step.config as Record<string, unknown>,
        pipelineId: pipeline.id,
        stepId: step.id,
        getProviderByName: (name) => this.providers.get(name) ?? this.findProviderByName(name),
      });
      if (routeResult) {
        return { artifact: routeResult.artifact };
      }
    }

    // F9: Variants execution
    const variants = stepExt.variants;
    if (variants && this.variantsStepFn) {
      const variantsResult = await this.variantsStepFn({
        variants,
        step,
        resolvedInputs,
        pipelineId: pipeline.id,
        stepId: step.id,
      });
      if (variantsResult) {
        return { artifact: variantsResult.artifact };
      }
    }

    // F11: Ratio fan-out execution
    const ratios = stepExt.ratios;
    if (ratios && this.ratiosStepFn) {
      const ratiosResult = await this.ratiosStepFn({
        ratios,
        operation: step.operation,
        resolvedInputs,
        stepConfig: step.config as Record<string, unknown>,
        stepId: step.id,
      });
      if (ratiosResult) {
        return { artifact: ratiosResult.artifact };
      }
    }

    // Default: single-provider execution path
    const provider = this.providers.get(step.operation);
    if (!provider) {
      throw new Error(`No provider available for operation: ${step.operation}`);
    }

    // F18: enforce per-tenant allow-list (no-op in single-tenant deployments).
    // Throws TenantPolicyViolationError before any provider call is made.
    if (this.tenantPolicyEnforceFn) {
      this.tenantPolicyEnforceFn(provider.name, step.config.model as string | undefined);
    }

    const providerInputs = this.prepareInputs
      ? await this.prepareInputs(step.operation, resolvedInputs)
      : resolvedInputs;

    // F2: Use executeWithCache when the step has a cache config
    // and the provider exposes the method
    const cacheConfig = stepExt.cache;
    type ExecuteResult = Awaited<ReturnType<Provider['execute']>>;
    const providerWithCache = provider as Provider & {
      executeWithCache?: (
        input: {
          operation: string;
          params: Record<string, unknown>;
          config: Record<string, unknown>;
        },
        cache?: { mode?: string; ttlSeconds?: number },
      ) => Promise<ExecuteResult>;
    };
    const result =
      cacheConfig && typeof providerWithCache.executeWithCache === 'function'
        ? await providerWithCache.executeWithCache(
            { operation: step.operation, params: providerInputs, config: step.config },
            cacheConfig.mode
              ? { mode: cacheConfig.mode, ttlSeconds: cacheConfig.ttlSeconds }
              : undefined,
          )
        : await provider.execute(step.operation, providerInputs, step.config);

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

    const artifact = this.registry.registerWithId(artifactId, {
      ...result.artifact,
      uri: persisted?.uri ?? result.artifact.uri,
      sourceStep: step.id,
    });

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

      if (this.ledger) {
        await this.ledger.charge({
          runId: pipeline.id,
          stepId: step.id,
          operation: step.operation,
          provider: provider.name,
          costUsd: result.cost_usd,
        });
      }
    }

    // Phase 2: F17 — C2PA provenance signing.
    // Manifest carries the runId, the normalized pipeline definition hash, and any
    // upstream artifact ids that fed this step (becomes c2pa ingredients). The
    // signer is responsible for assembling the actual ProvenanceManifest and signing.
    if (this.signProvenance) {
      const ingredientArtifactIds: string[] = [];
      for (const value of Object.values(step.inputs ?? {})) {
        const m = value.match?.(/^\{\{(\w+)\.output\}\}$/);
        if (m) {
          const upstream = this.registry.findBySourceStep(m[1]);
          if (upstream) ingredientArtifactIds.push(upstream.id);
        }
      }
      await this.signProvenance({
        artifactId: artifact.id,
        runId: pipeline.id, // executor's Pipeline.id is the runId for in-tree runs
        pipelineDefHash: this.currentPipelineDefHash ?? '',
        stepId: step.id,
        operation: step.operation,
        providerId: provider.name,
        modelId: step.config?.model as string | undefined,
        ingredientArtifactIds,
      });
    }

    return { artifact, costUsd: result.cost_usd };
  }

  /** Hash the normalized pipeline definition for provenance manifests (F17) and for
   *  PipelineRunRecord auditing. Same canonical-json rule as F2 cache keys. */
  private hashPipelineDefinition(def: PipelineDefinition): string {
    // Strip volatile/runtime-only fields before hashing so semantically-identical
    // runs share a hash. `id` stays because it's part of the identity.
    const normalized = { id: def.id, steps: def.steps };
    const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
    // crypto.createHash needs the actual module — use Node's built-in. randomUUID is
    // already imported from 'node:crypto' at top of file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** Set inside execute()/resume() before stepping through steps; read by signProvenance. */
  private currentPipelineDefHash?: string;

  private findProviderByName(name: string): Provider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.name === name) return provider;
    }
    return undefined;
  }

  private async resolveInputs(inputSpec: Record<string, string>): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(inputSpec)) {
      const match = value.match(/^\{\{(\w+)\.output\}\}$/);
      if (match) {
        const stepId = match[1];
        const artifact = this.registry.findBySourceStep(stepId);

        // Plan §F3 test matrix: "Lost artifact | artifact id from step 1 missing in
        // registry | ArtifactNotFoundError, fail-fast". Previously this raised a
        // plain Error, which downstream callers couldn't tell apart from any other
        // resolver problem.
        if (!artifact) {
          throw new ArtifactNotFoundError();
        }

        resolved[key] = artifact.id;
      } else {
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
    // S3: also emit the spec-canonical kebab-case alias so consumers that follow
    // the §0.1 taxonomy receive the same lifecycle events. Both forms travel
    // through the same channel; the StreamingBridge already accepts either name.
    const specType = LEGACY_TO_SPEC_EVENT[event.type];
    if (specType && specType !== event.type) {
      this.onEvent?.({ ...event, type: specType });
    }
  }

  getRegistry(): ArtifactRegistry {
    return this.registry;
  }
}
