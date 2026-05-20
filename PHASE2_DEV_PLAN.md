# PHASE2_DEV_PLAN.md — media-pipeline-mcp

Target: 21 features that move this from a multi-provider wrapper to a production-grade media orchestration layer. Five phases. Each phase composes from primitives the previous phase introduced.

This document defines **what to build, the public API, the data shapes, the test matrix, and the dependencies between features.** It is structured as a builder-agent handoff: pick a phase, pick a feature, ship it without coming back with design questions.

**Phase 2.1 is fully specified to the builder-ready bar.** Phases 2.2–2.5 are roadmap-level; each feature there must be deepened to the Phase 2.1 standard before implementation starts (each F# grows its own `docs/features/F##-<slug>.md` design note).

---

## 0. Cross-cutting prerequisites

These must land before Phase 2.1 features can be implemented coherently. They are not features themselves; they are the foundation Phase 2 builds on.

### 0.1 Pipeline state store (new package `packages/persistence`)

Pipelines must be persistable so they can be resumed, suspended for webhooks, and audited. The current pipeline executor holds state in memory only.

**Public types** (`packages/persistence/src/types.ts`):

```ts
import type { A2AError } from '@reaatech/media-pipeline-mcp-core';

export type PipelineRunStatus =
  | 'pending'      // created, not yet started
  | 'running'      // at least one step in flight
  | 'suspended'    // awaiting webhook or budget recheck
  | 'completed'    // all steps done
  | 'failed'       // terminal failure
  | 'cancelled';   // explicit cancel by caller

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'gated'        // quality gate rejected, may retry
  | 'cached'       // F2 cache hit, no execution
  | 'cancelled';

export interface PipelineRun {
  runId: string;                          // ULID
  tenantId?: string;                      // F18
  pipelineDefHash: string;                // sha256 of normalized pipeline definition
  status: PipelineRunStatus;
  steps: StepState[];
  createdAt: string;                      // ISO 8601
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;                // F1
  externalJobIds: Record<string, string>; // stepId -> provider jobId, for F7 webhook resume
  costUsd: number;
  budget?: BudgetConfig;                  // F4
  resumeToken?: string;                   // F7 suspend resume token
  version: number;                        // optimistic lock counter
}

export interface StepState {
  stepId: string;
  operation: string;
  inputs: Record<string, unknown>;
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  outputs?: Record<string, unknown>;
  artifactIds: string[];
  costUsd: number;
  cacheKey?: string;                      // F2
  lastError?: { code: string; message: string; retryable: boolean; at: string };
}

export type PipelineEvent =
  | { kind: 'run-created';    runId: string; at: number; pipelineDefHash: string }
  | { kind: 'run-started';    runId: string; at: number }
  | { kind: 'step-started';   runId: string; stepId: string; at: number; attempt: number }
  | { kind: 'step-progress';  runId: string; stepId: string; at: number; pct: number; etaMs?: number; message?: string; costUsdAccrued?: number }
  | { kind: 'step-cached';    runId: string; stepId: string; at: number; cacheKey: string; artifactIds: string[] }
  | { kind: 'step-completed'; runId: string; stepId: string; at: number; artifactIds: string[]; costUsd: number }
  | { kind: 'step-failed';    runId: string; stepId: string; at: number; code: string; retryable: boolean }
  | { kind: 'step-gated';     runId: string; stepId: string; at: number; gateType: string; verdict: string }
  | { kind: 'run-suspended';  runId: string; at: number; reason: 'webhook' | 'budget' | 'gate'; resumeToken: string }
  | { kind: 'run-resumed';    runId: string; at: number; fromStepId: string }
  | { kind: 'run-completed';  runId: string; at: number; totalCostUsd: number }
  | { kind: 'run-failed';     runId: string; at: number; code: string; terminalReason: string };

export interface RunFilter {
  tenantId?: string;
  status?: PipelineRunStatus | PipelineRunStatus[];
  since?: string;
  idempotencyKey?: string;
}

export interface PipelineStateStore {
  create(run: PipelineRun): Promise<void>;
  get(runId: string): Promise<PipelineRun | null>;
  update(runId: string, patch: Partial<PipelineRun>, expectedVersion?: number): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  appendEvent(runId: string, event: PipelineEvent): Promise<void>;
  listEvents(runId: string, since?: number): Promise<PipelineEvent[]>;
  listRuns(filter: RunFilter, limit?: number): Promise<PipelineRun[]>;
  findByExternalJobId(provider: string, jobId: string): Promise<PipelineRun | null>;
  /** Acquire exclusive write for the duration of fn. Blocks up to 5s, throws RunInProgressError on timeout. */
  withLock<T>(runId: string, fn: () => Promise<T>): Promise<T>;
}
```

**Implementations to ship in Phase 2.1:** `InMemoryPipelineStateStore`, `RedisPipelineStateStore`. `PostgresPipelineStateStore` deferred to Phase 2.4.

**Redis schema:**

| Key | Type | Value | TTL |
|---|---|---|---|
| `mp:run:<runId>` | string | JSON(PipelineRun) | 30d |
| `mp:run:<runId>:events` | list | JSON event objects, RPUSH-append | 30d |
| `mp:run:<runId>:lock` | string (SET NX EX) | "1" | 60s |
| `mp:idem:<idempotencyKey>` | string | runId | 24h |
| `mp:job:<provider>:<jobId>` | string | runId | 7d |
| `mp:tenant:<tenantId>:runs` | zset | runId (score = createdAt epoch ms) | 30d |

**Locking primitive:** `SET key 1 NX EX 60` with 100ms poll-backoff for up to 5s. On timeout, throw `RunInProgressError`.

**Postgres schema (Phase 2.4):**

```sql
CREATE TABLE pipeline_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  pipeline_def_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_runs_tenant_status ON pipeline_runs(tenant_id, status, created_at DESC);

CREATE TABLE pipeline_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, seq)
);

CREATE TABLE pipeline_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
```

Locking on Postgres: `pg_try_advisory_xact_lock(hashtext(run_id))` inside a transaction.

**Retention:** 30 days hot; archive to S3 after. Event log is never compacted (audit requirement).

### 0.2 Cost ledger (new package `packages/cost`)

The existing `cost-tracker.ts` in server is per-request. We need a persistent, queryable ledger per pipeline run + per tenant. Backs F4 (budget caps), F5 (dry-run), F18 (multi-tenant).

```ts
// packages/cost/src/types.ts

export interface CostEntry {
  id: string;                       // ULID
  runId: string;
  tenantId?: string;
  stepId: string;
  provider: string;
  operation: string;
  modelId: string;
  inputUnits: number;
  outputUnits: number;
  inputUnitType: 'tokens' | 'seconds' | 'pixels' | 'characters' | 'requests';
  outputUnitType: 'tokens' | 'seconds' | 'pixels' | 'characters' | 'requests';
  usd: number;                      // 4-decimal precision (round half-up)
  at: string;                       // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface CostEstimate {
  provider: string;
  operation: string;
  modelId: string;
  inputUnits: number;
  outputUnitsLow: number;
  outputUnitsHigh: number;
  usdLow: number;
  usdHigh: number;
}

export type CostScope =
  | { kind: 'run';    runId: string }
  | { kind: 'tenant'; tenantId: string; window: TimeWindow };

export interface TimeWindow {
  since: string;            // ISO 8601
  until?: string;           // default now
}

export interface PreflightResult {
  allowed: boolean;
  remainingUsd: number;
  reason?: 'run-budget-exceeded' | 'tenant-daily-cap' | 'tenant-monthly-cap';
}

export interface CostLedger {
  charge(entry: CostEntry): Promise<void>;
  preflight(estimate: CostEstimate, scope: CostScope): Promise<PreflightResult>;
  totalForRun(runId: string): Promise<number>;
  totalForTenant(tenantId: string, window: TimeWindow): Promise<number>;
  listEntries(scope: CostScope): Promise<CostEntry[]>;
}
```

**Backing store:** same Redis instance as `PipelineStateStore`. Entries written atomically via Lua scripts (charge + ZADD tenant index in one round-trip).

**Currency rounding:** all USD amounts stored as integer micro-dollars (`uUSD = USD × 1_000_000`) internally; converted to 4-decimal USD at API boundaries.

### 0.3 Event bus (`packages/core/src/event-bus.ts`)

Typed in-process emitter used by F6 streaming + F7 webhooks. ~50 lines.

```ts
export type EventHandler<E> = (event: E) => void | Promise<void>;

export interface EventBus<E extends { kind: string }> {
  on<K extends E['kind']>(kind: K, handler: EventHandler<Extract<E, { kind: K }>>): () => void;
  emit(event: E): void;
  /** Wait for an event matching the kind + optional predicate. Used by F7 webhook resume. */
  await<K extends E['kind']>(
    kind: K,
    predicate?: (e: Extract<E, { kind: K }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<E, { kind: K }>>;
}

export function createEventBus<E extends { kind: string }>(): EventBus<E>;
```

### 0.4 MCP tool naming and versioning convention

**Naming:**
- Domain-first: `image.generate`, `audio.tts`, `pipeline.execute`.
- Use `dot.case`. Domain is singular noun (`image` not `images`).
- Preferred verbs: `execute`, `estimate`, `resume`, `cancel`, `subscribe`, `status`.
- Sub-tools under an entity use a second dot: `pipeline.batch.retry`, `pipeline.batch.status`.
- Internal/experimental tools prefix with `_`: `_debug.dumpRun`.

**Phase 2.1 tool additions:**

| Tool | Type | Phase | Owner package |
|---|---|---|---|
| `pipeline.estimate` | new | F5 | server |
| `pipeline.resume` | new | F3 | server |
| `pipeline.cancel` | new | F3 | server |
| `pipeline.status` | new | F3 | server |
| `pipeline.subscribe` | new | F7 | server |

**Versioning (applies to `@reaatech/media-pipeline-mcp-server`):**
- New tools, new optional fields: **minor** bump.
- Tool removal/rename, required-field addition: **major** bump.
- Backwards-compatible behavior change (e.g., adding cache layer to an existing tool): **patch**, document in CHANGELOG.

### 0.5 Error class hierarchy additions

All new errors extend `A2AError` from `@reaatech/media-pipeline-mcp-core`. Defined in `packages/core/src/errors.ts`. Each carries a stable `code` and a `retryable` flag.

```ts
// Phase 2.1
export class IdempotencyConflictError extends A2AError {
  code = 'IDEMPOTENCY_CONFLICT';
  retryable = false;
  constructor(public reason: 'in-flight' | 'body-mismatch', public existingRunId?: string) { super(); }
}
export class BudgetExceededError extends A2AError {
  code = 'BUDGET_EXCEEDED';
  retryable = false;
  constructor(public spentUsd: number, public capUsd: number, public scope: 'run' | 'tenant-daily' | 'tenant-monthly') { super(); }
}
export class RunNotFoundError extends A2AError      { code = 'RUN_NOT_FOUND';      retryable = false; }
export class RunInProgressError extends A2AError    { code = 'RUN_IN_PROGRESS';    retryable = true;  }
export class RunNotResumableError extends A2AError  { code = 'RUN_NOT_RESUMABLE';  retryable = false; }
export class WebhookSignatureInvalidError extends A2AError { code = 'WEBHOOK_SIGNATURE_INVALID'; retryable = false; }
export class WebhookProviderUnknownError extends A2AError  { code = 'WEBHOOK_PROVIDER_UNKNOWN';  retryable = false; }
export class StateStoreUnavailableError extends A2AError   { code = 'STATE_STORE_UNAVAILABLE';   retryable = true;  }
export class EstimateUnsupportedError extends A2AError     { code = 'ESTIMATE_UNSUPPORTED';      retryable = false; }

// Phase 2.2
export class RouterAllCandidatesFailedError extends A2AError {
  code = 'ROUTER_ALL_CANDIDATES_FAILED'; retryable = false;
  constructor(public attemptedCandidates: string[], public lastError: Error) { super(); }
}
export class RouterNoCandidatesError extends A2AError { code = 'ROUTER_NO_CANDIDATES'; retryable = false; }

// Phase 2.4
export class SafetyGateRejectedError extends A2AError {
  code = 'SAFETY_GATE_REJECTED'; retryable = false;
  constructor(public category: string, public score: number) { super(); }
}
export class TenantNotFoundError extends A2AError    { code = 'TENANT_NOT_FOUND';    retryable = false; }
export class KeyVaultUnavailableError extends A2AError { code = 'KEY_VAULT_UNAVAILABLE'; retryable = true; }
```

**Retryability rules:**
- `retryable = true`: transient infra (state store, key vault, network).
- `retryable = false`: caller error, business-rule rejection.
- Provider HTTP-derived: 5xx → retryable; 4xx except 408/429 → not; 408/429 → retryable with backoff.

### 0.6 Per-provider implementation surface

Phase 2.1/2.2 features extend `MediaProvider` with new optional members. Providers implement what they can; runtime degrades gracefully.

```ts
// packages/provider-core/src/types.ts (additions)

export interface MediaProvider {
  // ... existing members ...

  /** F4/F5: cost estimation. Required for pipeline.estimate and budget caps. */
  estimateCost(input: ProviderInput): Promise<CostEstimate>;

  /** F6: streaming progress. Set lists ops that can stream; absent = no streaming. */
  supportsStreaming?: ReadonlySet<string>;

  /** F7: webhook callback. Absent or false = polling-only. */
  supportsWebhooks?: boolean;
  webhookSignatureKey?(): Promise<string>;
  parseWebhookPayload?(headers: Record<string, string>, body: string): Promise<WebhookPayload>;

  /** F8: routing signals. Absent = treated as healthy with unknown queue depth. */
  healthCheck?(): Promise<{ healthy: boolean; latencyMs?: number; queueDepth?: number }>;
}

export interface WebhookPayload {
  jobId: string;
  status: 'completed' | 'failed' | 'progress';
  output?: unknown;
  pct?: number;
  error?: { code: string; message: string };
}
```

**Per-provider Phase 2.1 implementation status:**

| Provider | estimateCost source | streams progress | webhooks |
|---|---|---|---|
| openai | bundled `pricing.json` per model+size | tts streams; image sync | no |
| stability | bundled, per model × steps × resolution | no | no |
| replicate | API response carries `hardware.price_per_second × predicted_seconds`; estimate pre-call from same fields | poll → bridge to events | **yes (native)** |
| fal | bundled per-model flat | queue events stream | **yes (native)** |
| elevenlabs | per-character × model multiplier (bundled) | streaming tts supported | no |
| deepgram | per-minute × model (bundled) | **yes (WebSocket STT)** | yes for batch |
| anthropic | per-input/output token × model (bundled) | text streaming yes | no |
| google | docai per-page; vertex per-token (bundled) | vertex yes; docai no | no |
| provider-core (mock) | flat $0 | yes (simulated) | yes (simulated) |

**Pricing table format** — each provider ships a `src/pricing.json` static file:

```json
{
  "image.generate": {
    "dall-e-3": {
      "1024x1024": { "standard": 0.04, "hd": 0.08 },
      "1024x1792": { "standard": 0.08, "hd": 0.12 }
    }
  },
  "audio.tts": {
    "tts-1":    { "per1MChars": 15.00 },
    "tts-1-hd": { "per1MChars": 30.00 }
  }
}
```

Pricing tables reviewed quarterly. Bumps to pricing.json are **patch** releases of the provider package.

---

## Phase 2.1 — Pipeline reliability and economics

Foundation features. After this phase, the project is the cheapest and most reliable way to chain media ops.

---

### F1. Idempotency keys

**Value:** identical MCP calls with the same `Idempotency-Key` return the prior response without re-billing.

**API (MCP request metadata):**
```ts
{ "_meta": { "idempotencyKey": "01HXYZ..." } }   // ULID or UUIDv7, 16–128 chars
```

**Types:**
```ts
export interface IdempotencyEntry {
  key: string;
  runId: string;
  bodyHash: string;             // sha256 of the canonical-JSON request body
  response: SerializedToolResponse;
  status: 'in-flight' | 'completed' | 'failed';
  createdAt: string;
  expiresAt: string;            // 24h after createdAt
}
```

**Mechanism:**
1. Server middleware computes `bodyHash` from canonical-JSON.
2. Look up `mp:idem:<key>`:
   - Hit, `status: completed`: return stored response, **no provider calls**.
   - Hit, `status: in-flight`: throw `IdempotencyConflictError(reason: 'in-flight')` with `Retry-After: 30`.
   - Hit, `status: failed`: replay the stored failure.
   - Hit but `bodyHash` mismatch: throw `IdempotencyConflictError(reason: 'body-mismatch')`.
   - Miss: insert with `status: in-flight`, proceed to execute, update on completion.

**Affected:** `packages/server/src/mcp-server.ts` (middleware), `packages/persistence`.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| First-time call | new key | full execution, response stored |
| Repeat after completion | key exists, status=completed | stored response returned, zero provider calls |
| Repeat while in-flight | second call arrives during first | `IdempotencyConflictError('in-flight')` with Retry-After |
| Repeat after failure | key exists, status=failed | replay stored failure (same error code) |
| Body mismatch | same key, different request body | `IdempotencyConflictError('body-mismatch')` |
| Expired key | TTL elapsed (24h+) | treat as new call |
| State store down | redis unavailable | `StateStoreUnavailableError` (retryable) |
| Concurrent insert | two callers race on same new key | one proceeds (SET NX wins), other gets `in-flight` |

**Backwards-compat:** `_meta.idempotencyKey` is optional. Callers that omit it get current behavior. No tool signature change.

---

### F2. Content-addressed artifact cache

**Value:** `hash(model + prompt + seed + params + provider_version) → artifact_id`. Iterating prompts doesn't re-bill identical operations.

**Types:**
```ts
export interface CacheConfig {
  mode: 'use' | 'refresh' | 'skip';
  ttlSeconds?: number;                  // default: 30 days
  scope?: 'global' | 'tenant';          // default: global
}

export interface CacheEntry {
  key: string;                          // sha256 hex
  artifactIds: string[];
  outputs: Record<string, unknown>;
  costUsd: number;                      // original cost, for analytics
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

export interface ProviderCacheConfig {
  deterministicParams: string[];
  nonDeterministicParams: string[];
  normalize: (inputs: Record<string, unknown>) => Record<string, unknown>;
}
```

**Cache key formula:**
```
sha256(
  provider + "::" + modelId + "::" + modelVersion + "::" +
  canonicalJson(normalize(deterministicInputs))
)
```

`canonicalJson` = sorted-key JSON with whitespace stripped and numbers in canonical form (no trailing zeros).

**Per-provider deterministic/non-deterministic params:**

| Provider | Operation | Deterministic | Non-deterministic |
|---|---|---|---|
| openai | image.generate | prompt, model, size, quality, style | n, response_format, user |
| stability | image.generate | prompt, model, steps, cfg_scale, width, height, seed, sampler (explicit) | sampler (when "auto") |
| replicate | * | prompt, model_version, all input params, seed | webhook URL |
| fal | image.generate | prompt, model, all input params, seed | request_id |
| elevenlabs | audio.tts | text, voice_id, model, voice_settings | (TTS non-det; cache only when `mode: 'use'` explicit) |
| openai | audio.tts | text, voice, model, speed | (same TTS rule) |
| deepgram | audio.transcribe | sha256(audio_bytes), model, language, all features | request_id |
| anthropic | * | prompt, model, system, all params except `metadata` | metadata |
| google (vertex) | * | prompt, model, generationConfig | (gemini non-det without seed) |

**Mechanism:** `BaseProvider.executeWithRetry` consults cache before `execute()`. Cache stored under `mp:cache:<key>` (Redis hash). The artifact itself remains in storage; this is a *params → artifact-id* index.

**Affected:** `packages/provider-core/base-provider.ts`, all 9 provider packages.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Hit (mode=use) | identical params | artifacts returned, no provider call, **no cost charge** |
| Miss | params differ | provider called, result cached, normal cost |
| Mode=refresh | hit exists | provider called, cache entry replaced |
| Mode=skip | hit exists | provider called, cache unchanged |
| TTL expired | entry past expiresAt | treated as miss |
| Tenant scope | same params, different tenants, scope='tenant' | separate cache entries |
| Non-det param differs | only `seed` differs (and seed in nonDet list) | hit |
| Whitespace-only diff in prompt | "hello  world" vs "hello world" | hit (after normalize) |
| Number canonical form | `1.0` vs `1` | hit |
| Provider version bump | same params, modelVersion changed | miss |

**Backwards-compat:** `cache` config is optional. Defaults:
- `image.generate`, `audio.transcribe`, `document.extract` → `mode: 'use'`.
- `audio.tts`, anything with explicit `seed: -1` → `mode: 'skip'`.

---

### F3. Resumable pipelines

**Value:** step 5 of 7 fails; resume from step 5 with artifacts 1–4 intact.

**API:**
```ts
// New MCP tool
pipeline.resume({
  runId: string,
  fromStepId?: string,    // default: first non-completed step
})
// Returns: same shape as pipeline.execute result
```

**Types:**
```ts
export interface PipelineDefinition {
  // ... existing fields ...
  resumable?: boolean;    // default true
}

export interface PipelineResumeRequest {
  runId: string;
  fromStepId?: string;
}
```

**State machine** (StepStatus transitions):
```
pending ──► running ──► completed
   │           │
   │           ├──► failed ──► (resume) ──► running ...
   │           ├──► gated ──► (resume) ──► running ...
   │           ├──► cached
   │           └──► cancelled (terminal)
```

PipelineRunStatus transitions:
```
pending ──► running ──► completed
              │
              ├──► suspended ──► (webhook/resume) ──► running ...
              ├──► failed (terminal unless resumed)
              └──► cancelled (terminal)
```

**Mechanism:**
1. `pipeline.resume(runId)` acquires `withLock(runId)`.
2. Load run state. Reject if status is `completed | cancelled` → `RunNotResumableError`.
3. For each step:
   - `completed` or `cached` → skip; load artifacts from registry.
   - `failed` or `gated` → re-execute with original inputs. Reset `attempts` to 0 for the new resume.
   - `running` → check idempotency cache (F1); on hit treat as completed; on miss, re-execute.
4. Update PipelineRun version on every transition (optimistic lock).

**Affected:** `packages/pipeline/src/pipeline-executor.ts` (major refactor), `packages/server` (new tool).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Resume from failed step | 3/5 failed | steps 1-2 skipped (load artifacts), step 3 re-executed |
| Resume from gated step | step 2 failed quality gate | re-execute with same inputs, fresh attempts |
| Resume completed run | all steps done | `RunNotResumableError` |
| Resume in-progress run | another caller running it | `RunInProgressError` |
| Resume from explicit step | fromStepId=step2 | step1 artifact loaded, step2+ re-executed |
| Resume cancelled run | run cancelled | `RunNotResumableError` |
| Concurrent resume | two simultaneous resumes | second gets `RunInProgressError` |
| Lost artifact | artifact id from step 1 missing in registry | `ArtifactNotFoundError`, fail-fast |
| Resume with `resumable: false` | flag set | `RunNotResumableError` |

**Backwards-compat:** purely additive. New tool. Existing `pipeline.execute` unchanged.

---

### F4. Hard budget caps with enforcement

**Value:** `maxUsd: 5.00` aborts the pipeline mid-run before it overruns.

**Types:**
```ts
export interface BudgetConfig {
  maxUsd: number;
  onExceed: 'abort' | 'suspend';
  warnAtPct?: number;    // emit warn event at this fraction; default 0.8
}
```

**API:**
```ts
pipeline.execute({
  ...,
  budget: { maxUsd: 5.00, onExceed: 'abort' }
})
```

**Mechanism:**
1. **Preflight** — before each step, the provider's `estimateCost(inputs)` is consulted. If `ledger.totalForRun() + estimate.usdHigh > budget.maxUsd`, the step does **not** execute.
2. **Streaming cap** — for ops that bill per output unit (LLM tokens, video seconds), the cost ledger updates as the stream progresses. If `ledger.totalForRun() > budget.maxUsd`, the in-flight stream is cancelled.
3. **Warn threshold** — at `warnAtPct × maxUsd`, emit a `step-progress` event carrying `budgetWarning: true`.

**Onexceed semantics:**
- `abort` → run transitions to `failed`, `BudgetExceededError` propagates.
- `suspend` → run transitions to `suspended`. Caller may resume after raising the cap.

**Provider w/o estimator:** if `estimateCost` returns `EstimateUnsupportedError`, preflight is **skipped** (best-effort). Cost still charged post-execution; cap may overshoot. Logged.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Under budget | maxUsd=10, run costs 5 | completes normally |
| Preflight blocks step | maxUsd=1, step 1 estimate=0.5, step 2 estimate=1.0 | step 2 blocked before execution; BudgetExceededError |
| Streaming trips cap | maxUsd=2, run reaches 2.01 mid-stream | stream cancelled; BudgetExceededError |
| Warn threshold | maxUsd=10, warnAtPct=0.8, cost reaches 8 | step-progress event with budgetWarning=true |
| onExceed=suspend | cap hit | run suspended, resume token issued |
| Provider lacks estimator | EstimateUnsupportedError | step proceeds, charged after; warning logged |
| Concurrent steps | 2 parallel steps both estimate 0.6, budget=1 | first step's preflight passes, second sees updated ledger and blocks |

**Backwards-compat:** `budget` optional. Default: no cap.

---

### F5. Dry-run cost estimation

**Value:** `pipeline.estimate({...})` returns per-step cost breakdown before spending a cent.

**Types:**
```ts
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
```

**API:**
```ts
// New MCP tool
pipeline.estimate({ pipeline: PipelineDefinition })
// Returns: PipelineEstimate
```

**Mechanism:** walk the pipeline DAG. For each step:
1. Resolve provider+model (apply F8 routing if present).
2. Call `provider.estimateCost(inputs)` with inputs computed from upstream step outputs (use `outputUnitsHigh` for chaining).
3. Sum low/high.

For variable-output ops (LLM with `max_tokens`):
- `low` uses ~30% of `max_tokens`.
- `high` uses `max_tokens` × pricing.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| All steps estimable | image-gen + upscale | low+high totals, no warnings |
| Variable output | LLM `max_tokens: 1000` | high uses 1000, low uses ~300 |
| Provider lacks estimator | EstimateUnsupportedError | warning code=no-estimator; usdHigh=Infinity for the run |
| Chained estimation | step2 input depends on step1 output (e.g., transcribe → summarize) | use step1's outputUnitsHigh to bound step2 |
| Router spread | F8 candidates differ by 10x | warning code=router-spread; range spans cheapest to most expensive |
| Cached step | step has cache hit available | usdLow=0, usdHigh=0, note cache-hit |

**Backwards-compat:** new tool. No existing surface affected.

---

### F6. Streaming progress events

**Value:** video gen takes 4 minutes; agents currently see no output until done. Stream progress over MCP.

**Mechanism:** use MCP's JSON-RPC progress notifications (`$/progress`). When a tool call carries a `progressToken` in its `_meta`, the server emits intermediate progress notifications keyed by that token, then returns the final result.

**On-the-wire shape:**
```json
{
  "jsonrpc": "2.0",
  "method": "$/progress",
  "params": {
    "token": "<progressToken from request>",
    "value": {
      "kind": "pipeline-progress",
      "runId": "01HXYZ...",
      "stepId": "step3",
      "totalSteps": 5,
      "completedSteps": 2,
      "currentStepPct": 0.4,
      "etaMs": 90000,
      "message": "Decoding frame 1200/3000",
      "costUsdAccrued": 0.34
    }
  }
}
```

**Types:**
```ts
export interface MCPProgressValue {
  kind: 'pipeline-progress';
  runId: string;
  stepId?: string;
  totalSteps?: number;
  completedSteps?: number;
  currentStepPct?: number;
  etaMs?: number;
  message?: string;
  costUsdAccrued?: number;
  budgetWarning?: boolean;        // F4
}
```

**Mechanism details:**
- `ExecutionEventBus` (§0.3) emits `step-progress` events.
- MCP server bridges those to JSON-RPC progress notifications keyed by the active call's `progressToken`.
- **Throttling:** coalesce progress events to one per 500ms per stepId. Status-change events bypass coalescing.
- **Backpressure:** if the transport buffer is full, drop progress events; never status events.
- **Disconnect:** server-side stream continues to completion; result persists in state store. Caller reconnects via `pipeline.status(runId)`.

**Per-provider bridge:**

| Provider | Bridge mechanism |
|---|---|
| replicate | poll prediction endpoint every 2s; emit progress on `logs` change |
| fal | subscribe to fal queue events via SDK; emit on each event |
| deepgram (STT) | WS frames map 1:1 to progress events |
| openai (tts streaming) | bytes-received → estimate pct from `expected_chars` |
| anthropic (text streaming) | tokens-received → pct of `max_tokens` |
| others | no progress (single status event on completion) |

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Streaming provider | replicate prediction | progress events min 1/2s, terminal result |
| Non-streaming provider | openai image | single step-completed event, no intermediate progress |
| Mid-stream failure | provider errors after 30% | progress emitted, then step-failed |
| Cap trips mid-stream | F4 BudgetExceededError mid-stream | progress emitted, then step-failed with code=BUDGET_EXCEEDED |
| Client disconnect | MCP transport drops | server-side continues; state persisted |
| Reconnect via status | client calls pipeline.status(runId) after disconnect | replay event log from last seen seq |
| Backpressure | client slow | only status events delivered; progress dropped |
| Coalescing | provider emits 20 events in 500ms | one event delivered |

**Backwards-compat:** additive. Clients without `progressToken` see only the final result.

---

### F7. Webhook delivery for async provider jobs

**Value:** Replicate/Fal jobs take minutes. Suspend the pipeline; resume on webhook callback. Also: outbound webhook delivery for pipeline completion.

**Inbound (provider → us):**

**Routes** (registered in `packages/server`):
```
POST /webhooks/:provider/:runId
```

**Signature verification:**
```ts
interface WebhookEndpoint {
  provider: string;
  signatureHeader: string;
  verify(headers: Record<string, string>, body: string, key: string): Promise<boolean>;
}
```

Per-provider signature schemes:
| Provider | Scheme |
|---|---|
| replicate | webhook-signature header, svix-format HMAC-SHA256 |
| fal | x-fal-signature header, HMAC-SHA256(body) using webhook secret |
| deepgram | x-deepgram-signature header, HMAC-SHA256 |
| (others) | not yet supported for webhooks |

**Mechanism:**
1. Pipeline executor calls provider with `webhookUrl = server.baseUrl + '/webhooks/' + provider + '/' + runId`.
2. Step state transitions to `running`, run transitions to `suspended`.
3. Provider posts back to webhook URL.
4. Server verifies signature, looks up run via `findByExternalJobId(provider, jobId)`, applies the update, calls `pipeline.resume()` internally.
5. If webhook arrives after `maxWaitMs`, return 410 Gone and mark run failed.

**Outbound (us → caller):**

**Types:**
```ts
export interface AsyncConfig {
  webhookUrl?: string;
  onComplete: 'callback' | 'poll';
  pollIntervalMs?: number;       // for 'poll' mode; default 5000
  maxWaitMs?: number;            // default 1h
}

export interface PipelineSubscriptionRequest {
  runId: string;
  webhookUrl: string;
  events?: PipelineEvent['kind'][];
  headers?: Record<string, string>;
  secret?: string;               // HMAC key; if omitted, server generates and returns it
}
```

**API:**
```ts
// New MCP tool
pipeline.subscribe({
  runId: '01HXYZ',
  webhookUrl: 'https://yours.example/cb',
  events: ['run-completed', 'run-failed'],
})
// Returns: { subscriptionId, secret }
```

**Outbound delivery:**
- Each event POSTs `{ runId, event }` body with `X-Media-Pipeline-Signature: sha256=<hex>` header (HMAC of body using subscription secret).
- Retry on 5xx with exponential backoff: 1s, 5s, 30s, 5min, 30min. Max 5 attempts.
- Drop on terminal failure; log to event bus.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Valid inbound webhook | provider posts with valid HMAC | run resumes from suspended state |
| Invalid signature | tampered body | 401, log, run stays suspended |
| Unknown runId | webhook for deleted run | 404 |
| Wrong provider | replicate webhook to /webhooks/fal/:runId | 400 (WebhookProviderUnknownError) |
| Duplicate webhook | same jobId arrives twice | second is idempotent (no double-resume) |
| Late webhook | maxWaitMs passed | 410 Gone; run already terminal-failed |
| Outbound delivery success | subscriber URL returns 200 | delivered once, marked complete |
| Outbound retry | URL returns 503 | retried per backoff schedule |
| Outbound max retries exceeded | 5 failed attempts | logged and dropped |
| Outbound disabled events | subscribed only to run-completed; step-failed fires | not delivered |

**Backwards-compat:**
- `async` field optional in pipeline.execute. Default: `onComplete: 'poll'` (current behavior).
- `pipeline.subscribe` is a new tool.
- New webhook routes at `/webhooks/*` — does not collide with MCP transport at `/mcp`.

---

## Phase 2.2 — Smart routing

> **Builder note:** features F8–F10 are roadmap-level. Each needs its own `docs/features/F##-<slug>.md` design note to reach the Phase 2.1 specification bar before implementation.

### F8. Provider fallback chains with cost/quality routing

**Value:** "try Fal-Flux; if queue >30s or fails, fall back to Stability SDXL." The single biggest cost-saving feature.

**API:**
```ts
step: {
  operation: 'image.generate',
  route: {
    strategy: 'first-success' | 'cheapest-acceptable' | 'fastest',
    candidates: [
      { provider: 'fal',       model: 'flux-pro-1.1', maxQueueMs: 30000 },
      { provider: 'stability', model: 'sd3-medium',   maxUsd: 0.05 },
      { provider: 'replicate', model: 'sdxl' },
    ],
  },
}
```

**Mechanism:** new `Router` class in `packages/provider-core/router.ts`.
- `cheapest-acceptable`: estimateCost for all candidates, healthCheck each, pick lowest passing both maxUsd and health.
- `first-success`: try in order; on failure or `maxQueueMs` exceeded, try next.
- `fastest`: race all candidates, take first success, cancel others (only for ops with `expectedDurationMs < 5000`).

**Depends on:** F2 (cache for cancelled races), F4 (budget for cheapest-acceptable), F5 (estimates).

**Open before build:** how is `expectedDurationMs` computed? From pricing-table heuristic or empirical p95 latency?

---

### F9. A/B variant generation with gate-as-judge

**Value:** generate N variants in parallel → quality gate picks the winner → losers archived.

**API:**
```ts
step: {
  operation: 'image.generate',
  variants: { n: 4, judge: { type: 'llm-judge', criteria: 'best matches the prompt' } },
  inputs: { prompt: '...' },
}
```

**Depends on:** F2 (cache), F4 (budget — variants 4x a step's bill), F8 (routing for variant-per-provider).

---

### F10. Local-model adapters

**Value:** self-hosters plug in Ollama for llm-judge/embeddings, ComfyUI for image gen. Cost approaches zero.

**New packages:**
- `packages/ollama-provider`
- `packages/comfyui-provider`

**ComfyUI workflow registry:** workflows shipped as JSON in `src/workflows/*.json`. Users supply custom workflows via a `workflowsDir` config option.

**Depends on:** nothing — can ship parallel with Phase 2.1.

---

## Phase 2.3 — Workflow operations

> **Builder note:** roadmap-level; deepen to Phase 2.1 bar before starting.

### F11. Aspect-ratio fan-out
`image.generate({ ratios: ['1:1','9:16','16:9'] })` → three artifacts. Native ratio where supported; max-ratio + smart-crop fallback otherwise. **Depends on:** F2.

### F12. Subtitle pipeline as a first-class op
`video.subtitle({ artifactId, language, burnIn })` does STT → SRT → optional burn-in. ffmpeg as system requirement (documented); fallback via `@ffmpeg-installer/ffmpeg` for dev. **Depends on:** F2.

### F13. Voice/style consistency tracking
Pipeline-scoped `RunContext` carries `voices`, `styles`, `brandKit`. Resolved per step at execution. **Depends on:** nothing new.

### F14. Cross-provider loudness normalization
New quality-gate type `loudness` with action `normalize` (two-pass ffmpeg `loudnorm`) | `warn` | `fail`. **Depends on:** F12 ffmpeg integration.

### F15. CSV-driven batch generation
`pipeline.batch({ source: { type: 'csv', uri, columnMap }, concurrency, onRowFailure })`. Returns `{ batchId, runIds, reportArtifactId }`. Plus `pipeline.batch.retry({ batchId, onlyFailed: true })`. **Depends on:** F4 (per-run budget), F6 (whole-batch progress).

---

## Phase 2.4 — Safety and trust

> **Builder note:** roadmap-level.

### F16. Safety/moderation as a default-on gate
New gate type `safety`. Default-on for outputs. OpenAI moderation for text; image classifier from Replicate (`falcons-ai/nsfw_image_detection`) or local via F10.

### F17. C2PA / AI provenance signing
New `packages/provenance` using `c2pa-node`. KMS-backed signing keys (AWS KMS, GCP KMS, local PEM). Manifest includes model, prompt summary, pipeline DAG hash.

### F18. Multi-tenant API key vault
New `packages/keyvault` with `aws-secrets-manager`, `gcp-secret-manager`, `env`, `InMemoryKeyVault` implementations. Per-request tenant resolution; per-tenant cost ledger. RLS where the store supports it.

---

## Phase 2.5 — Surface expansion

> **Builder note:** roadmap-level.

### F19. MCP resources for artifacts
Expose `artifact://<id>` as MCP resources via `setResourceHandler`. Default per-session scope; per-tenant when F18 enabled.

### F20. Real-time STT streaming
`audio.transcribeStream` bridging Deepgram WS to MCP streaming. **Depends on:** F6.

### F21. 3D model generation
New `packages/meshy`, `packages/luma`, new `mesh.generate` op.

---

## Implementation order

```
                          0.1 Pipeline state store
                          0.2 Cost ledger
                          0.3 Event bus
                          0.4 MCP tool naming
                          0.5 Error class hierarchy
                          0.6 Provider interface additions
                                  │
                ┌─────────────────┼─────────────────┐
                ▼                 ▼                 ▼
    ┌──────────────────┐  ┌──────────────┐  ┌─────────────┐
    │ F1 Idempotency   │  │ F4 Budget    │  │ F6 Streaming│
    │ F2 Cache         │  │ F5 Estimate  │  │ F7 Webhooks │
    │ F3 Resume        │  │              │  │             │
    └──────────────────┘  └──────────────┘  └─────────────┘
                                  │
                                  ▼
                        ┌───────────────────┐
                        │ F8 Routing        │
                        │ F9 A/B variants   │
                        │ F10 Local models  │  ← can ship parallel
                        └───────────────────┘
                                  │
                                  ▼
                        ┌───────────────────┐
                        │ F11 Aspect fanout │
                        │ F12 Subtitles     │
                        │ F13 Voice context │
                        │ F14 Loudness      │
                        │ F15 CSV batch     │
                        └───────────────────┘
                                  │
                                  ▼
                        ┌───────────────────┐
                        │ F16 Safety gate   │
                        │ F17 C2PA          │
                        │ F18 Multi-tenant  │
                        └───────────────────┘
                                  │
                                  ▼
                        ┌───────────────────┐
                        │ F19 Resources     │
                        │ F20 STT stream    │
                        │ F21 3D gen        │
                        └───────────────────┘
```

Critical path: **0.1 → 0.2 → F3 (resume) → F8 (routing)**. Resume + routing together is the headline "I cut my bill 60%" story.

---

## Sizing (revised, in person-days)

| Item | Days | Notes |
|---|---|---|
| 0.1 PipelineStateStore | 3 | InMemory + Redis + locking; Postgres deferred |
| 0.2 CostLedger | 2 | Atomic Lua scripts for tenant index |
| 0.3 Event bus | 0.5 | Typed emitter + `await` |
| 0.4–0.6 Conventions | 1 | Tool naming, error classes, provider interface |
| **§0 subtotal** | **6.5** | |
| F1 Idempotency | 1.5 | Body hash canonicalization + edge cases |
| F2 Content cache | 4 | Per-provider normalization is the real work |
| F3 Resume | 4 | Locking + state machine + concurrent resume |
| F4 Budget caps | 2.5 | Per-provider estimate + streaming cap |
| F5 Dry-run | 1.5 | Warning surface + chained estimation |
| F6 Streaming | 3 | Backpressure + persistence + per-provider bridging |
| F7 Webhooks | 4 | Outbound delivery + HMAC + provider matrix |
| **Phase 2.1 subtotal** | **20.5** | |
| F8 Routing | 3 | Multi-strategy + health checks |
| F9 A/B variants | 1.5 | Mostly composition |
| F10 Local models | 4 | Ollama + ComfyUI (2 days each) |
| **Phase 2.2 subtotal** | **8.5** | |
| F11 Aspect fanout | 1.5 | Smart-crop fallback |
| F12 Subtitles | 3 | ffmpeg integration + burn-in |
| F13 Voice context | 1 | RunContext propagation |
| F14 Loudness | 1 | ffmpeg two-pass |
| F15 CSV batch | 2 | Standalone package |
| **Phase 2.3 subtotal** | **8.5** | |
| F16 Safety gate | 2 | Moderation API + image classifier |
| F17 C2PA | 8 | KMS + signing test fixtures (was 4 — under-sized) |
| F18 Multi-tenant | 10 | KeyVault + per-tenant ledger refactor + RLS (was 4 — under-sized) |
| **Phase 2.4 subtotal** | **20** | |
| F19 MCP resources | 1.5 | SDK plumbing |
| F20 STT stream | 2 | Deepgram WS bridge |
| F21 3D gen | 3 | Two providers + new op |
| **Phase 2.5 subtotal** | **6.5** | |
| **Grand total** | **70.5** | |

One engineer (focused): ~4–5 months calendar. Two engineers: ~2.5–3 months. Phase 2.1 alone: 27 days (one) / 14 days (two).

---

## Cross-cutting policies

### Feature flagging
Phase 2.1 features ship behind config flags in the server bootstrap. Default ON: F1, F4, F5. Default OFF (opt-in): F2, F3, F6, F7. Flags become defaults once a feature has shipped in two minor releases without regressions.

```ts
createMcpServer({
  features: {
    idempotency: true,
    contentCache: false,
    resumablePipelines: false,
    budgetCaps: true,
    dryRun: true,
    streaming: false,
    webhooks: false,
  },
});
```

### Observability hooks
Every Phase 2.1 feature emits:
- **OTel span:** `pipeline.<op>`, `cache.<lookup|store>`, `router.<decide>`, `webhook.<receive|deliver>`.
- **Metrics:** `mp_cache_hit_total`, `mp_cache_miss_total`, `mp_budget_exceeded_total`, `mp_webhook_received_total`, `mp_webhook_delivery_failures_total`, `mp_step_duration_seconds`.
- **Structured log fields:** `runId`, `tenantId`, `idempotencyKey`, `cacheKey` (where applicable).

### CI / runtime additions
- F12 subtitles needs **ffmpeg** — bundle `@ffmpeg-installer/ffmpeg` as a runtime dep for portability; document system-ffmpeg as a faster alternative.
- F2 cache + F3 resume need **Redis in CI** — add a `redis` service to `.github/workflows/ci.yml`.
- F7 webhooks need a tunneling story for local dev — document `ngrok` and `cloudflared` recipes in `docs/development.md`.
- F17 C2PA needs **test signing keys** — generate ephemeral PEM keys in test fixtures; KMS tests skipped unless credentials provided.

### Backwards-compatibility policy
- New optional fields: minor bump. Existing callers unaffected.
- New tools: minor bump.
- Field removal, required-field addition, tool removal/rename: major bump.
- Behavior change without API change (e.g., default cache on for image.generate): patch + prominent CHANGELOG note.

### Security review checkpoints
Required before merge:
- **F7 webhooks** — HMAC implementation, replay protection, constant-time signature comparison.
- **F17 C2PA** — key handling, KMS integration audit.
- **F18 multi-tenant** — tenant isolation, RLS verification, key vault access patterns.

### Performance acceptance criteria
Phase 2.1 feature gates:
- F1 idempotency lookup: p99 < 10ms.
- F2 cache lookup: p99 < 20ms; target hit rate ≥40% on iterative-prompt workloads.
- F3 resume state load: p99 < 50ms for runs with ≤10 steps.
- F4 budget preflight overhead: < 5ms per step.
- F6 streaming: progress delivered within 500ms of provider event.
- F7 webhook receive → resume: < 200ms.

Pipeline overhead (excluding provider call): p99 increase < 100ms vs Phase 1 baseline.

---

## Open decisions

Items still requiring product/tech-lead input before implementation starts.

1. **State store backend default.** Redis recommended for Phase 2.1. Postgres deferred to Phase 2.4. ✅ Decided.
2. **Cache key invariance.** Include provider+model version strings (not SDK version). ✅ Decided.
3. **Budget enforcement granularity.** Both per-run and per-tenant; per-tenant arrives with F18. ✅ Decided.
4. **Webhook security model.** HMAC default; mTLS documented for enterprise. ✅ Decided.
5. **Safety gate defaults.** Default-on for outputs adds ~$0.0001/call + ~100ms latency. **OPEN: confirm.**
6. **C2PA scope.** Sign generative outputs only, not derived transforms. **OPEN: confirm.**
7. **Multi-tenant deployment story.** Library-only for Phase 2; managed-service is Phase 3. **OPEN: confirm.**
8. **MCP resource lifecycle.** Session-scoped default; tenant-scoped with retention if F18 on. **OPEN: confirm.**
9. **Local-model adapter scope.** Ollama in Phase 2.2; ComfyUI as community-contributed package. **OPEN: confirm.**
10. **Batch failure semantics.** Surface partial success; `pipeline.batch.retry({ onlyFailed: true })`. ✅ Decided.
11. **F8 router timing source.** Pricing table-derived `expectedDurationMs` vs empirical p95 latency. **OPEN.**
12. **F2 cache scope default.** Global (cross-tenant) vs tenant (isolated). Recommend global for cost savings, tenant when F18 enabled. **OPEN.**

---

## Non-goals for Phase 2

Explicitly out of scope, to keep this finite:

- **Browser-side execution.** Server-side only. No WebGPU.
- **Custom model training.** Inference APIs and local inference servers only.
- **Real-time video transformation.** Live STT (F20) yes; live video filtering no.
- **General LLM-orchestration framework.** Media-pipeline-focused. Don't drift into LangChain territory.
- **GUI / admin dashboard.** CLI + MCP surface only; dashboards are downstream tools.
- **Custom pipeline DSL.** JSON over MCP is the surface. No YAML, no DAG-as-code.
- **Pipeline branching/forking.** Linear DAGs only in Phase 2; conditional branches deferred.
- **Streaming inputs to operations.** Inputs fully materialized before step starts (except F20 real-time STT).

---

## Per-feature documentation deliverables

For every F# at implementation time, ship:

1. `docs/features/F##-<slug>.md` — detailed design note (extends what's in this plan).
2. Package README update for any affected `packages/*/README.md`.
3. Root README package-table update for new packages.
4. One runnable `examples/NN-<slug>/` workspace member demonstrating the feature.
5. A changeset entry: `pnpm changeset` with the correct semver bump per §0.4.

---

_End of plan. This is the source of truth for Phase 2. Phase 2.1 is builder-ready. Each Phase 2.2+ feature must grow its own `docs/features/F##-<slug>.md` design note to the Phase 2.1 specification bar before implementation starts. The handoff for any Phase 2.1 feature is: "Build F#X per PHASE2_DEV_PLAN.md. Follow MONOREPO_SHAPE.md for repo-shape conventions. Stop when the test matrix passes and `pnpm build && pnpm lint && pnpm typecheck && pnpm test` are green."_
