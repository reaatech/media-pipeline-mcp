# PHASE2_DEV_PLAN.md — media-pipeline-mcp

Target: 21 features that move this from a multi-provider wrapper to a production-grade media orchestration layer. Five phases. Each phase composes from primitives the previous phase introduced.

This document defines **what to build, where it lives, the public API, and the dependencies between features.** It does not prescribe sprints or estimates beyond rough sizing. Pick a phase, pick a feature, ship it.

---

## 0. Cross-cutting prerequisites

These must land before Phase 2.1 features can be implemented coherently. They are not features themselves; they are the foundation Phase 2 builds on.

### 0.1 Pipeline state store (`packages/persistence`)

A new package. Pipelines must be persistable so they can be resumed, suspended for webhooks, and audited. The current pipeline executor holds state in memory only.

```ts
interface PipelineStateStore {
  create(run: PipelineRun): Promise<void>;
  get(runId: string): Promise<PipelineRun | null>;
  update(runId: string, patch: Partial<PipelineRun>): Promise<void>;
  appendEvent(runId: string, event: PipelineEvent): Promise<void>;
  listEvents(runId: string, since?: number): Promise<PipelineEvent[]>;
  // For webhook resume:
  findByExternalJobId(provider: string, jobId: string): Promise<PipelineRun | null>;
}
```

Implementations: `InMemoryPipelineStateStore` (default), `RedisPipelineStateStore`, `PostgresPipelineStateStore` (later). Mirror the existing `TaskStore` shape from `packages/storage` but with append-only event log semantics.

### 0.2 Cost ledger (`packages/core` or new `packages/cost`)

The existing `cost-tracker.ts` in server is per-request. We need a persistent, queryable ledger per pipeline run + per tenant. Backs F4 (budget caps), F15 (dry-run estimation), F19 (multi-tenant).

```ts
interface CostLedger {
  charge(runId: string, entry: CostEntry): Promise<void>;
  totalForRun(runId: string): Promise<number>;
  totalForTenant(tenantId: string, since: Date): Promise<number>;
  preflight(estimate: CostEstimate): Promise<{ allowed: boolean; reason?: string }>;
}

interface CostEntry {
  provider: string;
  operation: string;
  modelId: string;
  inputUnits: number;   // tokens, seconds, pixels
  outputUnits: number;
  usd: number;
  at: Date;
}
```

### 0.3 Event bus (`packages/core`)

A typed in-process event emitter used by Phase 2.1 streaming + Phase 2.4 webhooks. Don't bring in a heavy library — a 50-line typed emitter suffices.

```ts
type PipelineEvent =
  | { kind: 'step-started'; stepId: string; at: number }
  | { kind: 'step-progress'; stepId: string; pct: number; etaMs?: number; message?: string }
  | { kind: 'step-completed'; stepId: string; artifactIds: string[]; costUsd: number }
  | { kind: 'step-failed'; stepId: string; error: A2AError; retryable: boolean }
  | { kind: 'pipeline-suspended'; reason: 'webhook' | 'budget' | 'gate'; resumeToken: string }
  | { kind: 'pipeline-completed'; totalCostUsd: number };
```

---

## Phase 2.1 — Pipeline reliability and economics

Foundation features. After this phase, the project is the cheapest and most reliable way to chain media ops.

### F1. Idempotency keys

**Value:** identical MCP calls with the same `Idempotency-Key` return the prior response without re-billing.

**API:**
```ts
// MCP request metadata
{ "_meta": { "idempotencyKey": "uuid-v7-from-caller" } }
```

**Storage:** in `packages/core/idempotency.ts` — a key → `{ responseHash, response, at, runId }` map. TTL 24h. Backed by `PipelineStateStore` (0.1).

**Affected:** `packages/server/mcp-server.ts` (intercept request), `packages/core/pipeline-executor.ts` (short-circuit on hit).

**Behavior:**
- Hit on completed: return stored response, no provider calls.
- Hit on in-flight: return 409 with `Retry-After`.
- Hit on failed: replay the failure unless a new key is presented.

