# PHASE2_DEV_PLAN.md — media-pipeline-mcp

Target: 21 features that move this from a multi-provider wrapper to a production-grade media orchestration layer. Five phases. Each phase composes from primitives the previous phase introduced.

This document defines **what to build, the public API, the data shapes, the test matrix, and the dependencies between features.** It is structured as a builder-agent handoff: pick a phase, pick a feature, ship it without coming back with design questions.

**All five phases are specified to the builder-ready bar.** Every feature defines its public types, API surface, mechanism, per-provider implementation status (where applicable), test matrix, and backwards-compatibility note. A builder picks any F# and ships it without returning with design questions. A per-feature `docs/features/F##-<slug>.md` design note is only written at implementation time if the feature surfaces an issue this plan does not cover.

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

> **Status:** ✅ Shipped in 0.3.0

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

> **Status:** ✅ Shipped in 0.3.0

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
| deepgram | audio.stt | sha256(audio_bytes), model, language, all features | request_id |
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
- `image.generate`, `audio.stt`, `document.extract` → `mode: 'use'`.
- `audio.tts`, anything with explicit `seed: -1` → `mode: 'skip'`.

---

### F3. Resumable pipelines

> **Status:** ✅ Shipped in 0.3.0

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

**Affected:** `packages/pipeline/src/pipeline-operations.ts` (major refactor), `packages/server` (new tool).

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

> **Status:** ✅ Shipped in 0.3.0

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

> **Status:** ✅ Shipped in 0.3.0

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

> **Status:** ✅ Shipped in 0.3.0

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

> **Status:** ✅ Shipped in 0.3.0

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

After this phase, the same pipeline reliably picks the cheapest healthy provider, generates and judges variants, and runs against local models when available.

---

### F8. Provider fallback chains with cost/quality routing

> **Status:** ✅ Shipped in 0.3.0

**Value:** "try Fal-Flux; if queue >30s or fails, fall back to Stability SDXL." The single biggest cost-saving feature once paired with F2 cache and F5 estimates.

**Types** (`packages/provider-core/src/router.ts`):

```ts
import type { CostEstimate } from '@reaatech/media-pipeline-mcp-cost';
import type { ProviderInput, ProviderOutput } from '@reaatech/media-pipeline-mcp-provider-core';

export type RouterStrategy = 'first-success' | 'cheapest-acceptable' | 'fastest';

export interface RouteCandidate {
  provider: string;
  model: string;
  /** Skip this candidate if queue depth exceeds this many ms. */
  maxQueueMs?: number;
  /** Skip if its estimated upper-bound cost exceeds this many USD. */
  maxUsd?: number;
  /** Provider-specific input overrides (e.g., different prompt phrasing per model). */
  inputOverrides?: Record<string, unknown>;
  /** Weight when more than one candidate is acceptable; tiebreaker. Default 1. */
  weight?: number;
}

export interface RouteConfig {
  strategy: RouterStrategy;
  candidates: RouteCandidate[];
  /** Hard timeout for the whole routing attempt. Default: 5× slowest candidate's pricing.json expectedDurationMs. */
  timeoutMs?: number;
  /** Health-check cache TTL. Default 30s. */
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

export interface RouterContext {
  estimateCost(c: RouteCandidate, inputs: ProviderInput): Promise<CostEstimate>;
  health(c: RouteCandidate): Promise<{ healthy: boolean; latencyMs?: number; queueDepth?: number }>;
  execute(c: RouteCandidate, inputs: ProviderInput, signal: AbortSignal): Promise<ProviderOutput>;
}

export class Router {
  constructor(private ctx: RouterContext) {}
  route(config: RouteConfig, inputs: ProviderInput): Promise<{ decision: RouteDecision; output: ProviderOutput }>;
}
```

**API:**
```ts
step: {
  operation: 'image.generate',
  inputs: { prompt: '...' },
  route: {
    strategy: 'cheapest-acceptable',
    candidates: [
      { provider: 'fal',       model: 'flux-pro-1.1', maxQueueMs: 30000 },
      { provider: 'stability', model: 'sd3-medium',   maxUsd: 0.05 },
      { provider: 'replicate', model: 'sdxl' },
    ],
  },
}
```

**Strategy semantics:**

| Strategy | Behavior |
|---|---|
| `first-success` | Try candidates in array order. On `error`, `maxQueueMs` exceeded, or `BudgetExceededError`, move to next. Return first non-error result. |
| `cheapest-acceptable` | In parallel: compute `estimateCost` and `healthCheck` for every candidate. Filter out those failing `maxUsd`, `maxQueueMs`, or `healthy`. Pick lowest `usdHigh` (weight breaks ties). Execute exactly that one. |
| `fastest` | Race all candidates with `AbortController`s. First success wins; signal abort on the others. Only legal when **every** candidate's `pricing.json` reports `expectedDurationMs < 5000`; else throws `RouterFastestIneligibleError` at config-time. |

**Health signal sourcing:**

| Provider | Health probe (cached `healthTtlMs`) | Latency | Queue depth |
|---|---|---|---|
| openai | `GET /v1/models` | probe RTT | n/a (treated as 0) |
| stability | `GET /v1/user/account` | probe RTT | n/a |
| replicate | `GET /v1/predictions?limit=1` | probe RTT | p95 of last 20 in-process wait times |
| fal | fal SDK `getQueueRequests(modelId)` | n/a | reported by API |
| elevenlabs | `GET /v1/user` | probe RTT | n/a |
| deepgram | `GET /v1/projects` | probe RTT | n/a |
| anthropic | `GET /v1/models` | probe RTT | n/a |
| google | OAuth token refresh probe | probe RTT | n/a |
| ollama (F10) | `GET /api/tags` | probe RTT | n/a |
| comfyui (F10) | `GET /system_stats` | probe RTT | reported by API (`queue_remaining`) |
| provider-core mock | configurable | configurable | configurable |

`expectedDurationMs` lives in each provider's `pricing.json` as a peer of unit pricing per `(operation, model, size?)`. Absence ⇒ candidate is `fastest`-ineligible.

**Mechanism:**
1. Resolve candidate inputs (merge `inputOverrides` into the step inputs).
2. Per strategy, gate on `estimateCost` (F5) and `healthCheck`.
3. Wrap the selected execution in a cost-ledger preflight (F4).
4. On race cancellation (`fastest`), losers' provider calls are aborted via `AbortSignal`. Partial cost already incurred by losers is recorded in the ledger (provider may still bill for cancelled calls) and tagged `kind: 'race-loser'`.
5. If every candidate is rejected → `RouterAllCandidatesFailedError(attempted, lastError)`.
6. Record the `RouteDecision` on the step's event log so post-hoc analysis can see what was rejected and why.

**Affected:** `packages/provider-core/src/router.ts` (new), `packages/server/src/provider-router.ts` (existing per-request router — re-target callers to use `Router` from provider-core; old file becomes a thin adapter), `packages/pipeline/src/pipeline-operations.ts` (consumes route config per step).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| First-success happy path | candidate[0] succeeds | candidate[0] selected; `rejected = []` |
| First-success fallback | candidate[0] 500s; candidate[1] succeeds | candidate[1] selected; rejected[0].reason='error' |
| First-success queue limit | candidate[0] queue=60s, maxQueueMs=30s | candidate[0] skipped (queue-full); candidate[1] attempted |
| Cheapest picks lowest | A=$0.05, B=$0.02, C=$0.10 all healthy | B selected |
| Cheapest skips over-budget | A=$0.10 maxUsd=$0.05; B=$0.03 maxUsd=$0.05 | B selected |
| Cheapest skips unhealthy | A=cheapest but health=down | next-cheapest selected |
| Cheapest tiebreaker | A=B=$0.02; A.weight=2, B.weight=1 | A selected |
| Fastest race | A=200ms, B=400ms, both < 5s | A wins, B aborted (rejected.reason='cancelled') |
| Fastest disallowed | any candidate `expectedDurationMs >= 5000` | `RouterFastestIneligibleError` at config-time |
| All fail | every candidate errors | `RouterAllCandidatesFailedError` carrying full attempted list |
| Empty candidates | candidates=[] | `RouterNoCandidatesError` at config-time |
| Health cache | two routes within `healthTtlMs` | second skips health probe; one probe in total |
| Race cancellation accounting | fastest, loser's stream had partial output | loser cost charged to ledger tagged race-loser; selected cost normal |
| Composes with F4 budget | cheapest=$0.04, remaining=$0.03 | preflight blocks selected; falls to next within budget; if none fit, `BudgetExceededError` |
| Composes with F1 idempotency | same key, second call | re-uses prior decision from idempotency store; **does not re-route** |
| Composes with F2 cache | cheapest candidate would hit cache | cache check happens **after** routing; preflight cost rebated to $0 on hit |

**Backwards-compat:** purely additive. `step.route` is optional; absent ⇒ legacy single-provider `step.provider`/`step.model` path preserved.

---

### F9. A/B variant generation with gate-as-judge

> **Status:** ✅ Shipped in 0.3.0

**Value:** generate N variants in parallel; an LLM-judge or rule-based gate picks the winner; losers archived for review and re-judgement.

**Types** (`packages/pipeline/src/variants.ts`):

```ts
export interface VariantsConfig {
  n: number;                                // 2..16
  seedStrategy?: 'random' | 'sequential' | 'fixed-list';
  seeds?: number[];                         // required if seedStrategy='fixed-list'
  judge: JudgeConfig;
  /** What to do with non-winners. Default 'archive' (kept in artifact registry, tagged loser). */
  loserAction?: 'archive' | 'discard';
  /** If step.route is also defined, distribute variants across candidates round-robin. */
  perVariantCandidate?: boolean;
  /** Threshold for the judge's score; variants below this are rejected pre-pick. Default 0. */
  minScore?: number;
}

export type JudgeConfig =
  | { type: 'llm-judge'; criteria: string; model?: string; provider?: string; rubric?: JudgeRubric }
  | { type: 'image-judge'; criteria: 'clip-score' | 'aesthetic'; reference?: string }
  | { type: 'rule'; expression: string }      // JSONata-like, evaluated against each variant's outputs
  | { type: 'custom'; toolName: string };     // MCP tool with signature (VariantInput[]) -> { winnerIndex, rationale? }

export interface JudgeRubric {
  /** Weights sum to 1.0. */
  dimensions: Array<{ name: string; weight: number; description: string }>;
}

export interface VariantResult {
  variantIndex: number;
  artifactId?: string;                      // absent if generation failed
  costUsd: number;
  judgeScore?: number;                      // 0..1
  judgeRationale?: string;
  winner: boolean;
  rejected?: 'safety' | 'judge-low' | 'gate-fail' | 'generation-error';
  generationError?: { code: string; message: string };
}

export interface VariantsStepOutput {
  winner?: VariantResult;                   // absent if every variant rejected
  losers: VariantResult[];
  totalCostUsd: number;
  judgeUsdCost: number;
}
```

**API:**
```ts
step: {
  operation: 'image.generate',
  inputs: { prompt: '...' },
  variants: {
    n: 4,
    seedStrategy: 'sequential',
    judge: { type: 'llm-judge', criteria: 'best matches the prompt with no compositional errors', model: 'claude-sonnet-4-6' },
    loserAction: 'archive',
  },
}
```

**Judge implementations:**

