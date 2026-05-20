import { z } from 'zod';

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

// ─── Pipeline Step Types ────────────────────────────────────────────────────

export const PipelineStepSchema = z.object({
  id: z.string(),
  operation: z.string(),
  inputs: z.record(z.string()),
  config: z.record(z.unknown()).default({}),
  qualityGate: QualityGateSchema.optional(),
});
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

// ─── Pipeline Types ─────────────────────────────────────────────────────────

export const PipelineStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'gated']);
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
    }),
  ),
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

export const PipelineEventTypeSchema = z.enum([
  'pipeline:start',
  'pipeline:complete',
  'pipeline:failed',
  'pipeline:gated',
  'step:start',
  'step:complete',
  'step:failed',
  'step:gated',
  'step:retry',
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