**Open:** scope of the key — per-MCP-call or per-pipeline-run? Recommend per-pipeline-run, with sub-step idempotency handled by F2 (cache).

---

### F2. Content-addressed artifact cache

**Value:** `hash(model + prompt + seed + params + provider-version) → artifact_id`. Iterating prompts doesn't re-bill identical operations.

**API:** internal to `BaseProvider.executeWithRetry`. Caller opts in/out via pipeline step config:
```ts
step: {
  operation: 'image.generate',
  cache: { mode: 'use' | 'refresh' | 'skip', ttlSeconds?: number }
}
```

**Cache key:**
```
sha256(
  provider + "::" + modelId + "::" +
  canonicalJson(normalizedInputs) + "::" +
  canonicalJson(deterministicParams)
)
```
where `normalizedInputs` collapses whitespace, lowercases optional fields, and strips non-deterministic params (timestamps, request IDs).

**Storage:** new namespace in `packages/storage` (`artifact-cache:<key>` → artifact_id). The artifact itself is already content-addressed by storage; this is a *params → artifact-id* index.

**Affected:** `packages/provider-core/base-provider.ts` (cache lookup before `execute()`), all 9 providers (declare which params participate in the key — providers that ignore seed need to opt out).

**Negative cases:**
- TTS with random seed: opt out of cache by listing `seed` in `nonDeterministicParams`.
- Provider-side moderation that could change verdict: cache the verdict separately with shorter TTL.

---

### F3. Resumable pipelines

**Value:** step 5 of 7 fails; resume from step 5 with artifacts 1–4 intact.

**API:**
```ts
// MCP tool
pipeline.resume({ runId: string, fromStep?: string })

// Or auto-resume on retry
{ pipeline: {...}, resumeFrom?: { runId, step } }
```

**Storage:** `PipelineStateStore` (0.1) keeps step-level state: `{ stepId, status, inputs, outputs, artifactIds, costUsd, attempts, lastError }`.

**Affected:** `packages/pipeline/pipeline-executor.ts` — execute() reads existing state, skips completed steps, replays partial steps from their inputs.

**Semantics:**
- `completed` step → skipped, artifacts loaded from registry.
- `failed` step → re-executed with original inputs.
- `running` step → check idempotency cache (F1); if hit, treat as completed; if not, re-execute.
- Quality-gate-rejected step → re-executed with same retry budget.

**Open:** clean up of orphaned partial artifacts on resume? Recommend keep them, namespace by attempt number.

---

### F4. Hard budget caps with enforcement

**Value:** `maxUsd: 5.00` aborts the pipeline mid-run before it overruns.

**API:**
```ts
pipeline.execute({
  ...,
  budget: { maxUsd: 5.00, onExceed: 'abort' | 'suspend' }
})
```

**Mechanism:**
1. **Preflight** — before each step, the provider's `estimateCost(inputs)` is consulted; if `ledger.total() + estimate > budget.maxUsd`, the step doesn't execute.
2. **Streaming** — for ops that bill per-output-token/second, the cost ledger is updated as the stream progresses; cap trips kill the stream.

**Affected:** `packages/cost` (0.2), every provider needs `estimateCost(inputs): CostEstimate`, `packages/pipeline/pipeline-executor.ts`.

**Open:** what happens to in-flight provider jobs (e.g., a 60s Fal video gen) when the cap trips? Recommend: let them complete and charge against the next-run budget rather than waste the spend.

---

### F5. Dry-run cost estimation

**Value:** `pipeline.estimate({...})` returns per-step cost breakdown before spending a cent.

**API:**
```ts
const est = await mcp.callTool('pipeline.estimate', { pipeline: {...} });
// → {
//   totalUsdLow: 0.42, totalUsdHigh: 1.18,
//   perStep: [
//     { stepId: 'gen', op: 'image.generate', model: 'flux-pro', usdLow: 0.04, usdHigh: 0.04 },
//     { stepId: 'upscale', op: 'image.upscale', model: 'real-esrgan', usdLow: 0.0008, usdHigh: 0.0008 },
//     ...
//   ]
// }
```