| Judge type | Backend | Cost source | Notes |
|---|---|---|---|
| `llm-judge` | anthropic (default), openai, google, ollama (F10) | per-token via F5 | structured-output prompt; expects `{ winner_index, scores[], rationale }` |
| `image-judge / clip-score` | in-process CLIP model (`@xenova/transformers` ONNX) | $0 | cosine sim vs prompt or `reference` image |
| `image-judge / aesthetic` | replicate `improved-aesthetic-predictor` (default), local via F10 | per-call | uses Laion aesthetic score 0..10 normalized to 0..1 |
| `rule` | in-process expression evaluator | $0 | e.g., `outputs.metadata.score > 0.7 && outputs.width >= 1024` |
| `custom` | any registered MCP tool | per-call | tool receives `{ variants: VariantInput[] }`; returns `{ winnerIndex, rationale? }` |

**Mechanism:**
1. Generate N variant input sets per `seedStrategy`. If `perVariantCandidate=true` and `step.route.candidates.length >= 1`, distribute variants round-robin across candidates.
2. Fan out in parallel under a single F4 budget preflight (sum of estimates × N).
3. After all variants resolve (success or generation-error), assemble judge input.
4. Run judge:
   - `llm-judge`: prompt embeds variant references (use F19 resources if enabled) and the criteria; judge response parsed; cost tagged `kind: 'judge'`.
   - `image-judge`: scored locally or via the named backend; no judge prompt round-trip.
   - `rule`: scores any variant where the expression is truthy = 1.0, else 0.0; first highest-scored wins.
   - `custom`: invoked once with the full variant set.
5. Apply `minScore` filter and safety gate (F16) before picking winner. If all variants are rejected → `VariantsAllRejectedError(reason)`.
6. Mark winner; loser artifacts tagged `pipeline:loser` in storage. `loserAction=discard` deletes them immediately.
7. Emit `step-completed` carrying `VariantsStepOutput`.

**Affected:** `packages/pipeline/src/variants.ts` (new), `packages/pipeline/src/pipeline-operations.ts` (variants branch), `packages/storage` (loser-tagging metadata), `packages/server` (no new tool — variants is a step option).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| LLM judge happy path | n=4, llm-judge | winner has highest judgeScore; 3 losers archived |
| Score tie | two variants score 0.95 | first index wins; rationale notes tie |
| Judge unavailable | judge model 500s | `JudgeUnavailableError`; variants returned with no winner; losers archived if action=archive |
| All variants fail safety | n=4, every output blocked by F16 | `VariantsAllRejectedError(reason='safety')` |
| Partial generation failure | 3/4 succeed | judge sees 3; selects winner; failed variant has `rejected='generation-error'` |
| Below `minScore` | n=4, best score=0.4, minScore=0.7 | `VariantsAllRejectedError(reason='judge-low')` |
| F2 cache | same prompt+seed run twice | second run's variants are cache hits; judge runs again (judge results are not cached by default) |
| F4 budget interaction | n=4 × $0.05 each, budget=$0.15 | preflight blocks; depending on `onExceed`, aborts or suspends |
| Per-variant candidate | n=3, route.candidates=[A,B,C] | one variant per candidate |
| Image judge / CLIP | n=4 image-gen | CLIP embeds locally; highest cosine to prompt wins; judge cost=$0 |
| Custom judge | tool `tools/my-judge` returns winnerIndex=2 | variant 2 wins |
| Rule judge | rule: `outputs.metadata.score > 0.7` | first matching wins; if none, `VariantsAllRejectedError` |
| Loser action=discard | losers exist | loser artifacts deleted; only winner persists |
| Composes with F8 routing | per-variant candidates from a router | each variant's `decision` recorded; sum-of-routes cost tallied |

**Backwards-compat:** additive. `variants` field optional. Composes with F2 (cache), F4 (budget), F8 (routing), F16 (safety).

---

### F10. Local-model adapters

> **Status:** ✅ Shipped in 0.3.0

**Value:** self-hosters plug in Ollama for llm-judge/embeddings and ComfyUI for image gen. Cost approaches zero for high-volume internal use. Ships parallel with Phase 2.1 — no dependency on F1–F7.

**New packages:**

| Package | npm name | Operations |
|---|---|---|
| `packages/ollama` | `@reaatech/media-pipeline-mcp-ollama` | `text.complete`, `embedding.generate`, `image.describe` (multimodal) |
| `packages/comfyui` | `@reaatech/media-pipeline-mcp-comfyui` | `image.generate`, `image.edit`, `video.generate` (per workflow) |

**Ollama provider:**

```ts
// packages/ollama/src/ollama-provider.ts
export interface OllamaConfig {
  baseUrl: string;                          // default 'http://localhost:11434'
  defaultModel?: string;                    // e.g., 'llama3.1:8b'
  timeoutMs?: number;                       // default 120_000
  /** Headers for reverse-proxy auth. */
  headers?: Record<string, string>;
  /** Pull model on first use if not present. Default false. */
  autoPull?: boolean;
}

export class OllamaProvider extends BaseProvider {
  static readonly id = 'ollama';
  supportsStreaming = new Set(['text.complete', 'embedding.generate']);
  // estimateCost always returns { usdLow: 0, usdHigh: 0 }
  // healthCheck: GET /api/tags
}
```

**ComfyUI provider:**

```ts
// packages/comfyui/src/comfyui-provider.ts
export interface ComfyUIConfig {
  baseUrl: string;                          // default 'http://localhost:8188'
  /** Path to user-supplied workflow JSON files. */
  workflowsDir?: string;
  /** Copy outputs to the storage backend rather than leaving them in ComfyUI's output dir. */
  downloadOutputs?: boolean;
  pollIntervalMs?: number;                  // default 1000
  /** Server-side workflow retention before output cleanup. Default 600s. */
  retentionMs?: number;
}

export interface ComfyUIWorkflow {
  name: string;
  apiFormat: object;                        // ComfyUI's "API format" graph, parameterized
  inputs: Record<string, ComfyParamSpec>;
  outputs: Record<string, 'image' | 'video' | 'mask' | 'latent'>;
}

export interface ComfyParamSpec {
  path: string;                             // dotted path into apiFormat (e.g., 'nodes.6.inputs.text')
  type: 'string' | 'number' | 'boolean' | 'enum';
  enum?: string[];
  default?: unknown;
  required?: boolean;
}
```

**Built-in workflows** (shipped in `packages/comfyui/src/workflows/*.json`):

| Slug | Operation | Underlying model |
|---|---|---|
| `sdxl-text2img` | image.generate | Stable Diffusion XL base |
| `sdxl-img2img` | image.edit | Stable Diffusion XL base + denoising |
| `flux-text2img` | image.generate | Black Forest Labs Flux.1-dev |
| `svd-img2vid` | video.generate | Stable Video Diffusion |

User workflows discovered at construction time from `workflowsDir`. Selecting a workflow uses `model: 'workflow:<slug>'` (built-ins) or `model: 'workflow:custom/<file-basename>'`.

**API examples:**

```ts
// Ollama as text generator
{ provider: 'ollama', model: 'llama3.1:8b', operation: 'text.complete',
  inputs: { prompt: '...', max_tokens: 500 } }

// Ollama as F9 judge backend
variants: { n: 4, judge: { type: 'llm-judge', provider: 'ollama', model: 'llama3.1:8b', criteria: '...' } }

// ComfyUI image generation
{ provider: 'comfyui', model: 'workflow:sdxl-text2img', operation: 'image.generate',
  inputs: { prompt: '...', steps: 25, cfg: 7, width: 1024, height: 1024, seed: 42 } }
```

**Mechanism (ComfyUI):**
1. On provider construction, load built-in + `workflowsDir/*.json` and validate each against the workflow shape.
2. Per execution: clone the workflow's `apiFormat`, write inputs at their declared `path`s, POST `/prompt` → `{ prompt_id }`.
3. Persist `prompt_id` to step state immediately (enables F3 resume).
4. Poll `/history/<prompt_id>` every `pollIntervalMs`. Emit `step-progress` based on `executing` node count vs total nodes.
5. On completion, fetch each output via `/view?filename=...&subfolder=...&type=output` and persist to storage. Return artifact IDs.
6. On disconnect mid-poll, F3 resume re-attaches by re-polling the same `prompt_id` (ComfyUI retains outputs for `retentionMs`).
7. If `prompt_id` is no longer in `/history` (past retention) → `WorkflowExpiredError` (retryable=false).

**Per-implementation features:**

| Feature | Ollama | ComfyUI |
|---|---|---|
| `estimateCost` | `{ usdLow: 0, usdHigh: 0 }` | `{ 0, 0 }` |
| Streaming (F6) | yes (SSE per token) | yes (per-node progress) |
| Webhooks (F7) | no | no |
| `healthCheck` | `GET /api/tags` | `GET /system_stats` (also reports `queue_remaining`) |
| Cache (F2) | text non-det by default | det per fixed `seed`; cache enabled when seed is provided and non-negative |
| Variants (F9) | as `llm-judge` backend | as image-gen backend |
| Resume (F3) | trivial (synchronous-ish) | resumes via persisted `prompt_id` |

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Ollama text completion | local server up | result returned, cost=$0 |
| Ollama streaming | progressToken on text.complete | per-token events, then final result |
| Ollama auto-pull | `autoPull=true`, model absent | provider pulls model, then runs |
| Ollama server down | `ECONNREFUSED` | `ProviderUnavailableError` (retryable) |
| Ollama as F9 judge | provider=ollama in JudgeConfig | judge runs locally; judge cost=$0 |
| ComfyUI builtin workflow | `model: 'workflow:sdxl-text2img'` | image returned and stored |
| ComfyUI custom workflow | workflowsDir has `my-flow.json` | `model: 'workflow:custom/my-flow'` resolves |
| ComfyUI unknown workflow | `model: 'workflow:nope'` | `WorkflowNotFoundError` at execute |
| ComfyUI param mismatch | workflow needs `cfg`, inputs provide `cfg_scale` | `InvalidInputError` listing missing/extra params |
| ComfyUI resume | restart mid-poll | re-attaches via `prompt_id`; same outputs |
| ComfyUI expired | resume after `retentionMs` | `WorkflowExpiredError` |
| ComfyUI download outputs | `downloadOutputs=true` | files copied to configured storage backend, not just ComfyUI's dir |
| F8 routing with local | strategy=cheapest-acceptable, ollama+openai | ollama wins (always $0) |
| F4 budget | run includes ollama and openai steps | preflight returns $0 for ollama; only openai counted against cap |
| F2 cache (ComfyUI) | same seed + workflow | cache hit, no provider call |

**Backwards-compat:** purely additive; new packages, no changes to existing providers.

---

## Phase 2.3 — Workflow operations

Adds the high-leverage media verbs that pipelines tend to assemble manually today: ratio fan-out, subtitles, voice/style propagation, loudness normalization, and CSV-driven batches.

---

### F11. Aspect-ratio fan-out

> **Status:** ✅ Shipped in 0.3.0

**Value:** `image.generate({ ratios: ['1:1','9:16','16:9'] })` returns three artifacts in one step — native ratios where the provider supports them, max-ratio + smart-crop fallback otherwise.

**Types** (`packages/pipeline/src/ratios.ts`):

