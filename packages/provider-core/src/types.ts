// ─── Existing types extracted from base-provider.ts ───────────────────────

export interface ProviderInput {
  operation: string;
  params: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface ProviderOutput {
  data: Buffer | ReadableStream;
  mimeType: string;
  metadata: Record<string, unknown>;
  costUsd?: number;
  durationMs?: number;
}

export interface ProviderHealth {
  healthy: boolean;
  latency?: number;
  error?: string;
}

// ─── Cost Estimate (F4/F5) ──────────────────────────────────────────────

export interface CostEstimate {
  costUsd: number;
  currency: string;
  breakdown?: Array<{ component: string; costUsd: number }>;
  estimatedDurationMs?: number;
}

// ─── Cache Types (F2) ───────────────────────────────────────────────────

export interface CacheConfig {
  mode: 'use' | 'refresh' | 'skip';
  ttlSeconds?: number;
  scope?: 'global' | 'tenant';
}

export interface CacheEntry {
  key: string;
  artifactIds: string[];
  outputs: ProviderOutput;
  costUsd: number;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

export interface ProviderCacheConfig {
  deterministicParams: string[];
  nonDeterministicParams: string[];
  normalize: (inputs: Record<string, unknown>) => Record<string, unknown>;
}

// ─── Webhook / Streaming Types (F6/F7) ──────────────────────────────────

export interface WebhookPayload {
  jobId: string;
  status: 'completed' | 'failed' | 'progress';
  output?: unknown;
  pct?: number;
  error?: { code: string; message: string };
}

// ─── Router Types (F8) ──────────────────────────────────────────────────

export type RouterStrategy = 'first-success' | 'cheapest-acceptable' | 'fastest';

export interface RouteCandidate {
  provider: string;
  model: string;
  maxQueueMs?: number;
  maxUsd?: number;
  inputOverrides?: Record<string, unknown>;
  weight?: number;
}

export interface RouteConfig {
  strategy: RouterStrategy;
  candidates: RouteCandidate[];
  timeoutMs?: number;
  healthTtlMs?: number;
}

export interface RouteRejection {
  candidate: RouteCandidate;
  reason: 'over-budget' | 'unhealthy' | 'queue-full' | 'error' | 'cancelled' | 'fastest-ineligible';
  detail?: string;
}

export interface RouteDecision {
  selected: RouteCandidate;
  rejected: RouteRejection[];
  estimate?: CostEstimate;
  reason: string;
  decidedAtMs: number;
}

// ─── MediaProvider Interface (partial for tooling) ────────────────────────

// ─── 3D Generation Types (F21) ───────────────────────────────────────────

export type MeshFormat = 'glb' | 'fbx' | 'obj' | 'usdz' | 'ply';

export interface MeshGenInput {
  prompt?: string;
  sourceArtifactId?: string;
  format: MeshFormat;
  polyBudget?: number;
  topology?: 'quads' | 'tris';
  texture?: TextureConfig;
  animated?: boolean;
}

export interface TextureConfig {
  enabled: boolean;
  pbr?: boolean;
  resolution?: 512 | 1024 | 2048 | 4096;
  unwrap?: 'auto' | 'preserve-source';
}

export interface MeshOutput {
  artifactId: string;
  format: MeshFormat;
  polyCount: number;
  hasTextures: boolean;
  hasAnimation: boolean;
  bboxMeters?: { x: number; y: number; z: number };
}

// ─── Pricing Tables (shape of per-provider pricing.json files) ──────────

export interface PricingUnit {
  perUnit: number;
  unit?: string;
}

export interface PricingEntry {
  input: PricingUnit;
  output?: PricingUnit;
  expectedDurationMs?: number;
  /** Optional per-step cost multiplier (e.g. Stability's diffusion steps). */
  perStep?: number;
}

/** `pricing[operation][model] => PricingEntry`. */
export type PricingTable = Record<string, Record<string, PricingEntry>>;

// ─── MediaProvider Interface (partial for tooling) ───────────────────────

export interface MediaProviderLike {
  readonly name: string;
  readonly supportedOperations: string[];
  estimateCost(input: ProviderInput): Promise<CostEstimate>;
  execute(input: ProviderInput): Promise<ProviderOutput>;
  healthCheck?(): Promise<ProviderHealth>;
  supportsStreaming?: ReadonlySet<string>;
  supportsWebhooks?: boolean;
  webhookSignatureKey?(): Promise<string>;
  parseWebhookPayload?(headers: Record<string, string>, body: string): Promise<WebhookPayload>;
}