**Mechanism:** every provider implements `estimateCost(input): { low, high }`. The pipeline walks the DAG, propagating estimated output sizes (image dims, audio duration) to downstream steps.

**Affected:** every provider, `packages/core/pipeline-executor.ts`, new MCP tool in `packages/server`.

**Note:** estimates for variable-output ops (LLM with `max_tokens`, video gen with variable steps) have a low/high range. Document the convention.

---

### F6. Streaming progress events

**Value:** video gen takes 4 minutes; agents currently see no output until done. Stream progress over MCP.

**API:** uses MCP's streamed tool-result protocol. Each tool call returns a stream of `progress` notifications + a final result.

```ts
// On the wire (simplified)
{ method: "progress", params: { stepId, pct: 0.40, etaMs: 90000, message: "Decoding frame 1200/3000" } }
...
{ method: "result", params: { artifactId, costUsd, ... } }
```

**Mechanism:** `ExecutionEventBus` (0.3) emits `step-progress` events. The MCP server bridges those to JSON-RPC progress notifications keyed by the active call's progress token.

**Affected:** `packages/server/mcp-server.ts`, every provider that has streamable progress (Replicate prediction polling, Fal queue events, Deepgram streaming STT).

**Open:** how much detail per event? Recommend: pct + ETA + a single-line message. Don't stream every token.

---

### F7. Webhook delivery for async provider jobs

**Value:** Replicate/Fal jobs take minutes. Polling burns budget and ties up the MCP server. Suspend the pipeline; resume on webhook callback.

**API:**
```ts
pipeline.execute({
  ...,
  async: { webhookUrl?: 'https://yours.example/cb', onComplete: 'callback' | 'poll' }
})
```

**Server-side:**
- Express route `POST /webhooks/:provider/:runId` (or Hono equivalent), HMAC-signed using a per-run secret.
- On webhook receipt: load `PipelineRun` by `externalJobId`, mark step completed, resume pipeline (F3).

**Affected:**
- `packages/server` — webhook routes + HMAC verifier per provider.
- `packages/replicate`, `packages/fal`, `packages/elevenlabs` — pass webhook URL to provider SDK instead of polling.
- `packages/pipeline` — pipeline executor learns to suspend on `provider returned job-id, expecting webhook`.

**Open:** outbound delivery of pipeline-completion webhooks to the user's URL? Add `pipeline.subscribe({ runId, webhookUrl })` as a separate tool — same delivery infra.

---

## Phase 2.2 — Smart routing

Once F1–F7 ship, these become possible. The differentiation tier.

### F8. Provider fallback chains with cost/quality routing

**Value:** "try Fal-Flux; if queue >30s or fails, fall back to Stability SDXL." The single biggest cost-saving feature.

**API:**
```ts
step: {
  operation: 'image.generate',
  route: {
    strategy: 'first-success' | 'cheapest-acceptable' | 'fastest',
    candidates: [
      { provider: 'fal', model: 'flux-pro-1.1', maxQueueMs: 30000 },
      { provider: 'stability', model: 'sd3-medium', maxUsd: 0.05 },
      { provider: 'replicate', model: 'sdxl' }
    ]
  }
}
```

**Mechanism:**
- New `Router` class in `packages/provider-core/router.ts`.
- `cheapest-acceptable`: get cost estimates from all candidates, pick lowest whose `estimateUsd <= maxUsd` and whose provider passes health-check.
- `first-success`: try in order; on failure or timeout, try next.
- `fastest`: race them all, take first success, cancel others (only sane for sub-5s ops).

**Affected:** `packages/provider-core`, `packages/pipeline`, every provider gains health-check + queue-depth signal.

**Depends on:** F4 (budget caps), F5 (estimates), F1 (idempotency for cancelled races).

---