```ts
export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9' | '3:2' | '2:3' | '21:9' | string;
// custom: `${W}:${H}` validated W,H ∈ 1..32

export interface RatioFanOutConfig {
  ratios: AspectRatio[];
  /** Strategy when a provider cannot natively produce a ratio. Default 'smart-crop'. */
  fallback?: 'smart-crop' | 'fail' | 'pad';
  /** Use the largest native ratio as the crop source. If false, render each ratio independently. Default true. */
  reuseLargest?: boolean;
  /** For smart-crop fallback: keep faces in-frame. Default true. */
  faceAware?: boolean;
  /** For 'pad' fallback: pad color. Default '#000000'. */
  padColor?: string;
}

export interface RatioResult {
  ratio: AspectRatio;
  artifactId: string;
  source: 'native' | 'cropped' | 'padded';
  /** When source != 'native', the artifact ID this was derived from. */
  derivedFrom?: string;
  width: number;
  height: number;
}

export interface RatioFanOutOutput {
  variants: RatioResult[];
  totalCostUsd: number;
}
```

**API:**
```ts
step: {
  operation: 'image.generate',
  inputs: { prompt: '...' },
  ratios: { ratios: ['1:1', '9:16', '16:9'], fallback: 'smart-crop', faceAware: true },
}
```

**Per-provider native-ratio support:**

| Provider | Operation | Native ratios | Notes |
|---|---|---|---|
| openai | image.generate (dall-e-3) | 1:1, 16:9 (1024×1792 swapped), 9:16 (1792×1024 swapped) | size param: 1024×1024 / 1024×1792 / 1792×1024 |
| stability | image.generate (sd3-medium) | 1:1, 16:9, 21:9, 2:3, 3:2, 4:5, 5:4, 9:16 | aspect_ratio param |
| replicate (sdxl) | image.generate | any W,H ∈ {512,768,1024,1152,1216,1344,1536} | quantize to nearest valid pair |
| fal (flux-pro) | image.generate | 1:1, 4:3, 3:4, 16:9, 9:16 | image_size param |
| google (imagen) | image.generate | 1:1, 9:16, 16:9, 3:4, 4:3 | aspectRatio param |
| comfyui (F10) | per workflow | width/height inputs; quantization per workflow | |

**Fallback mechanism:**
1. Partition requested ratios into `native` (the provider supports directly) and `derived`.
2. Generate native ratios as separate provider calls (cached independently via F2).
3. For `derived`:
   - `smart-crop`: pick the largest native ratio's artifact as the source. Detect a salient region (entropy-based; `faceAware=true` also runs MediaPipe Face Detection in-process and weights face bboxes). Crop to the target ratio centered on the salient region. ffmpeg `crop` filter for non-image ops.
   - `pad`: letterbox with `padColor` to reach the target ratio's bounding box around the largest native artifact.
   - `fail`: throw `RatioUnsupportedError(ratio, provider)`.
4. Persist each result with `derivedFrom` linking the source.

**Cost accounting:** native variants charged normally; cropped/padded variants charge $0 (post-processing only). Total reported in `RatioFanOutOutput.totalCostUsd`.

**Affected:** `packages/pipeline/src/ratios.ts` (new), `packages/pipeline/src/pipeline-operations.ts` (ratios branch on image/video ops), `packages/image-edit` (smart-crop + pad utilities reused), `packages/video-gen` (ffmpeg crop integration shared with F12).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| All native | openai, ratios=[1:1,9:16,16:9] | 3 native calls, no crops; cost=3× |
| Mixed | sdxl, ratios=[1:1, 21:9] | 1:1 native; 21:9 cropped from 1:1; cost=2× one native call |
| `reuseLargest=true` | sd3, ratios=[1:1, 9:16, 4:5] | one largest-native call (e.g., 9:16 base), 1:1 and 4:5 cropped |
| `reuseLargest=false` | sd3, ratios=[1:1, 9:16] | two native calls; no derived |
| `fallback=fail` | provider can't do 21:9 | `RatioUnsupportedError` |
| `fallback=pad` | provider does 16:9, asked 1:1 | source 16:9 padded with `padColor` to fit a 1:1 bbox |
| Face-aware crop | face detected near edge | crop window biased to keep face whole |
| F2 cache | re-run same prompt + ratios | native artifacts cached; crops recomputed only if missing |
| Custom ratio | `'7:3'` | accepted (validated 1..32), routed to largest-native + crop |
| Invalid ratio | `'0:1'` | `InvalidInputError` at parse |
| Video op | video.generate ratios=[16:9, 9:16] | ffmpeg crop applied to derived; cost=1× native |

**Backwards-compat:** `ratios` field optional. Existing single-artifact response preserved when absent.

---

### F12. Subtitle pipeline as a first-class op

> **Status:** ✅ Shipped in 0.3.0

**Value:** one operation does STT → SRT → optional burn-in. Today users glue Deepgram and ffmpeg by hand.

**New operation:** `video.subtitle` (in `packages/video-gen`).

**Types** (`packages/video-gen/src/subtitle.ts`):

```ts
export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleConfig {
  artifactId: string;                       // input video or audio
  language?: string;                        // BCP-47; auto-detect if absent
  format?: SubtitleFormat;                  // default 'srt'
  /** STT provider override. Default: project default; resolves through F8 if `route` set. */
  sttProvider?: string;
  sttModel?: string;
  burnIn?: BurnInOptions;                   // omit = sidecar only
  /** Speaker labels (Deepgram diarization). Default false. */
  diarize?: boolean;
  /** Translate to target language using anthropic/google. */
  translateTo?: string;
}

export interface BurnInOptions {
  font?: string;                            // default 'Inter'
  fontSize?: number;                        // px at 1080p, scaled. Default 32
  fontColor?: string;                       // default '#FFFFFF'
  outline?: { color: string; widthPx: number }; // default { '#000000', 2 }
  position?: 'top' | 'middle' | 'bottom';   // default 'bottom'
  marginPx?: number;                        // default 60 at 1080p
  /** Box behind text for legibility. */
  background?: { color: string; opacity: number };
}

export interface SubtitleOutput {
  subtitleArtifactId: string;               // .srt/.vtt/.ass sidecar
  burnedArtifactId?: string;                // present only if burnIn set
  language: string;
  segments: SubtitleSegment[];
  totalCostUsd: number;
}

export interface SubtitleSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;                         // diarized
  confidence?: number;
}
```

**API:**
```ts
{ operation: 'video.subtitle',
  inputs: { artifactId: 'art_1', language: 'en', format: 'srt', burnIn: { fontSize: 28 } } }
```

**Mechanism:**
1. Resolve input artifact; if it's a video, extract audio (`ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 out.wav`).
2. Run STT via provider (Deepgram default; OpenAI Whisper as alternate). Emit `step-progress` per STT chunk.
3. Build subtitle segments respecting max line length (42 chars) and CPS limit (17). Merge runs from the same speaker within 200ms gaps.
4. If `translateTo` set: run a text-translate sub-step (anthropic by default) preserving segment boundaries.
5. Encode to chosen format:
   - `srt`: numbered blocks with `HH:MM:SS,ms` timestamps.
   - `vtt`: WebVTT with `HH:MM:SS.ms` and `WEBVTT` header.
   - `ass`: Advanced SubStation Alpha with `[Script Info]`, `[V4+ Styles]`, `[Events]`.
6. Persist sidecar artifact.
7. If `burnIn` set: ffmpeg pass with `subtitles` filter for srt/vtt or `ass` filter for ass. Render at source resolution and codec; libx264 + CRF 18 default.
8. Emit `SubtitleOutput`.

**ffmpeg runtime contract:**
- Production: system ffmpeg required (documented in `docs/development.md`). Detected via `which ffmpeg` at server bootstrap; absence emits a startup warning if any video op is enabled.
- Dev fallback: `@ffmpeg-installer/ffmpeg` as a `devDependencies` peer; loaded if system ffmpeg is missing.
- All ffmpeg invocations go through `packages/video-gen/src/ffmpeg.ts` wrapper which logs the full command line for reproducibility.

**Per-STT-provider notes:**

| Provider | Diarization | Languages | Streaming progress |
|---|---|---|---|
| deepgram | yes (`diarize=true`) | 30+ | WS streamed; native progress |
| openai (whisper-1) | no | 99 | one-shot; progress via bytes-read |
| google (chirp) | yes | 100+ | streaming via Vertex |

**Affected:** `packages/video-gen/src/subtitle.ts` (new), `packages/video-gen/src/ffmpeg.ts` (new wrapper, also used by F14), `packages/server` (registers `video.subtitle`), pipeline.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Audio in, SRT out | mp3 input, format=srt | sidecar .srt with valid segments |
| Video in, sidecar only | mp4 input, no burnIn | sidecar; no derived video |
| Burn-in default | mp4 + burnIn={} | new mp4 with subtitles rendered |
| Diarization | diarize=true, deepgram | segments carry `speaker` |
| Translation | en→es, translateTo=es | translated text, original timing |
| Auto-detect language | language absent | language set in output from STT |
| ASS format with positioning | format=ass, burnIn.position=top | ass styling reflects position |
| Long line wrap | one 80-char utterance | split into two lines under 42 chars each |
| ffmpeg missing | no system ffmpeg, no fallback installed | startup warning; op throws `FfmpegUnavailableError` |
| F2 cache | same artifactId + params | cached subtitle artifact returned, no STT call |
| F6 streaming | progressToken | per-chunk progress as STT progresses |
| Cost accounting | STT $0.012, no burn-in | totalCostUsd = STT only |
| CPS over limit | dense audio, > 17 cps | segments split to respect cps |

**Backwards-compat:** new operation; no existing tool changed. ffmpeg becomes a documented runtime requirement for any installation enabling video ops.

---

### F13. Voice/style consistency tracking

> **Status:** ✅ Shipped in 0.3.0

**Value:** today, agents repeat the same voice ID / style descriptor on every TTS and image step. Define them once at pipeline scope; reference by name in each step.

**Types** (`packages/pipeline/src/run-context.ts`):

```ts
export interface RunContext {
  voices?: Record<string, VoiceRef>;
  styles?: Record<string, StyleRef>;
  brandKit?: BrandKit;
  /** Free-form variables for downstream operations. */
  vars?: Record<string, unknown>;
}

export interface VoiceRef {
  /** Resolves to a provider voice id. */
  provider: 'elevenlabs' | 'openai' | 'google' | 'deepgram-tts';
  voiceId: string;
  /** Provider-specific voice settings (stability, similarity_boost, etc.). */
  settings?: Record<string, unknown>;
}

export interface StyleRef {
  /** Reusable text descriptor injected into prompts. */
  description: string;
  /** Optional negative descriptor for image gen. */
  negative?: string;
  /** Per-provider override blocks. */
  perProvider?: Record<string, { description?: string; negative?: string }>;
}

export interface BrandKit {
  primaryColor?: string;                    // hex
  secondaryColor?: string;
  fontFamily?: string;
  logoArtifactId?: string;
  /** Free-form for downstream consumption (watermarks, subtitle styling, etc.). */
  extras?: Record<string, unknown>;
}

export type ContextRef =
  | { kind: 'voice'; name: string }
  | { kind: 'style'; name: string }
  | { kind: 'brand'; key: keyof BrandKit };
```

**API:**
```ts
pipeline.execute({
  context: {
    voices: { narrator: { provider: 'elevenlabs', voiceId: '...', settings: { stability: 0.6 } } },
    styles: { hero:    { description: 'cinematic, golden hour, shallow depth of field' } },
    brandKit: { primaryColor: '#FF6B35', fontFamily: 'Inter' },
  },
  steps: [
    { id: 's1', operation: 'audio.tts',
      inputs: { text: '...', voice: { $ref: { kind: 'voice', name: 'narrator' } } } },
    { id: 's2', operation: 'image.generate',
      inputs: { prompt: 'cyberpunk skyline', style: { $ref: { kind: 'style', name: 'hero' } } } },
  ],
})
```

