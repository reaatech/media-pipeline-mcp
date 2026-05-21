import { z } from 'zod';

// ─── INTERNAL types used by the in-tree PipelineExecutor ─────────────────────
//
// IMPORTANT: these are NOT the canonical types for cross-package wiring.
//   - For pipeline run state, import `PipelineStateStore`, `PipelineRun`, `StepState`,
//     `PipelineEvent` from `@reaatech/media-pipeline-mcp-persistence`.
//   - For cost tracking, import `CostLedger`, `CostEntry`, `CostEstimate` from
//     `@reaatech/media-pipeline-mcp-cost`.
//   - For routing, import `RouteConfig`, `RouteCandidate`, `Router` from
//     `@reaatech/media-pipeline-mcp-provider-core`.
//
// The narrowed shapes below are what the executor consumes internally (and what its
// injection-callback wiring passes through). Server-side adapters bridge the canonical
// types to these internal shapes.

/** @internal Executor-local store shape. The canonical type lives in @reaatech/media-pipeline-mcp-persistence. */
export interface PipelineStateStore {
  createRun(run: PipelineRunRecord): Promise<string>;
  getRun(runId: string): Promise<PipelineRunRecord | undefined>;
  updateRun(runId: string, patch: Partial<PipelineRunRecord>): Promise<void>;
  acquireLock(runId: string, ttlMs?: number): Promise<boolean>;
  releaseLock(runId: string): Promise<void>;
  listRuns(filter?: { pipelineId?: string; status?: PipelineStatus }): Promise<PipelineRunRecord[]>;
}

/** @internal Executor-local record. The canonical PipelineRun lives in @reaatech/media-pipeline-mcp-persistence. */
export interface PipelineRunRecord {
  runId: string;
  pipelineId: string;
  status: PipelineStatus;
  definition: PipelineDefinition;
  stepStates: StepStateRecord[];
  artifacts: Record<string, string>;
  totalCostUsd: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
  resumable?: boolean;
}

/** @internal Executor-local record. The canonical StepState lives in @reaatech/media-pipeline-mcp-persistence. */
export interface StepStateRecord {
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'gated' | 'skipped' | 'cached';
  artifactId?: string;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/** @internal Executor-local ledger shape. The canonical CostLedger lives in @reaatech/media-pipeline-mcp-cost. */
export interface CostLedger {
  charge(params: {
    runId: string;
    stepId: string;
    operation: string;
    provider: string;
    costUsd: number;
  }): Promise<void>;
  getRunCost(runId: string): Promise<number>;
  getTotalCost(): Promise<number>;
}

// ─── Artifact Types ─────────────────────────────────────────────────────────

export const ArtifactTypeSchema = z.enum(['image', 'video', 'audio', 'text', 'document']);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  uri: z.string(),
  mimeType: z.string(),
  metadata: z.record(z.unknown()).default({}),
  sourceStep: z.string().optional(),
  createdAt: z.string().datetime().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ─── Quality Gate Types ─────────────────────────────────────────────────────

export const QualityGateActionSchema = z.enum(['fail', 'retry', 'warn']);
export type QualityGateAction = z.infer<typeof QualityGateActionSchema>;

export const QualityGateSchema = z.object({
  type: z.enum(['llm-judge', 'threshold', 'dimension-check', 'custom']),
  config: z.record(z.unknown()),
  action: QualityGateActionSchema,
  maxRetries: z.number().int().min(0).optional(),
});
export type QualityGate = z.infer<typeof QualityGateSchema>;

// ─── F4 Budget Schema ──────────────────────────────────────────────────────

export const BudgetConfigSchema = z.object({
  maxUsd: z.number().nonnegative(),
  onExceed: z.enum(['abort', 'suspend']),
  warnAtPct: z.number().min(0).max(1).optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ─── F2 Cache Schema ───────────────────────────────────────────────────────

export const CacheConfigSchema = z.object({
  mode: z.enum(['use', 'refresh', 'skip']).optional(),
  ttlSeconds: z.number().int().positive().optional(),
  scope: z.enum(['global', 'tenant']).optional(),
});
export type CacheConfig = z.infer<typeof CacheConfigSchema>;

// ─── F8 Route Schema ───────────────────────────────────────────────────────

export const RouteCandidateSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxQueueMs: z.number().int().positive().optional(),
  maxUsd: z.number().nonnegative().optional(),
  inputOverrides: z.record(z.unknown()).optional(),
  weight: z.number().nonnegative().optional(),
});

export const RouteConfigSchema = z.object({
  strategy: z.enum(['first-success', 'cheapest-acceptable', 'fastest']),
  candidates: z.array(RouteCandidateSchema).min(1),
  timeoutMs: z.number().int().positive().optional(),
  healthTtlMs: z.number().int().positive().optional(),
});
export type RouteConfig = z.infer<typeof RouteConfigSchema>;

// ─── F9 Variants Schema ────────────────────────────────────────────────────

export const JudgeRubricSchema = z.object({
  dimensions: z.array(
    z.object({
      name: z.string(),
      weight: z.number().min(0).max(1),
      description: z.string(),
    }),
  ),
});
export type JudgeRubric = z.infer<typeof JudgeRubricSchema>;

export const JudgeConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('llm-judge'),
    criteria: z.string(),
    model: z.string().optional(),
    provider: z.string().optional(),
    rubric: JudgeRubricSchema.optional(),
  }),
  z.object({
    type: z.literal('image-judge'),
    criteria: z.enum(['clip-score', 'aesthetic']),
    reference: z.string().optional(),
  }),
  z.object({ type: z.literal('rule'), expression: z.string() }),
  z.object({ type: z.literal('custom'), toolName: z.string() }),
]);
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