### F9. A/B variant generation with gate-as-judge

**Value:** generate 4 variants → quality gate (llm-judge) picks the best → only the winner counts.

**API:**
```ts
step: {
  operation: 'image.generate',
  variants: { n: 4, judge: { type: 'llm-judge', criteria: 'best matches the prompt' } },
  inputs: { prompt: '...' }
}
```

**Mechanism:** pipeline executor runs N executions in parallel (under F4 budget), passes all N artifacts to the gate's judge, drops losers (artifact registry marks them archived, doesn't delete), returns the winner.

**Affected:** `packages/pipeline`, existing quality-gates evaluator.

**Cost note:** without F2 cache, this can 4x a step's bill. The gate's `cheapest-acceptable` mode should pair with cheaper variant providers.

**Depends on:** F2, F4, F8.

---

### F10. Local-model adapters

**Value:** self-hosters plug in Ollama for llm-judge + embeddings, ComfyUI for image gen. Cost goes to ~zero.

**New packages:**
- `packages/ollama-provider` — chat completions, embeddings, llm-judge.
- `packages/comfyui-provider` — image gen via local ComfyUI workflows.

**API shape:** same `BaseProvider` interface; just point at `http://localhost:11434` (Ollama) or `http://localhost:8188` (ComfyUI).

**Mechanism:** ComfyUI is the interesting one — accepts JSON workflows. Ship a few canonical workflows (text-to-image SDXL, inpainting) and let users supply their own via a workflow registry.

**Affected:** two new packages. No changes to core.

**Depends on:** nothing — could ship alongside Phase 2.1.

---

## Phase 2.3 — Workflow operations

Composite operations that reduce 4-step pipelines to 1-call ops. High convenience value.

### F11. Aspect-ratio fan-out

**Value:** `image.generate({ ratios: ['1:1','9:16','16:9'] })` returns three artifacts. Avoids 3 separate calls + 3 composite steps.

**API:**
```ts
step: {
  operation: 'image.generate',
  inputs: { prompt: '...' },
  fanout: { ratios: ['1:1', '9:16', '16:9'] }
}
// Returns artifactIds[0..2], one per ratio
```

**Mechanism:** packages/image-edit gains a `fanoutByRatio()` step that calls the underlying generator per ratio (some providers natively support ratio; for others, generate at max ratio + smart crop via Sharp).

**Affected:** `packages/image-edit`, every image-gen provider (declare native ratios; otherwise fall back to post-crop).

**Depends on:** F2 (cache so identical-ratio re-runs are free).

---

### F12. Subtitle pipeline as a first-class op

**Value:** `video.subtitle({ artifactId, language: 'en', burnIn: true })` does STT → SRT → optional burn-in. Today this is 4 stitched ops.

**API:**
```ts
{
  operation: 'video.subtitle',
  inputs: { video_artifact: '...' },
  config: { language: 'en', style: 'youtube' | 'broadcast', burnIn: true, format: 'srt' | 'vtt' }
}
// Returns: { videoArtifactId (if burnIn), subtitleArtifactId, words: [{ start, end, text }] }
```

**Mechanism:**
1. Extract audio (ffmpeg).
2. STT with timestamps (Deepgram nova-2 or Whisper).
3. Group into subtitle lines (max chars, max duration).
4. Emit SRT/VTT artifact.
5. If burnIn, ffmpeg burn into video → new video artifact.

**Affected:** new `packages/video-gen` op or new `packages/subtitle` package. Bundles ffmpeg as a runtime dep (or system requirement — pick one and document).

**Depends on:** F2 (cache the STT pass).

---

### F13. Voice/style consistency tracking

**Value:** a podcast pipeline with 30 TTS calls must use the same voice for the same speaker every time. Currently caller must pass voice_id each call.

**API:**
```ts
pipeline.execute({
  ...,
  context: {
    voices: { speaker_a: { provider: 'elevenlabs', voiceId: 'X' },
              speaker_b: { provider: 'elevenlabs', voiceId: 'Y' } }
  },
  steps: [
    { operation: 'audio.tts', inputs: { text: '...', speaker: 'speaker_a' } },
    ...
  ]
})
```