**Resolution rules:**

| Reference target | Resolves to |
|---|---|
| `voice` in `audio.tts` | provider+voiceId+settings merged into step `inputs` |
| `style` in `image.generate` | concatenated to `inputs.prompt` (description) and `inputs.negative_prompt` (negative); `perProvider` overrides win per active provider |
| `style` in `video.generate` | same as image |
| `brand.primaryColor` etc. | replaced inline anywhere `{ $ref: { kind: 'brand', key: 'primaryColor' } }` appears |
| Unknown name | `ContextRefUnknownError(kind, name)` at step-prepare time |
| Type mismatch | `ContextRefTypeError(stepOp, refKind)` |

**Mechanism:**
- `RunContext` is part of the `PipelineRun` data (persisted via §0.1). Resolution happens at step-prepare, after F8 routing decides the candidate (so `perProvider` lookups know the provider).
- All resolutions are pure (no I/O), so they participate in F2 cache key computation: the resolved value contributes to the deterministic input hash, not the raw `$ref` token.
- Context is immutable per run. `pipeline.resume` reuses the persisted context.

**Affected:** `packages/pipeline/src/run-context.ts` (new), `packages/pipeline/src/pipeline-operations.ts` (resolver), `packages/server` (validates context at pipeline.execute time).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Voice ref happy path | TTS step with `voice.$ref` | resolved to elevenlabs voiceId+settings |
| Style ref happy path | image-gen with style.$ref | description appended to prompt |
| Per-provider style | hero.perProvider.openai overrides description | active provider=openai → override used |
| Brand color ref | { $ref: { kind: 'brand', key: 'primaryColor' } } in prompt | inline-replaced with hex |
| Unknown ref name | { $ref: { kind: 'voice', name: 'nope' } } | `ContextRefUnknownError` |
| Type mismatch | style $ref in audio.tts inputs | `ContextRefTypeError` |
| Resume reuses context | run resumed | persisted context replayed; no re-validation needed |
| F2 cache | same prompt + same style ref | hits cache after resolution |
| F8 routing changes provider | second attempt uses different candidate | `perProvider` override re-applied for new candidate |

**Backwards-compat:** additive. Pipelines without `context` behave exactly as today.

---

### F14. Cross-provider loudness normalization

> **Status:** ✅ Shipped in 0.3.0

**Value:** TTS from different vendors land at different LUFS levels. A new quality gate normalizes any audio/video artifact to broadcast-spec loudness.

**Types** (`packages/quality-gates` — new domain inside `packages/pipeline/src/gates/loudness.ts`):

```ts
export type LoudnessAction = 'normalize' | 'warn' | 'fail';

export type LoudnessPreset = 'youtube' | 'spotify' | 'podcast' | 'broadcast-ebu' | 'broadcast-atsc';

export interface LoudnessTarget {
  /** Integrated loudness in LUFS. */
  iLufs: number;
  /** Loudness range in LU. */
  lra: number;
  /** True-peak ceiling in dBTP. */
  tpDb: number;
}

export interface LoudnessGate {
  type: 'loudness';
  /** Choose preset OR target. preset wins if both present. */
  preset?: LoudnessPreset;
  target?: LoudnessTarget;
  /** Tolerance band for 'warn'/'fail'. Default 1.0 LU on iLufs. */
  toleranceLu?: number;
  action: LoudnessAction;
  /** If 'normalize', reuse the artifact ID for output. Default false (creates derived artifact). */
  inPlace?: boolean;
}

export interface LoudnessVerdict {
  measured: { iLufs: number; lra: number; tpDb: number };
  target: LoudnessTarget;
  status: 'within-tolerance' | 'out-of-tolerance';
  action: LoudnessAction;
  resultArtifactId?: string;                // present if action='normalize'
  delta?: { iLufs: number; lra: number; tpDb: number };
}
```

**Built-in presets:**

| Preset | iLufs | LRA | TP |
|---|---|---|---|
| `youtube` | -14 | 11 | -1.0 |
| `spotify` | -14 | 11 | -1.0 |
| `podcast` | -16 | 10 | -1.0 |
| `broadcast-ebu` | -23 | 10 | -1.0 |
| `broadcast-atsc` | -24 | 10 | -2.0 |

**API:**
```ts
step: {
  id: 's3',
  operation: 'audio.tts',
  inputs: { text: '...', voice: 'narrator' },
  gates: [
    { type: 'loudness', preset: 'podcast', action: 'normalize' },
  ],
}
```

**Mechanism (two-pass ffmpeg loudnorm):**
1. **Measure** — `ffmpeg -i in -af loudnorm=I=<i>:LRA=<lra>:TP=<tp>:print_format=json -f null -`. Parse JSON for measured `input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`.
2. Determine `status`. If `within-tolerance`:
   - `action=normalize`: skip pass 2; return original artifactId.
   - `action=warn` / `fail`: return verdict, no work.
3. If `out-of-tolerance`:
   - `action=fail`: throw `LoudnessGateFailedError(verdict)`.
   - `action=warn`: emit warning event, do not modify.
   - `action=normalize`: **pass 2** — `ffmpeg -i in -af loudnorm=I=<i>:LRA=<lra>:TP=<tp>:measured_I=<input_i>:measured_LRA=<input_lra>:measured_TP=<input_tp>:measured_thresh=<input_thresh>:offset=<target_offset>:linear=true:print_format=summary -c:a libopus out`. (For video, copy video stream: `-c:v copy`.)
4. Persist result. If `inPlace=true`, replace the source artifact; else create derived artifact linking to source.

**Cost accounting:** ffmpeg runs locally → $0.00 cost recorded against the gate. The gate runs **after** the step's provider call; its measurement does not block the F4 preflight.

**Affected:** `packages/pipeline/src/gates/loudness.ts` (new), `packages/pipeline/src/pipeline-operations.ts` (gate dispatch), shared ffmpeg wrapper from F12.

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Within tolerance, normalize | measured=-15.5, target=-16, tol=1 | status=within-tolerance; no pass 2; original artifact returned |
| Out of tolerance, normalize | measured=-22, target=-16 | pass 2 runs; derived artifact returned at -16±0.5 |
| Action=warn, out of tolerance | measured=-22, target=-16 | warn event; artifact unchanged |
| Action=fail, out of tolerance | same | `LoudnessGateFailedError` |
| inPlace=true | normalize, inPlace=true | source artifact replaced (same ID, new bytes) |
| Preset overrides target | both fields set | preset used |
| Custom target | target only | target used |
| Video input | mp4 | audio stream normalized, video stream copied |
| ffmpeg missing | no ffmpeg | `FfmpegUnavailableError` (same path as F12) |
| Cost recorded | any normalize | cost ledger entry $0 tagged `kind: 'gate'` |
| Composes with F3 resume | failed during pass 2 | resume re-runs pass 2 only; measurement persists |

**Backwards-compat:** purely additive new gate type; absent ⇒ no behavior change.

---

### F15. CSV-driven batch generation

> **Status:** ✅ Shipped in 0.3.0

**Value:** "1000 blog posts → 1000 hero images." One MCP call. Per-row failure handling. Resumable.

**New MCP tools** (in `packages/server`):

| Tool | Purpose |
|---|---|
| `pipeline.batch` | start a batch run |
| `pipeline.batch.status` | get progress / report |
| `pipeline.batch.retry` | retry failed rows |
| `pipeline.batch.cancel` | cancel an in-flight batch |

**Types** (`packages/pipeline/src/batch.ts`):

```ts
export interface BatchRequest {
  /** Template pipeline; each row's values substitute `{{column}}` placeholders. */
  pipeline: PipelineDefinition;
  source: BatchSource;
  /** Max in-flight rows. Default 5. */
  concurrency?: number;
  onRowFailure?: 'continue' | 'stop' | 'retry-once';
  perRunBudget?: BudgetConfig;              // F4 per row
  /** Tag every artifact for cohort queries (e.g., 'campaign-2026-05'). */
  artifactTags?: string[];
  idempotencyKey?: string;                  // F1, batch-level
}

export type BatchSource =
  | { type: 'csv';   uri: string; columnMap?: Record<string, string>; delimiter?: ',' | ';' | '\t'; hasHeader?: boolean }
  | { type: 'jsonl'; uri: string }
  | { type: 'inline'; rows: Record<string, unknown>[] };

export interface BatchStatus {
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';
  totalRows: number;
  completed: number;
  failed: number;
  inFlight: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  reportArtifactId?: string;                // present when status terminal
}

export interface BatchReportRow {
  rowIndex: number;
  runId?: string;
  status: 'completed' | 'failed' | 'skipped' | 'cancelled';
  costUsd: number;
  artifactIds: string[];
  error?: { code: string; message: string };
  rowInput: Record<string, unknown>;        // echoed for traceability
}

export interface BatchRetryRequest {
  batchId: string;
  onlyFailed?: boolean;                     // default true
  onlyRowIndexes?: number[];
}
```

**API:**
```ts
pipeline.batch({
  source: { type: 'csv', uri: 's3://my-bucket/inputs.csv', columnMap: { headline: 'col_a', topic: 'col_b' } },
  pipeline: {
    steps: [
      { id: 's1', operation: 'image.generate', inputs: { prompt: 'hero for: {{headline}} on {{topic}}' } },
    ],
  },
  concurrency: 10,
  onRowFailure: 'continue',
  perRunBudget: { maxUsd: 0.20, onExceed: 'abort' },
});
// returns: { batchId, status: 'running' }
```

**Mechanism:**
1. `pipeline.batch` parses the source. CSV streamed via `csv-parse`; JSONL line-by-line; inline rows as-is. Up to 100k rows per batch (configurable).
2. Persist a `BatchRun` in §0.1 store (same Redis instance; key `mp:batch:<batchId>`). Each row gets a deterministic `idempotencyKey` (sha256 of batchId + rowIndex + canonicalJson(row)) so retries are safe.
3. Worker loop maintains `concurrency` in-flight runs via `pipeline.execute` internally. Per-row F4 budget applied.
4. On row failure:
   - `continue`: log, move on.
   - `stop`: cancel all in-flight, mark batch `failed`.
   - `retry-once`: re-run that row immediately with the same idempotency key (per-run idempotency lets the retry skip already-completed steps via F3).
5. Emit pipeline progress events keyed by `batchId` + `rowIndex` so F6 subscribers can render whole-batch progress.
6. On terminal: assemble `BatchReportRow[]` as a JSONL artifact, store, return `reportArtifactId`. Status becomes `completed` (all OK), `partial` (some failures with `onRowFailure=continue`), `failed` (stop hit), or `cancelled`.

**Retry semantics:** `pipeline.batch.retry({ batchId, onlyFailed: true })` re-runs failed rows using the **same** per-row idempotency keys. Already-completed rows return cached results; failed rows get a fresh attempt (idempotency entry treated as `failed` ⇒ replay-then-retry pattern from F1 applies).

**Cancellation:** `pipeline.batch.cancel(batchId)` aborts pending rows, signals in-flight runs, and emits `batch-cancelled` event.