export const VariantsConfigSchema = z.object({
  n: z.number().int().min(2).max(16),
  seedStrategy: z.enum(['random', 'sequential', 'fixed-list']).optional(),
  seeds: z.array(z.number().int()).optional(),
  judge: JudgeConfigSchema,
  loserAction: z.enum(['archive', 'discard']).optional(),
  perVariantCandidate: z.boolean().optional(),
  minScore: z.number().min(0).max(1).optional(),
});
export type VariantsConfig = z.infer<typeof VariantsConfigSchema>;

// ─── F13 RunContext Schema ─────────────────────────────────────────────────

export const VoiceRefSchema = z.object({
  provider: z.enum(['elevenlabs', 'openai', 'google', 'deepgram-tts']),
  voiceId: z.string(),
  settings: z.record(z.unknown()).optional(),
});
export type VoiceRef = z.infer<typeof VoiceRefSchema>;

export const StyleRefSchema = z.object({
  description: z.string(),
  negative: z.string().optional(),
  perProvider: z
    .record(z.object({ description: z.string().optional(), negative: z.string().optional() }))
    .optional(),
});
export type StyleRef = z.infer<typeof StyleRefSchema>;

export const BrandKitSchema = z.object({
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  fontFamily: z.string().optional(),
  logoArtifactId: z.string().optional(),
  extras: z.record(z.unknown()).optional(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

export const ContextRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voice'), name: z.string() }),
  z.object({ kind: z.literal('style'), name: z.string() }),
  z.object({ kind: z.literal('brand'), key: z.string() }),
]);

export const RunContextSchema = z.object({
  voices: z.record(VoiceRefSchema).optional(),
  styles: z.record(StyleRefSchema).optional(),
  brandKit: BrandKitSchema.optional(),
  vars: z.record(z.unknown()).optional(),
});
export type RunContext = z.infer<typeof RunContextSchema>;

// ─── Pipeline Step Types ────────────────────────────────────────────────────

export const PipelineStepSchema = z.object({
  id: z.string(),
  operation: z.string(),
  inputs: z.record(z.string()),
  config: z.record(z.unknown()).default({}),
  qualityGate: QualityGateSchema.optional(),
  variants: VariantsConfigSchema.optional(),
  gates: z.array(QualityGateSchema).optional(),
  cache: CacheConfigSchema.optional(),
  route: RouteConfigSchema.optional(),
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

// ─── Pipeline Types ─────────────────────────────────────────────────────────

export const PipelineStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'gated',
  'cancelled',
]);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const PipelineSchema = z.object({
  id: z.string(),
  steps: z.array(PipelineStepSchema),
  status: PipelineStatusSchema.default('pending'),
  artifacts: z.map(z.string(), ArtifactSchema).default(new Map()),
  failedStep: z.string().optional(),
  gatedStep: z.string().optional(),
  currentStep: z.string().optional(),
  completedSteps: z.array(z.string()).default([]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

// ─── Pipeline Definition (input) ────────────────────────────────────────────

export const PipelineDefinitionSchema = z.object({
  id: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      operation: z.string(),
      inputs: z.record(z.string()),
      config: z.record(z.unknown()).default({}),
      qualityGate: QualityGateSchema.optional(),
      variants: VariantsConfigSchema.optional(),
      gates: z.array(QualityGateSchema).optional(),
      cache: CacheConfigSchema.optional(),
      route: RouteConfigSchema.optional(),
    }),
  ),
  resumable: z.boolean().default(true).optional(),
  budget: BudgetConfigSchema.optional(),
  context: RunContextSchema.optional(),
});
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

// ─── Provider Types ─────────────────────────────────────────────────────────

export const ProviderInputSchema = z.object({
  operation: z.string(),
  inputs: z.record(z.unknown()),
  config: z.record(z.unknown()).optional(),
});
export type ProviderInput = z.infer<typeof ProviderInputSchema>;

export const ProviderOutputSchema = z.object({
  artifact: ArtifactSchema,
  cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ProviderOutput = z.infer<typeof ProviderOutputSchema>;

// ─── Quality Gate Result Types ──────────────────────────────────────────────

export const QualityGateResultSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string().optional(),
  score: z.number().optional(),
  action: QualityGateActionSchema,
});
export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

// ─── Pipeline Execution Events ──────────────────────────────────────────────

// Both the legacy colon-namespaced names (still emitted by the in-tree PipelineExecutor)
// and the spec-canonical kebab-case names (plan §0.1, emitted by the persistence layer)
// are accepted. Consumers should treat them as synonyms — see StreamingBridge for the
// mapping table.
export const PipelineEventTypeSchema = z.enum([
  // Legacy
  'pipeline:start',
  'pipeline:complete',
  'pipeline:failed',
  'pipeline:gated',
  'step:start',
  'step:complete',
  'step:failed',
  'step:gated',
  'step:retry',
  // Spec-canonical (§0.1)
  'run-created',
  'run-started',
  'run-completed',
  'run-failed',
  'run-suspended',
  'run-resumed',
  'step-started',
  'step-progress',
  'step-completed',
  'step-failed',
  'step-cached',
  'step-gated',
]);
export type PipelineEventType = z.infer<typeof PipelineEventTypeSchema>;

export const PipelineEventSchema = z.object({
  type: PipelineEventTypeSchema,
  pipelineId: z.string(),
  stepId: z.string().optional(),
  artifactId: z.string().optional(),
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()).optional(),
});
export type PipelineEvent = z.infer<typeof PipelineEventSchema>;