**Mechanism:** pipeline executor carries a `RunContext` object accessible to every step. Steps resolve `speaker` → `voiceId` via the context. Same pattern for `style`, `tone`, `brandKit`.

**Affected:** `packages/core/pipeline-executor.ts` (RunContext), every TTS-capable provider.

---

### F14. Cross-provider loudness normalization

**Value:** OpenAI TTS comes out at -22 LUFS, ElevenLabs at -16, Deepgram at -18. Auto-normalize to spec.

**API:** new gate type:
```ts
qualityGate: { type: 'loudness', target: { lufs: -14, truePeak: -1.0 }, action: 'normalize' | 'warn' | 'fail' }
```

**Mechanism:** ffmpeg `loudnorm` filter; two-pass for accuracy. Wrap as a quality-gate evaluator + auto-fix.

**Affected:** `packages/core/quality-gates`, `packages/audio-gen`.

---

### F15. CSV-driven batch generation

**Value:** "generate one product photo per row of products.csv, with cost tracking per row."

**API:**
```ts
// MCP tool
pipeline.batch({
  pipeline: {...},
  source: { type: 'csv', uri: 'gs://...', columnMap: { prompt: 'description', style: 'category' } },
  concurrency: 4,
  onRowFailure: 'continue' | 'abort'
})
// Returns: { batchId, runIds: [], reportArtifactId }
```

**Mechanism:** new `packages/batch` package. Loads CSV row-by-row, instantiates one pipeline run per row with interpolated inputs, tracks per-row cost in a single ledger entry, emits a final report artifact (CSV with runId + cost + result-artifact-id per row).

**Affected:** new package, `packages/cost`, `packages/server` (new MCP tool).

**Depends on:** F4 (per-run budget), F6 (progress streaming for whole-batch ETA).

---

## Phase 2.4 — Safety and trust

Production-environment table stakes. Without these, regulated industries (and some platforms) can't ship the output.

### F16. Safety/moderation as a default-on gate

**Value:** OpenAI moderation + image NSFW classifier built into the gate library. Default-on so people don't ship something embarrassing.

**API:**
```ts
// Auto-applied to every text-input and every generated image unless explicitly opted out
qualityGate: { type: 'safety', categories: ['nsfw', 'violence', 'hate'], threshold: 0.7, action: 'fail' }
```

**Mechanism:** new quality-gate evaluator. Text inputs → OpenAI moderation API. Generated images → choose between OpenAI image moderation, a classifier model on Replicate (e.g., `falcons-ai/nsfw_image_detection`), or a local one via F10.

**Default:** ON for outputs, OFF for inputs (since outputs are what gets published).

**Affected:** `packages/core/quality-gates`, new dep on whichever moderation model.

---

### F17. C2PA / AI provenance signing

**Value:** embed signed provenance manifests in image/video output. Required by Meta, YouTube, X for AI-generated content.

**API:**
```ts
pipeline.execute({
  ...,
  provenance: { sign: true, signer: { keyId: 'kms://...' }, manifest: { producer: 'My Co' } }
})
```