**Affected:** `packages/pipeline/src/batch.ts` (new), `packages/server/src/mcp-server.ts` (4 new tools), `packages/persistence` (batch index keys).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| CSV happy path | 100 rows, all succeed | status=completed; report has 100 rows |
| Partial failure, continue | row 7 fails, onRowFailure=continue | status=partial; report records error for row 7; others completed |
| Partial failure, stop | row 7 fails, onRowFailure=stop | status=failed; in-flight rows cancelled |
| Retry-once | row 7 transient fail | row 7 retried; final success; status=completed |
| Per-row budget | row 12 exceeds maxUsd | row 12 fails with BUDGET_EXCEEDED; others continue (when 'continue') |
| Concurrency cap | concurrency=5, 100 rows | never more than 5 in-flight |
| Resume after server restart | mid-batch crash | on restart, in-flight rows treated as failed; retry resumes them |
| Cancel mid-batch | 30/100 done | new submissions stop; in-flight runs receive cancel; status=cancelled |
| `retry({ onlyFailed: true })` | 10 failures from prior run | exactly those 10 re-run; rest skipped |
| Inline source | 5 rows | runs 5 |
| JSONL source | s3 uri | streamed line-by-line |
| Column map | `headline` → `col_a` | substitution uses col_a's value |
| Batch idempotency | resubmit with same batch idempotencyKey | returns existing batchId, no new run |
| Report artifact | terminal | report fetchable via artifact registry as JSONL |
| F18 multi-tenant | tenantId set | per-tenant ledger entries; report restricted by tenant scope |

**Backwards-compat:** new tools, no impact on existing pipelines. Existing `pipeline.execute` continues to work for single runs.

---

## Phase 2.4 — Safety and trust

Lifts the project from "individual developer tool" to "embeddable in a regulated product." Safety gate, provenance signing, and per-tenant key isolation.

---

### F16. Safety/moderation as a default-on gate

> **Status:** ✅ Shipped in 0.3.0

**Value:** every artifact leaves a pipeline only after a safety check. Default-on means no one ships unmoderated outputs by accident.

**Types** (`packages/pipeline/src/gates/safety.ts`):

```ts
export type SafetyCategory =
  | 'sexual'
  | 'sexual/minors'
  | 'hate'
  | 'harassment'
  | 'self-harm'
  | 'violence'
  | 'graphic-violence'
  | 'illegal'
  | 'pii'
  | 'misinformation'
  | 'csam';                                 // always blocked unconditionally

export interface SafetyGate {
  type: 'safety';
  /** Provider override; default chosen per content type (see below). */
  provider?: 'openai' | 'azure' | 'google' | 'replicate' | 'ollama' | 'comfyui';
  model?: string;
  /** Categories to block; 'all' uses provider defaults. */
  block?: SafetyCategory[] | 'all';
  /** Score threshold per category (0..1). Default 0.5. */
  thresholds?: Partial<Record<SafetyCategory, number>>;
  /** What to do when blocked. Default 'fail'. */
  action?: 'fail' | 'warn' | 'redact';
  /** Skip on `audio.tts` (text already moderated). Default true. */
  skipDownstreamOfModeratedText?: boolean;
}

export interface SafetyVerdict {
  blocked: boolean;
  category?: SafetyCategory;
  score?: number;
  perCategoryScores: Partial<Record<SafetyCategory, number>>;
  provider: string;
  model: string;
  action: SafetyGate['action'];
  costUsd: number;
  redactedArtifactId?: string;              // present if action='redact' and content was image/video
}
```

**API:**
```ts
step: {
  id: 's1',
  operation: 'image.generate',
  inputs: { prompt: '...' },
  gates: [{ type: 'safety', block: ['sexual/minors', 'graphic-violence'], action: 'fail' }],
}
```

**Per-content-type defaults:**

| Content type | Default provider | Default model | Notes |
|---|---|---|---|
| text | openai | `omni-moderation-latest` | free, fast |
| image | replicate | `falcons-ai/nsfw_image_detection` | also detects CSAM signal |
| video | replicate | sample 1 frame per second, run image classifier | aggregate max score |
| audio | google | Speech-to-Text moderation flags | TTS is moderated at text step instead |

**CSAM handling:** if `csam` score > 0.0, action is **always** `fail`, regardless of configured `action`. Never warn, never redact. The verdict is logged with high severity and the artifact is purged.

**Default-on policy:**
- Server bootstrap sets `features.safetyGate = true` by default in Phase 2.4.
- When enabled, an implicit `safety` gate with provider defaults is appended to every step that produces a moderable artifact, unless the step explicitly declares its own `safety` gate or sets `gates: [{ type: 'safety', action: 'warn' }]`.
- Off-switch: `features.safetyGate = false` (documented as opt-out with a clear "you must moderate elsewhere" warning).

**Per-provider moderation backends:**

| Backend | Latency | Cost | Categories |
|---|---|---|---|
| openai `omni-moderation-latest` | ~80ms | free | text + image; 13 categories |
| azure Content Safety | ~120ms | $0.001/call | text + image; configurable thresholds |
| google Cloud Natural Language moderation | ~100ms | $0.0005/call | text only |
| replicate `falcons-ai/nsfw_image_detection` | ~600ms | $0.0003/call | image, 5 categories |
| ollama (F10) llava / llama-guard | local | $0 | text + image; user-configured |
| comfyui (F10) custom workflow | local | $0 | image; arbitrary |

**Mechanism:**
1. Resolve provider (explicit > default-by-type).
2. Submit content to moderation backend. Image/video may require pre-extracting frames (handled in `packages/video-gen`).
3. Compute per-category max scores; compare against `thresholds`.
4. If any blocked category exceeds threshold:
   - `fail`: throw `SafetyGateRejectedError(category, score)`.
   - `warn`: emit warning event; artifact passes through.
   - `redact`: invoke a redaction step (blur faces for image, beep audio segments, etc.). On unsupported redaction type, fall back to `fail`.
5. Log verdict to audit log (uses `packages/security/src/audit-logger.ts`).

**Affected:** `packages/pipeline/src/gates/safety.ts` (new), `packages/pipeline/src/pipeline-operations.ts` (default-on injection), `packages/server` (feature flag), `packages/security/src/audit-logger.ts` (verdict sink).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Safe content passes | benign prompt | safety verdict blocked=false; artifact proceeds |
| Blocked text | hate-speech prompt | `SafetyGateRejectedError(category='hate')` |
| Blocked image | NSFW image gen | error; artifact deleted, not stored |
| Default-on injection | step declares no gates | implicit safety gate runs |
| Default-on opt-out | feature flag off | no implicit gate |
| Step-level override | step declares own gate | explicit gate used, not default |
| CSAM unconditional fail | csam score=0.6, action='warn' | still fails; high-severity audit log |
| Action=warn | borderline content | emits warning; artifact passes |
| Action=redact, supported | image with one face | redacted (blurred) artifact returned |
| Action=redact, unsupported | audio with unsupported redaction | falls back to fail |
| Skip downstream TTS | text moderated, then TTS step | TTS skips its own safety gate |
| Provider down | openai moderation 500 | retry once, then `SafetyProviderUnavailableError`; default behavior block |
| Composes with F9 variants | n=4, one variant blocked | blocked variant rejected; remaining go to judge |
| Audit log | any verdict | structured log line via security package |
| Cost recorded | $0.0003 for replicate classifier | ledger entry tagged `kind: 'gate'` |

**Backwards-compat:** the **default-on flip** is a behavior change (patch+CHANGELOG note per §0.4). Provide a one-step opt-out (`features.safetyGate = false`). Existing pipelines run unchanged structurally.

---

### F17. C2PA / AI provenance signing

> **Status:** ✅ Shipped in 0.3.0

**Value:** every generative artifact ships with a tamper-evident manifest naming the model, the pipeline DAG, and the operator. Required by emerging EU AI Act and US labeling guidance.