// ─── Cost Tracking Types ────────────────────────────────────────────────────

export const CostRecordSchema = z.object({
  operation: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  cost_usd: z.number(),
  artifactId: z.string().optional(),
  pipelineId: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type CostRecord = z.infer<typeof CostRecordSchema>;

export const CostSummarySchema = z.object({
  total_usd: z.number(),
  by_operation: z.map(z.string(), z.number()).default(new Map()),
  by_provider: z.map(z.string(), z.number()).default(new Map()),
  by_pipeline: z.map(z.string(), z.number()).default(new Map()),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

// ─── Storage Types ──────────────────────────────────────────────────────────

export const ArtifactMetaSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  mimeType: z.string(),
  size: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime().optional(),
  sourceStep: z.string().optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const StorageResultSchema = z.object({
  data: z.instanceof(ReadableStream).or(z.instanceof(Buffer)),
  meta: ArtifactMetaSchema,
});
export type StorageResult = z.infer<typeof StorageResultSchema>;

// ─── Validation Result Types ────────────────────────────────────────────────

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  estimated_cost_usd: z.number().optional(),
  estimated_duration_ms: z.number().optional(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// ─── F3 Resume Types ────────────────────────────────────────────────────────

export interface PipelineResumeRequest {
  runId: string;
  fromStepId?: string;
}

// ─── F5 Estimation Types ────────────────────────────────────────────────────

export interface PipelineEstimate {
  totalUsdLow: number;
  totalUsdHigh: number;
  perStep: StepEstimate[];
  warnings: EstimateWarning[];
}

export interface StepEstimate {
  stepId: string;
  operation: string;
  provider: string;
  modelId: string;
  usdLow: number;
  usdHigh: number;
  estimable: boolean;
  fallbackUsed?: 'cached-stats' | 'default-bound';
}

export interface EstimateWarning {
  stepId: string;
  code: 'no-estimator' | 'variable-output' | 'depends-on-prior-step' | 'router-spread';
  message: string;
}

// ─── F9 Variant Output Types ────────────────────────────────────────────────

export interface VariantResult {
  variantIndex: number;
  artifactId?: string;
  costUsd: number;
  judgeScore?: number;
  judgeRationale?: string;
  winner: boolean;
  rejected?: 'safety' | 'judge-low' | 'gate-fail' | 'generation-error';
  generationError?: { code: string; message: string };
}

export interface VariantsStepOutput {
  winner?: VariantResult;
  losers: VariantResult[];
  totalCostUsd: number;
  judgeUsdCost: number;
}

// ─── F13 Context Ref Types ──────────────────────────────────────────────────

export type ContextRef =
  | { kind: 'voice'; name: string }
  | { kind: 'style'; name: string }
  | { kind: 'brand'; key: string };

// Error classes are defined in ./errors.js — import from there:
// RunNotResumableError, RunInProgressError, BudgetExceededError, etc.