**Mechanism:** new `packages/provenance` package. Uses `c2pa-node` (Adobe's library) to embed manifests describing the model, inputs, and pipeline graph. Outputs a re-signed artifact alongside the original.

**Manifest contents:**
- AI tool name + version (this package).
- Provider + model + prompt summary.
- Pipeline DAG hash.
- Timestamp.
- Optional caller-supplied producer info.

**Affected:** new `packages/provenance`, integrates with artifact storage.

**Open:** which signing key infra to support out-of-the-box? Recommend: KMS (AWS, GCP), local PEM, and DID-based. Start with PEM + AWS KMS.

---

### F18. Multi-tenant API key vault

**Value:** SaaS deployment — each caller's provider keys, isolated; per-tenant cost ledger.

**API:** at MCP-server bootstrap:
```ts
createA2AExpressApp({
  multiTenant: true,
  tenantResolver: (req) => req.headers['x-tenant-id'],
  keyVault: 'aws-secrets-manager' | 'gcp-secret-manager' | 'env' | InMemoryKeyVault
})
```

Per-request: caller's tenant id resolves which provider keys + which cost ledger.

**Mechanism:** new `packages/keyvault` package. Each provider's `init()` gets keys from the vault on a per-request basis (cached for the request lifetime).

**Affected:** `packages/security`, `packages/server`, every provider (accept keys from caller context rather than env vars only).

**Depends on:** F4 cost ledger (extended with tenant scope).

---

## Phase 2.5 — Surface expansion

New capabilities and adjacent MCP surface.

### F19. MCP resources for artifacts

**Value:** today you expose tools; expose `artifact://<id>` as MCP resources too. Agents reference outputs across turns without re-uploading.

**API:** the MCP server registers a resource handler:
```ts
// In packages/server
server.setResourceHandler({
  list: async () => listArtifactsForAgent(currentSession),
  read: async (uri) => storage.readArtifact(parseArtifactUri(uri))
});
```

Agents see: `artifact://abc123` as a resource they can read directly via MCP's `resources/read` method.

**Affected:** `packages/server/mcp-server.ts`, `@modelcontextprotocol/sdk` resource API.

**Open:** scope — per-session, per-tenant, or global? Recommend per-session by default, per-tenant if F18 is enabled.

---

### F20. Real-time STT streaming

**Value:** live captioning. Deepgram supports it; no MCP server exposes it.

**API:** new MCP tool that returns a streaming result:
```ts
audio.transcribeStream({
  source: { type: 'webrtc-offer-sdp', sdp: '...' } | { type: 'rtmp-url', url: '...' },
  language: 'en'
})
// Streams transcript fragments + final
```

**Mechanism:** packages/deepgram exposes the WebSocket streaming API. MCP server bridges the WS to MCP's streaming result protocol (F6).

**Affected:** `packages/deepgram`, `packages/server`.

**Depends on:** F6 (streaming events).

---

### F21. 3D model generation

**Value:** Meshy, Luma Genie, TripoSR. New category, almost no MCP coverage.

**New package:** `packages/3d-gen` operation, plus provider implementations:
- `packages/meshy` — text-to-3D, image-to-3D.
- `packages/luma` — text-to-3D via Genie API.

**API:**
```ts
mesh.generate({
  inputs: { prompt: '...' | { image_artifact: '...' } },
  config: { format: 'glb' | 'fbx' | 'usdz', topology: 'triangle' | 'quad' }
})
// Returns: { artifactId } pointing to a GLB/FBX file
```

**Affected:** new packages. Storage already handles arbitrary binary artifacts.

**Depends on:** nothing — could ship standalone.

---

## Implementation order

```
                          0.1 Pipeline state store
                          0.2 Cost ledger
                          0.3 Event bus
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

## Sizing (rough, in person-days assuming familiar with the codebase)

| Item | Days | Notes |
|---|---|---|
| 0.1 Pipeline state store | 2 | In-memory + Redis; Postgres later. |
| 0.2 Cost ledger | 2 | Extends existing cost-tracker. |
| 0.3 Event bus | 0.5 | Typed emitter. |
| F1 Idempotency | 1 | Mostly server-side middleware. |
| F2 Content cache | 3 | Per-provider normalization is the work. |
| F3 Resume | 3 | Pipeline executor refactor. |
| F4 Budget caps | 2 | Per-provider estimateCost(). |
| F5 Dry-run | 1 | Once F4's estimateCost is in. |
| F6 Streaming | 2 | MCP progress notif plumbing. |
| F7 Webhooks | 3 | Routes + per-provider webhook config + HMAC + resume integration. |
| F8 Routing | 3 | Multi-strategy router + health checks. |
| F9 A/B variants | 1.5 | Mostly composition. |
| F10 Local models | 4 | Ollama + ComfyUI (2 days each). |
| F11 Aspect fanout | 1.5 | Smart-crop fallback. |
| F12 Subtitles | 3 | ffmpeg integration + burn-in. |
| F13 Voice context | 1 | RunContext propagation. |
| F14 Loudness | 1 | ffmpeg two-pass. |
| F15 CSV batch | 2 | Standalone package. |
| F16 Safety gate | 2 | Moderation API + image classifier. |
| F17 C2PA | 4 | Signing infra is the work. |
| F18 Multi-tenant | 4 | Keyvault + per-tenant ledger refactor. |
| F19 MCP resources | 1.5 | SDK plumbing. |
| F20 STT stream | 2 | Deepgram WS bridge. |
| F21 3D gen | 3 | Two providers + new op. |

Total: ~57 person-days. Realistic calendar with one engineer: 4–6 months. With two: 2–3 months.

---

## Open decisions (need answers before starting Phase 2.1)

1. **State store backend default.** Redis is the natural default for Phase 2.1 features (most ops want a real datastore). Acceptable for v0.2 to ship without Postgres, with a clear migration story?

2. **Cache key invariance.** Should the cache key include provider SDK version? (Pro: model output sometimes changes across SDK versions. Con: kills the cache hit rate on every SDK bump.) Recommend: include provider+model version strings, not SDK version.

3. **Budget enforcement granularity.** Per-pipeline-run only, or also per-tenant per-day (paired with F18)? Recommend: both, with per-tenant as the harder cap.

4. **Webhook security model.** HMAC with per-run shared secret (simple, works for self-hosted) vs. mTLS (enterprise, more setup)? Recommend: HMAC by default, document mTLS for serious deployments.

5. **Safety gate defaults.** Default-on for outputs feels right but means every call hits OpenAI moderation. Cost is negligible (~$0.0001/call) but it adds latency. Recommend: default-on with a documented `safety: false` opt-out.

6. **C2PA scope.** Sign only outputs of generative ops, or every artifact including derived (resize, crop)? Recommend: sign only generative ops; resize/crop is a transformation, not generation.

7. **Multi-tenant deployment story.** Is this a "library you embed in your own SaaS" or "managed service we run"? The former changes the surface considerably (keyvault becomes an interface, not an implementation). Recommend: library-only for Phase 2; managed is Phase 3.

8. **MCP resource lifecycle.** When does an artifact disappear from the resources list? Per-session, per-pipeline-run, never (with TTL)? Recommend: session-scoped by default, per-tenant with retention policy if F18 is on.

9. **Local-model adapter scope.** Ollama is straightforward (single API). ComfyUI requires shipping/maintaining workflow templates. Big maintenance commitment — willing to take it on? Recommend: ship Ollama in Phase 2.2; ComfyUI as a community-contributed package in Phase 2.3 or later.

10. **Batch failure semantics.** When a batch of 100 rows hits 5 failures, do we surface partial success and let the caller retry only the failures? Recommend: yes, the batch report artifact lists per-row status and a `pipeline.batch.retry(batchId, { onlyFailed: true })` resumes.

---

## Non-goals for Phase 2

Explicitly out of scope, to keep this finite:

- **Browser-side execution.** Server-side only. No WebGPU.
- **Custom model training.** Not building a training loop; we route to inference APIs and local inference servers.
- **Real-time video transformation.** Live STT (F20) yes; live video filtering no.
- **General LLM-orchestration framework.** This is media-pipeline-focused. Don't drift into LangChain territory.
- **GUI / admin dashboard.** CLI + MCP surface only; dashboards are downstream tools.
- **Custom pipeline DSL.** JSON over MCP is the surface. No YAML, no DAG-as-code DSL.

---

_End of plan. This document is the input to per-feature design docs; each `F#` should grow its own design note in `docs/features/F##-<slug>.md` before implementation starts. That design note specifies the exact public types, error cases, and test matrix._