**New package:** `packages/provenance` → `@reaatech/media-pipeline-mcp-provenance`. Uses [`c2pa-node`](https://github.com/contentauth/c2pa-node) for manifest assembly and signing.

**Types** (`packages/provenance/src/types.ts`):

```ts
export interface ProvenanceManifest {
  title: string;
  format: string;                           // mime type
  claimGenerator: string;                   // e.g., 'media-pipeline-mcp/2.4.0'
  assertions: ProvenanceAssertion[];
  ingredients?: ProvenanceIngredient[];
  /** Pipeline DAG hash (sha256 of normalized pipeline JSON) for audit. */
  pipelineDefHash: string;
  runId: string;
  generatedAt: string;
}

export type ProvenanceAssertion =
  | { kind: 'c2pa.actions';     actions: ProvenanceAction[] }
  | { kind: 'c2pa.ai.training'; allowed: boolean; rationale?: string }
  | { kind: 'c2pa.model';       providerId: string; modelId: string; modelVersion?: string }
  | { kind: 'custom';           label: string; data: Record<string, unknown> };

export interface ProvenanceAction {
  action: 'c2pa.created' | 'c2pa.edited' | 'c2pa.placed' | 'c2pa.transcoded';
  when: string;
  softwareAgent?: string;
  parameters?: Record<string, unknown>;
}

export interface ProvenanceIngredient {
  artifactId: string;
  title?: string;
  relationship: 'componentOf' | 'parentOf' | 'inputTo';
  manifestRef?: string;                     // C2PA URI of an upstream manifest
}

export type KeySource =
  | { kind: 'pem-file';          path: string; certPath: string }
  | { kind: 'pem-inline';        privateKey: string; certificate: string }
  | { kind: 'aws-kms';           keyId: string; certPath: string; region?: string }
  | { kind: 'gcp-kms';           keyName: string; certPath: string }
  | { kind: 'azure-key-vault';   vaultUrl: string; keyName: string; certPath: string };

export interface SigningKeyConfig {
  source: KeySource;
  algorithm: 'es256' | 'es384' | 'ps256' | 'ed25519';
  /** Re-fetch the key from the KMS at this interval. Default 1h. */
  cacheTtlMs?: number;
}

export interface ProvenanceConfig {
  enabled: boolean;
  signingKey: SigningKeyConfig;
  /** Sign only generative outputs (not derived transforms like crop/normalize). Default true. */
  signGenerativeOnly?: boolean;
  /** Embed manifest in-file when supported (jpeg, mp4, wav); else write a sidecar `<file>.c2pa`. */
  embedMode?: 'in-file' | 'sidecar' | 'both';
}
```

**API (server config, not per-step):**
```ts
createMcpServer({
  provenance: {
    enabled: true,
    signingKey: { source: { kind: 'aws-kms', keyId: 'arn:aws:kms:...', certPath: './ca.pem' }, algorithm: 'es256' },
    signGenerativeOnly: true,
    embedMode: 'in-file',
  },
});
```

**Per-format embedding support:**

| Format | In-file embed | Sidecar fallback |
|---|---|---|
| jpeg, jpg | yes (`jumbf` box) | `<file>.c2pa` |
| png | yes (`caBX` chunk) | `<file>.c2pa` |
| mp4, mov | yes (`uuid` box) | `<file>.c2pa` |
| wav | yes (LIST chunk) | `<file>.c2pa` |
| webp | no (current `c2pa-node`) | sidecar only |
| svg | no | sidecar only |
| any other | no | sidecar only |

**Per-KMS implementation:**

| KMS | Signing path | Cert provisioning |
|---|---|---|
| pem-file | local libcrypto via `c2pa-node` | provided alongside key |
| pem-inline | as above; key from config | inline cert |
| aws-kms | `KMS.sign` API; algorithm map ES256→`ECDSA_SHA_256` | cert path required (not stored in KMS) |
| gcp-kms | `kms.cryptoKeyVersions.asymmetricSign` | cert path required |
| azure-key-vault | `KeyClient.sign` | cert path required |

**Mechanism:**
1. After each generative step completes, the executor calls `provenance.sign(artifactId, runContext)`.
2. Manifest assembled from: model + version (from provider metadata), the pipeline DAG hash, the run's ingredient artifacts (upstream artifacts referenced as `inputTo`), and a `c2pa.actions[c2pa.created]` assertion.
3. Key is fetched via `KeySource` (KMS calls cached for `cacheTtlMs`).
4. Sign via `c2pa-node`'s `ManifestBuilder.signAsync`.
5. Embed per `embedMode`. Write derivative artifact id to step state; original artifact id unchanged.
6. If signing fails (KMS unavailable etc.): with `signGenerativeOnly=true`, log + emit warning + proceed; with strict mode (config `enforce: true`), throw `ProvenanceSigningFailedError`.

**Manifest scope decisions (encoded in defaults):**
- Sign **generative** outputs: image-gen, video-gen, audio-tts, text-gen.
- Do not sign **derived transforms**: crop (F11), loudness-normalize (F14), subtitle burn-in (F12) — these become C2PA `edited` actions added to the existing manifest if the parent had one, but do not introduce a new top-level manifest.

**Affected:** `packages/provenance` (new), `packages/pipeline/src/pipeline-operations.ts` (post-step hook), `packages/storage` (manifest-aware artifact write).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Sign jpeg in-file | image.generate, jpeg | embedded manifest verifies; original bytes hash recorded |
| Sign mp4 in-file | video.generate, mp4 | embedded manifest in `uuid` box |
| Sidecar webp | image.generate, webp | sidecar `.c2pa` next to file |
| Manifest contents | any | includes model, modelVersion, runId, pipelineDefHash, ingredients |
| Ingredient chain | step2 derived from step1, both signed | step2 manifest lists step1 artifact as `inputTo` with manifestRef |
| Derived transform | image → crop (F11) | one manifest; crop appears as `edited` action in parent manifest |
| KMS unavailable, lenient | enforce=false, KMS down | warning emitted; artifact published unsigned |
| KMS unavailable, strict | enforce=true | `ProvenanceSigningFailedError` |
| Key cache | two signings within cacheTtlMs | one KMS sign call (when supported), or one key fetch then local sign |
| `signGenerativeOnly=false` | crop step | crop produces a new manifest (not parent-amended) |
| Verify external | `c2patool verify <file>` | succeeds; cert chain checks |
| Resume (F3) | step signed, then resume | resume does not re-sign; persisted manifest reused |

**Backwards-compat:** opt-in via config; no API surface change to existing tools. New package only.

---

### F18. Multi-tenant API key vault

> **Status:** ✅ Shipped in 0.3.0

**Value:** one server instance serves many tenants, each with their own provider keys, their own cost ledger, their own artifact scope. Required for any managed-service offering.

**New package:** `packages/keyvault` → `@reaatech/media-pipeline-mcp-keyvault`.

**Types** (`packages/keyvault/src/types.ts`):

```ts
export interface TenantContext {
  tenantId: string;
  /** Resolved provider credentials. Populated by KeyVault.resolve. */
  providerKeys: ReadonlyMap<string, string>;
  /** Per-tenant budget caps applied automatically (overrides per-call BudgetConfig if stricter). */
  budgetCaps?: { dailyUsd?: number; monthlyUsd?: number };
  /** Allow-list of providers/models. */
  allowedProviders?: string[];
  allowedModels?: string[];
  /** Free-form metadata for audit/observability. */
  metadata?: Record<string, unknown>;
}

export interface KeyVault {
  /** Resolve all provider credentials for the tenant. Cached `cacheTtlMs`. */
  resolve(tenantId: string): Promise<TenantContext>;
  /** Look up a single key (e.g., outbound webhook secret). */
  get(tenantId: string, key: string): Promise<string | null>;
  /** Health: can we reach the underlying store? */
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

export interface TenantResolver {
  /** Resolve a TenantContext from inbound MCP request metadata. */
  resolve(request: McpRequest): Promise<TenantContext | null>;
}

export type TenantResolutionStrategy =
  | { kind: 'header';        headerName: string }                       // e.g., X-Tenant-Id
  | { kind: 'jwt';           jwksUri: string; claim: string }
  | { kind: 'oauth-scope';   scope: string }
  | { kind: 'mtls-cn';       /* tenant = client cert CN */ }
  | { kind: 'static';        tenantId: string }                         // single-tenant deployment
  | { kind: 'custom';        resolver: TenantResolver };
```

**Backing implementations:**

```ts
// packages/keyvault/src/aws-secrets.ts
// looks up `${secretPrefix}/${tenantId}` as JSON: { openai: '...', anthropic: '...' }
export declare class AwsSecretsManagerKeyVault implements KeyVault {
  constructor(opts: { region: string; secretPrefix: string; cacheTtlMs?: number });
  resolve(tenantId: string): Promise<TenantContext>;
  get(tenantId: string, key: string): Promise<string | null>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

// packages/keyvault/src/gcp-secret.ts
export declare class GcpSecretManagerKeyVault implements KeyVault {
  constructor(opts: { projectId: string; secretPrefix: string; cacheTtlMs?: number });
  resolve(tenantId: string): Promise<TenantContext>;
  get(tenantId: string, key: string): Promise<string | null>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

// packages/keyvault/src/env.ts
// reads ${TENANT_ID}_OPENAI_API_KEY etc. Single-tenant convenience.
export declare class EnvKeyVault implements KeyVault {
  resolve(tenantId: string): Promise<TenantContext>;
  get(tenantId: string, key: string): Promise<string | null>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

// packages/keyvault/src/in-memory.ts
// for tests; `set` populates the in-memory map
export declare class InMemoryKeyVault implements KeyVault {
  set(tenantId: string, keys: Record<string, string>, overrides?: Partial<TenantContext>): void;
  resolve(tenantId: string): Promise<TenantContext>;
  get(tenantId: string, key: string): Promise<string | null>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}
```

**API (server bootstrap):**
```ts
createMcpServer({
  multiTenant: {
    enabled: true,
    keyVault: new AwsSecretsManagerKeyVault({ region: 'us-west-2', secretPrefix: 'mp/tenants' }),
    resolver: { kind: 'jwt', jwksUri: 'https://auth.example/.well-known/jwks.json', claim: 'tenant_id' },
    /** Default per-tenant caps applied when KeyVault returns none. */
    defaultBudgetCaps: { dailyUsd: 25, monthlyUsd: 500 },
  },
});
```

**Per-request resolution flow:**
1. MCP request lands in `mcp-server.ts` middleware (after F1 idempotency).
2. `TenantResolver.resolve(request)` → `TenantContext` (or null ⇒ `TenantNotFoundError`).
3. `KeyVault.resolve(tenantId)` → populate `providerKeys`. Cached `cacheTtlMs` (default 300s) in-process.
4. Tenant context attached to AsyncLocalStorage for the request lifetime.
5. `provider-factory.ts` reads `providerKeys` instead of env at construction time.
6. Cost ledger (§0.2) tags every entry with `tenantId`; tenant-scoped queries surface them.

**Allow-list enforcement:**
- `allowedProviders` / `allowedModels` checked at step-prepare. Rejected steps fail with `TenantPolicyViolationError` (retryable=false).
- Empty arrays mean "allow none" (deny-all). Absent ⇒ "allow all."

**Budget caps:**
- `budgetCaps.dailyUsd` / `monthlyUsd` enforced via `CostLedger.preflight(scope='tenant')` before every step.
- F4's per-run cap can be lower than the tenant cap but never higher.

**Per-implementation features:**

| KeyVault | Caching | Rotation handling | Tenant-list discovery |
|---|---|---|---|
| AwsSecretsManagerKeyVault | in-process TTL | re-fetch on miss; honors versioning | optional `ListSecrets` with prefix |
| GcpSecretManagerKeyVault | in-process TTL | re-fetch latest version | optional `listSecrets` |
| EnvKeyVault | n/a (process env) | not supported (restart required) | n/a |
| InMemoryKeyVault | n/a | call `set` to rotate | yes (`list()`) |

**Artifact scoping:**
- Storage backends (`packages/storage`) prefix object keys with `tenants/<tenantId>/...` when multi-tenant is enabled.
- Cross-tenant artifact access requires a server-level "admin override" flag, audit-logged.

**Affected:** `packages/keyvault` (new), `packages/server/src/mcp-server.ts` (middleware), `packages/server/src/provider-factory.ts` (key sourcing), `packages/cost` (tenant tagging), `packages/storage/*` (prefixing), `packages/security/src/auth-middleware.ts` (resolver integration).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Header resolver | X-Tenant-Id=acme | TenantContext loaded, AWS keys resolved |
| JWT resolver | JWT with `tenant_id` claim | TenantContext loaded |
| mTLS CN resolver | client cert CN=acme | TenantContext loaded |
| Tenant not found | unknown id | `TenantNotFoundError` |
| KeyVault down | AWS Secrets returns 5xx | `KeyVaultUnavailableError` (retryable); retried per resilience policy |
| Cached resolution | two requests in `cacheTtlMs` | one upstream KMS call |
| Daily budget cap | tenant daily cap=$5; spend hits | next step `BudgetExceededError(scope='tenant-daily')` |
| Monthly cap | daily ok, monthly exceeded | blocked |
| Allow-list provider | tenant blocks 'openai'; step uses openai | `TenantPolicyViolationError` |
| Allow-list model | tenant model allowlist excludes 'dall-e-3'; step uses it | rejected |
| Artifact prefix | tenant uploads | object key `tenants/<id>/<artifactId>` |
| Cross-tenant access denied | tenant A queries artifact in tenant B's scope | `ArtifactAccessDeniedError` |
| Admin override | admin token + audit reason | allowed; logged via audit-logger |
| Composes with F1 idempotency | same key from different tenants | separate entries (tenant prefix in idempotency key) |
| Composes with F2 cache | scope='tenant' | entries keyed by tenantId; no cross-tenant hits |
| Composes with F17 provenance | signing key from per-tenant KMS | tenant's KMS used |
| Cost report per tenant | `cost.totalForTenant(tenantId, window)` | sums match ledger entries |
| Resolver custom | custom resolver returns context | used as-is |
| Empty allowedProviders | tenant has `allowedProviders: []` | deny-all; any step rejected |

**Backwards-compat:** opt-in via `multiTenant.enabled`. Off ⇒ existing single-tenant behavior preserved exactly. With it on, the env-only `EnvKeyVault` provides a low-friction migration path for installs not yet using KMS.

---

## Phase 2.5 — Surface expansion

Exposes artifacts as first-class MCP resources, adds real-time STT, and opens a new modality (3D) on the same provider/operation/cost machinery.

---

### F19. MCP resources for artifacts

> **Status:** ✅ Shipped in 0.3.0

**Value:** AI agents using this server can read generated artifacts directly via standard MCP resource URIs (`artifact://...`) instead of fetching them out-of-band. Resource lists update as the pipeline emits new artifacts.

**Types** (`packages/server/src/resources.ts`):

```ts
export type ResourceScope = 'session' | 'tenant' | 'global';

export interface ArtifactResourceConfig {
  /** Enabled? Default true once F19 ships. */
  enabled: boolean;
  /** Default scope when F18 is off. Default 'session'. */
  defaultScope?: ResourceScope;
  /** Max bytes returned inline for `resources/read`. Larger artifacts return URL pointers. Default 8 MB. */
  inlineMaxBytes?: number;
  /** Retention for session-scoped resources. Default 1h after session disconnect. */
  sessionRetentionMs?: number;
}

export interface ArtifactResource {
  uri: string;                              // 'artifact://<scope>/<id>' or 'artifact://tenant/<tenantId>/<id>'
  name: string;
  description?: string;
  mimeType: string;
  size: number;
  createdAt: string;
  metadata: {
    runId: string;
    stepId: string;
    provider: string;
    model: string;
    tags: string[];
  };
}
```

**URI scheme:**

| Scope | URI | Resolution |
|---|---|---|
| session | `artifact://session/<artifactId>` | Limited to the MCP session that created the artifact |
| tenant | `artifact://tenant/<tenantId>/<artifactId>` | Any session with the matching `TenantContext` (F18) |
| global | `artifact://global/<artifactId>` | Anyone; only used when F18 is off and config sets `defaultScope='global'` |

**Mechanism:**
1. Implement `setResourceHandler` on the MCP server with three methods: `list`, `read`, `subscribe`.
2. **List**: enumerates resources currently in scope. Backed by `packages/storage` listing under the right prefix (session or tenant).
3. **Read**: fetches an artifact's bytes; under `inlineMaxBytes`, returns `text` or `blob` content; over, returns a single content item of `kind: 'resource'` with a signed URL (15 min TTL, generated by the storage backend's `signUrl`).
4. **Subscribe**: registers an MCP "resource changed" notification stream. Wired into the event bus (§0.3) — every `step-completed` event with new `artifactIds` emits a `notifications/resources/list_changed`.
5. **Garbage collection**: session-scoped artifacts purged `sessionRetentionMs` after the MCP session's `disconnect` event; tenant-scoped artifacts respect the storage backend's normal retention.

**Per-storage-backend behavior:**

| Backend | `signUrl` support | List performance |
|---|---|---|
| s3 | yes (presigned URLs, configurable TTL) | `ListObjectsV2` with prefix |
| gcs | yes (V4 signed URLs) | `bucket.getFiles` with prefix |
| local | served via short-lived in-process HTTP endpoint | filesystem walk |

**Composes with F18:** when `multiTenant.enabled`, all reads are tenant-checked; cross-tenant URIs return 403 `ArtifactAccessDeniedError`.

**Affected:** `packages/server/src/resources.ts` (new), `packages/server/src/mcp-server.ts` (handler registration + subscribe wiring), `packages/storage/src/types.ts` (require `signUrl` on backends), each storage impl (already supports signing on s3/gcs; add for local).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| List session resources | session created 3 artifacts | `resources/list` returns 3 |
| Read small artifact | size < inlineMaxBytes | content returned inline |
| Read large artifact | size > inlineMaxBytes | content returns signed URL ref |
| Subscribe new | new step completes | `list_changed` notification fires |
| Session retention | session disconnects + sessionRetentionMs elapses | resources GC'd from listing; bytes still in storage until backend TTL |
| Tenant scope read | tenant A reading tenant A's | OK |
| Cross-tenant denied | tenant A reading tenant B URI | `ArtifactAccessDeniedError` |
| Global scope | F18 off, defaultScope=global | anyone can list/read |
| Unknown URI | malformed scheme | `InvalidResourceUriError` |
| Storage backend missing signUrl | local backend without signing | in-process HTTP fallback serves it |
| Composes with F1 | idempotent re-run returns same artifact | URI stable across replays |
| Composes with F17 | signed artifact | manifest sidecar exposed as related resource (artifact://.../<id>.c2pa) |

**Backwards-compat:** purely additive MCP surface. Clients that don't speak resources continue to use tool responses' inline `artifactIds`.

---

### F20. Real-time STT streaming

> **Status:** ✅ Shipped in 0.3.0

**Value:** live captions, voice agents. `audio.transcribeStream` keeps a WebSocket open to the STT provider and streams interim + final transcripts back over MCP progress notifications.

**New tool:** `audio.transcribeStream` (in `packages/server`).

**Types** (`packages/audio-gen/src/transcribe-stream.ts`):

```ts
export interface TranscribeStreamRequest {
  /** Input source. Inline bytes streamed in chunks via separate MCP messages, or a remote URL. */
  source:
    | { kind: 'inline'; encoding: 'linear16' | 'opus' | 'mulaw'; sampleRateHz: number }
    | { kind: 'url';    url: string }
    | { kind: 'mic';    /* server-side capture for local-only deployments */ };
  language?: string;
  model?: string;
  provider?: 'deepgram' | 'openai' | 'google';
  /** Emit interim non-final results in addition to finals. Default true. */
  interim?: boolean;
  /** Speaker labels. Default false. */
  diarize?: boolean;
  /** Voice-activity-detected silence ms to call an endpoint. Default 800. */
  endpointingMs?: number;
}

export type TranscribeStreamEvent =
  | { kind: 'interim'; transcript: string; confidence?: number; words?: WordTiming[] }
  | { kind: 'final';   transcript: string; confidence?: number; words?: WordTiming[]; startMs: number; endMs: number; speaker?: string }
  | { kind: 'metadata'; languageDetected?: string; sampleRateHz?: number }
  | { kind: 'error';   code: string; message: string };

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}
```

**API (MCP tool):**
```ts
// Client opens the stream:
audio.transcribeStream({
  source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
  language: 'en',
  diarize: true,
}, { _meta: { progressToken: 't1' } })
// Client pushes audio chunks via subsequent JSON-RPC messages keyed to the same progressToken.
// Server emits MCP progress notifications carrying TranscribeStreamEvent values.
// On endpoint or client-signaled EOS, server returns the final transcript as the tool result.
```

**Per-provider WS bridge:**

| Provider | WS endpoint | Audio format mapping | Diarization | Interim |
|---|---|---|---|---|
| deepgram | `wss://api.deepgram.com/v1/listen` | linear16/opus/mulaw native | yes | yes |
| google | gRPC streaming (`StreamingRecognize`) via `@google-cloud/speech` | linear16 only; resample others server-side | yes | yes |
| openai | not currently supported (whisper is batch only) | — | — | — |

**Mechanism:**
1. Tool call arrives with `progressToken`. Server opens provider WS / gRPC stream with matching configuration.
2. Audio chunks streamed in either:
   - **Inline mode**: subsequent MCP notifications with the same `progressToken` carrying `kind: 'audio-chunk'` payloads; server forwards bytes to provider WS.
   - **URL mode**: server fetches the URL and streams it (chunk size 8 KB).
   - **Mic mode** (local-only): server captures from default input via `node-record-lpcm16` (documented dev-only).
3. Provider emits transcripts → server forwards each as a `$/progress` notification with `TranscribeStreamEvent` payload.
4. On EOS (provider closes, client signals end, or `endpointingMs` silence detected): server returns the final `{ transcript, segments }` as the tool result.
5. On error mid-stream: emit `{ kind: 'error' }` progress, then return error as tool result. State store records cost based on `seconds streamed × rate`.

**Cost accounting:** charged per-second of audio at provider rate. Streamed cost via §0.2 ledger as the stream progresses. F4 cap applies (mid-stream cancellation if cap hit; reuses F4 mechanism).

**Affected:** `packages/audio-gen/src/transcribe-stream.ts` (new), `packages/server/src/mcp-server.ts` (tool + audio-chunk notification handler), `packages/deepgram/src/deepgram-provider.ts` (WS streaming method), `packages/google/src/google-provider.ts` (gRPC streaming).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Inline linear16 happy path | deepgram, 30s audio | interim + final events streamed; final tool result has full transcript |
| URL source | deepgram, mp3 url | server fetches; same event stream |
| Diarization | diarize=true | finals carry `speaker` |
| Endpointing | 1s silence then more audio | endpointing emits final, then new utterance starts |
| Client end-of-stream | client signals EOS | server returns final result |
| Resample required | google, opus input | server resamples to linear16 before forwarding |
| Provider WS drop | mid-stream socket closes | error event; tool result errors out; cost recorded for streamed seconds |
| F4 cap mid-stream | cap hit after 60s | stream cancelled; `BudgetExceededError` |
| F6 reuses progress channel | progressToken | uses same MCP progress wire format as F6 |
| Composes with F18 | multi-tenant | per-tenant key used; cost tagged tenantId |
| Mic mode missing | mic mode requested in cloud deployment | `MicNotAvailableError` |
| OpenAI provider | provider=openai | `ProviderUnsupportedError('openai does not support streaming STT')` |

**Backwards-compat:** new tool only; non-streaming `audio.stt` (already exists) unchanged.

---

### F21. 3D model generation

> **Status:** ✅ Shipped in 0.3.0

**Value:** opens a new modality on the same provider/operation/cost machinery. `mesh.generate({ prompt, format: 'glb' })`.

**New packages:**

| Package | npm name | Models |
|---|---|---|
| `packages/meshy` | `@reaatech/media-pipeline-mcp-meshy` | meshy-4 text-to-3d, image-to-3d |
| `packages/luma` | `@reaatech/media-pipeline-mcp-luma` | genie text-to-3d |

**New operation:** `mesh.generate` (registered in `packages/server` tool registry).

**Types** (`packages/provider-core/src/types.ts` — extend `MediaProvider`):

```ts
export type MeshFormat = 'glb' | 'fbx' | 'obj' | 'usdz' | 'ply';

export interface MeshGenInput {
  /** Either prompt (text-to-3d) or sourceArtifactId (image-to-3d). */
  prompt?: string;
  sourceArtifactId?: string;
  format: MeshFormat;
  /** Target polygon count budget. Provider may approximate. */
  polyBudget?: number;                      // 1_000..200_000
  /** Topology preference for downstream use. */
  topology?: 'quads' | 'tris';
  /** Texture options. */
  texture?: TextureConfig;
  /** Animation. Most providers don't support yet. */
  animated?: boolean;
}

export interface TextureConfig {
  enabled: boolean;
  pbr?: boolean;                            // produce roughness/metallic/normal maps
  resolution?: 512 | 1024 | 2048 | 4096;
  /** UV-unwrap method when needed. */
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
```

**API:**
```ts
const step = {
  operation: 'mesh.generate',
  inputs: {
    prompt: 'a red ceramic teapot, hero shot',
    format: 'glb',
    polyBudget: 20000,
    texture: { enabled: true, pbr: true, resolution: 2048 },
  },
};
```

**Per-provider feature support:**

| Provider/Model | text→3d | image→3d | PBR textures | Output formats | Async (F7) | Streaming progress (F6) |
|---|---|---|---|---|---|---|
| meshy / meshy-4 | yes | yes | yes | glb, fbx, obj, usdz | yes (webhook + poll) | poll-derived progress |
| luma / genie | yes | yes | yes | glb, usdz | yes (poll only) | poll-derived progress |

**Format conversion:** if a requested format isn't directly produced by the provider, server converts via `assimp` or `gltfpack` (bundled via npm; falls back to system binary). Conversion logged and cost = $0.

**Mechanism:**
1. Route to provider per `step.provider`/`step.model` (or F8 router).
2. Provider submits job, returns `jobId`. Run transitions to `suspended` if F7 webhook configured; else polls with provider-specific cadence.
3. On completion, fetch primary mesh + textures, persist as one composite artifact (manifest JSON listing constituent files).
4. If `format` differs from provider's native output, run conversion step; new artifact replaces the original (original tagged `intermediate` and retained per retention policy).
5. Emit `MeshOutput` as step result.

**Cost accounting:**
- meshy: per-generation flat rate (~$0.20 standard quality, ~$0.40 hd) — from bundled `pricing.json`.
- luma: per-generation flat (~$0.30).
- estimateCost uses these bundled rates; texture and polyBudget do not affect price in current pricing tables.

**Affected:** `packages/meshy` (new), `packages/luma` (new), `packages/provider-core/src/types.ts` (add `MeshFormat`, `MeshGenInput`, `MeshOutput`), `packages/server/src/tool-registry.ts` (register `mesh.generate`), `packages/pipeline/src/pipeline-operations.ts` (handle composite artifacts), `packages/storage` (composite artifact support — manifest pointing at multiple files).

**Test matrix:**

| Scenario | Setup | Expected |
|---|---|---|
| Meshy text→3d glb | prompt, format=glb | glb artifact returned; polyCount populated |
| Meshy image→3d | sourceArtifactId, format=glb | glb produced from image |
| Luma text→3d | luma, format=glb | glb produced |
| Format conversion | provider native=glb, requested=fbx | conversion runs; final artifact is fbx |
| PBR textures requested | texture.pbr=true, resolution=2048 | composite artifact includes albedo/normal/roughness/metallic |
| Async via webhook (F7) | meshy + webhook configured | run suspended; resumes on callback |
| Async via poll | luma | polls until done; progress events |
| Resume (F3) | server restart mid-poll | resumes via persisted jobId |
| Budget cap | maxUsd < flat rate | preflight blocks; `BudgetExceededError` |
| Composes with F2 cache | same prompt + same params | cache hit, no provider call |
| Composes with F17 provenance | signed glb | manifest sidecar lists mesh as `c2pa.created` |
| Invalid format for provider | luma + format=ply | `FormatUnsupportedError` (no converter available either) |
| polyBudget exceeded | provider returns 100k polys, budget=20k | warning emitted; artifact returned as-is (no auto-decimate yet) |

**Backwards-compat:** new providers, new operation, no impact on existing surface.

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

## Phase 2 release status

All 21 features (F1–F21) are **shipped in 0.3.0**. See [PHASE2_DEV_PLAN.md](./PHASE2_DEV_PLAN.md) for individual feature specifications.

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
Every Phase 2 feature ships behind a config flag in the server bootstrap. Flags become defaults once a feature has shipped in two minor releases without regressions.

| Feature | Flag | Default |
|---|---|---|
| F1 Idempotency | `idempotency` | ON |
| F2 Content cache | `contentCache` | OFF |
| F3 Resumable pipelines | `resumablePipelines` | OFF |
| F4 Budget caps | `budgetCaps` | ON |
| F5 Dry-run | `dryRun` | ON |
| F6 Streaming progress | `streaming` | OFF |
| F7 Webhooks | `webhooks` | OFF |
| F8 Routing | `routing` | OFF |
| F9 A/B variants | `variants` | OFF |
| F10 Local models | (n/a — opt-in via provider config) | n/a |
| F11 Aspect fan-out | (n/a — per-step option) | n/a |
| F12 Subtitles | `subtitles` | OFF |
| F13 RunContext | `runContext` | ON |
| F14 Loudness gate | (n/a — per-step gate) | n/a |
| F15 Batch | `batch` | OFF |
| F16 Safety gate | `safetyGate` | **ON** (default-on once F16 ships) |
| F17 C2PA | `provenance` | OFF |
| F18 Multi-tenant | `multiTenant` | OFF |
| F19 MCP resources | `mcpResources` | OFF |
| F20 STT stream | `sttStream` | OFF |
| F21 3D gen | (n/a — opt-in via provider install) | n/a |

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
    routing: false,
    variants: false,
    subtitles: false,
    runContext: true,
    batch: false,
    safetyGate: true,
    provenance: false,
    mcpResources: false,
    sttStream: false,
  },
});
```

### Observability hooks
Every feature emits:
- **OTel spans:** `pipeline.<op>`, `cache.<lookup|store>`, `router.<decide>`, `webhook.<receive|deliver>`, `gate.<safety|loudness>`, `provenance.<sign>`, `keyvault.<resolve|get>`, `batch.<row>`, `mesh.<generate|convert>`.
- **Metrics (Prometheus naming):**
  - F2: `mp_cache_hit_total`, `mp_cache_miss_total`
  - F4: `mp_budget_exceeded_total`, `mp_budget_warn_total`
  - F6: `mp_progress_events_emitted_total`, `mp_progress_events_dropped_total`
  - F7: `mp_webhook_received_total`, `mp_webhook_delivery_failures_total`
  - F8: `mp_router_decisions_total{strategy,outcome}`, `mp_router_candidates_rejected_total{reason}`
  - F9: `mp_variants_rejected_total{reason}`, `mp_judge_cost_usd_total`
  - F15: `mp_batch_rows_total{status}`
  - F16: `mp_safety_blocked_total{category}`
  - F17: `mp_provenance_signed_total`, `mp_provenance_failures_total`
  - F18: `mp_keyvault_cache_hits_total`, `mp_keyvault_fetch_failures_total`, `mp_tenant_budget_exceeded_total{scope}`
  - All: `mp_step_duration_seconds`, `mp_run_cost_usd`
- **Structured log fields:** `runId`, `tenantId`, `stepId`, `idempotencyKey`, `cacheKey`, `routeDecision`, `safetyVerdict`, `provenanceManifestUri` (where applicable). All logs go through `packages/observability/src/structured-logger.ts`.

### CI / runtime additions
- **ffmpeg (F11, F12, F14):** bundle `@ffmpeg-installer/ffmpeg` as a runtime dep for portability; document system-ffmpeg as the faster production install in `docs/development.md`.
- **Redis in CI (F1, F2, F3, F6, F7, F15):** add a `redis` service to `.github/workflows/ci.yml`. Integration tests gate on `REDIS_URL`.
- **Webhook tunneling (F7):** document `ngrok` and `cloudflared` recipes in `docs/development.md` for local dev.
- **C2PA test keys (F17):** generate ephemeral PEM keys in test fixtures; KMS tests skipped unless credentials provided.
- **C2PA verify (F17 CI):** install `c2patool` in CI to verify signed outputs.
- **Mesh converters (F21):** `gltfpack` and `assimp` bundled via npm; document system binary fallback.
- **CLIP model (F9 image-judge):** `@xenova/transformers` downloads ONNX models on first use (~150 MB); cache in CI to avoid re-download on every job.
- **MediaPipe Face Detection (F11):** `@mediapipe/tasks-vision` loaded lazily; first call downloads model. Cache in CI.
- **WebSocket libs (F20):** `ws` for Deepgram WS bridge; `@google-cloud/speech` gRPC for Google STT.
- **node-record-lpcm16 (F20 mic mode):** dev-only optional dep; documented.

### Backwards-compatibility policy
- New optional fields: minor bump. Existing callers unaffected.
- New tools: minor bump.
- Field removal, required-field addition, tool removal/rename: major bump.
- Behavior change without API change (e.g., default cache on for image.generate, F16 default-on safety): patch + prominent CHANGELOG note. Both safety default-on and any cache default-on changes must ship with a one-line opt-out documented in the README's "Migrating to vX.Y" subsection.

### Security review checkpoints
Required before merge:
- **F7 webhooks** — HMAC implementation, replay protection, constant-time signature comparison.
- **F16 safety gate** — default-on coverage matrix; CSAM unconditional fail verified in tests.
- **F17 C2PA** — key handling, KMS integration audit, cert chain verification.
- **F18 multi-tenant** — tenant isolation, RLS verification, key vault access patterns, cross-tenant artifact access audit.
- **F19 MCP resources** — URI scope enforcement, signed URL TTL, cross-session leak check.
- **F20 STT stream** — per-tenant key isolation in long-lived WS connections, audio retention policy.

### Performance acceptance criteria
- F1 idempotency lookup: p99 < 10ms.
- F2 cache lookup: p99 < 20ms; target hit rate ≥40% on iterative-prompt workloads.
- F3 resume state load: p99 < 50ms for runs with ≤10 steps.
- F4 budget preflight overhead: < 5ms per step.
- F6 streaming: progress delivered within 500ms of provider event.
- F7 webhook receive → resume: < 200ms.
- F8 routing decision overhead: p99 < 150ms for `cheapest-acceptable` over 5 candidates (includes parallel health probes, cached after first hit).
- F9 judge round-trip: not counted against pipeline latency budget (judge is its own step).
- F15 batch worker step overhead: < 50ms per row (excluding provider time).
- F16 safety gate: p99 < 200ms for text (openai moderation), p99 < 1000ms for image (replicate classifier).
- F17 C2PA sign: p99 < 300ms in-process; KMS-backed signing p99 < 800ms after warm key cache.
- F18 keyvault resolve: p99 < 100ms warm, < 500ms cold.
- F19 resource list/read (in-scope): p99 < 50ms inline; signed URL generation p99 < 200ms.
- F20 STT bridge first-byte: < 500ms after stream open.

Pipeline overhead (excluding provider call): p99 increase < 100ms vs Phase 1 baseline.

---

## Open decisions

Items still requiring product/tech-lead input before implementation starts.

1. **State store backend default.** Redis recommended for Phase 2.1. Postgres deferred to Phase 2.4. ✅ Decided.
2. **Cache key invariance.** Include provider+model version strings (not SDK version). ✅ Decided.
3. **Budget enforcement granularity.** Both per-run and per-tenant; per-tenant arrives with F18. ✅ Decided.
4. **Webhook security model.** HMAC default; mTLS documented for enterprise. ✅ Decided.
5. **Safety gate defaults.** Default-on for outputs; opt-out via `features.safetyGate=false`. Default backend per content type per F16 table. ✅ Decided (F16).
6. **C2PA scope.** Sign generative outputs only; derived transforms append `edited` actions to the parent manifest rather than creating new ones. ✅ Decided (F17).
7. **Multi-tenant deployment story.** Library-only for Phase 2; managed-service is Phase 3. **OPEN: confirm.**
8. **MCP resource lifecycle.** Session-scoped default; tenant-scoped when F18 enabled; sessionRetentionMs=1h after disconnect. ✅ Decided (F19).
9. **Local-model adapter scope.** Both Ollama and ComfyUI ship as first-class packages in Phase 2.2 (`@reaatech/media-pipeline-mcp-ollama`, `@reaatech/media-pipeline-mcp-comfyui`). User-supplied ComfyUI workflows via `workflowsDir`. ✅ Decided (F10).
10. **Batch failure semantics.** Surface partial success; `pipeline.batch.retry({ onlyFailed: true })`. ✅ Decided (F15).
11. **F8 router timing source.** `expectedDurationMs` from each provider's `pricing.json` (peer of unit pricing). Absence ⇒ candidate ineligible for `fastest` strategy. ✅ Decided (F8).
12. **F2 cache scope default.** `global` when F18 off; auto-switches to `tenant` when F18 enabled. Config can force either. ✅ Decided (F2 + F18).

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

_End of plan. This is the source of truth for Phase 2. All 21 features (F1–F21) are specified to the builder-ready bar: types, API, mechanism, per-provider matrix where applicable, test matrix, and backwards-compatibility note. The handoff for any feature is: "Build F#X per PHASE2_DEV_PLAN.md. Stop when the test matrix passes and `pnpm build && pnpm lint && pnpm typecheck && pnpm test` are green." A per-feature `docs/features/F##-<slug>.md` design note is only required if the builder discovers an issue this plan does not cover._
