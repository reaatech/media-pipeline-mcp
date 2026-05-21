# Examples — proposed additions

Phase 2 of `media-pipeline-mcp` introduces 21 features (F1–F21). Five examples currently ship in this directory (`agent-mesh-integration`, `document-intake-pipeline`, `podcast-clip-pipeline`, `product-photo-pipeline`, `standalone-tool-calls`). They cover the surface for "what does the MCP server look like" but don't yet show what makes Phase 2 distinctive: cost discipline, reliability under failure, smart routing, multi-tenancy, and provenance.

This file proposes ~10 additional runnable examples. Each is small enough to be one file under `examples/NN-<slug>/` (per the plan §"Per-feature documentation deliverables") and large enough to demonstrate the feature against something a real caller would build. Pick any you'd like implemented; none of them are written yet.

Conventions used below:
- **Features:** F#s from `PHASE2_DEV_PLAN.md` the example exercises.
- **What it proves:** the elevator-pitch sentence a reviewer would write after running it.
- **Footprint:** rough complexity — `S` (single file <100 LOC), `M` (single file 100–300 LOC), `L` (a subfolder with a CSV/JSON fixture plus the runner).

---

## 01 — `dry-run-then-execute` (cost discipline)

**Features:** F4 (budget caps), F5 (pipeline.estimate)

**What it proves:** the caller can preview a pipeline's cost band before paying for it, set a hard cap, and have the executor abort mid-run if the cap is crossed.

**Shape:**
1. Build a 4-step pipeline (image-gen + upscale + describe + summarize).
2. Call `pipeline.estimate({ pipeline })` → print `totalUsdLow / totalUsdHigh / perStep[]`.
3. Run `pipeline.execute({ pipeline, budget: { maxUsd: 0.20, onExceed: 'abort' } })`.
4. Re-run with a deliberately low cap (`0.01`) and demonstrate the `BUDGET_EXCEEDED` failure mode.

**Footprint:** S. No fixtures.

---

## 02 — `cheapest-routing-with-fallback` (cost story)

**Features:** F8 (routing), F2 (cache), optionally F10 (Ollama)

**What it proves:** the same step prompt resolves to whichever provider is cheapest+healthiest at request time, and re-runs hit cache for $0.

**Shape:**
1. Define an `image.generate` step with `route: { strategy: 'cheapest-acceptable', candidates: [fal-flux, stability-sd3, replicate-sdxl] }`.
2. Run it; print which candidate the router selected and the `RouteDecision.rejected[]` log.
3. Run it a second time with identical params; show the cache-hit cost rebate ($0).
4. Force a failure on the chosen candidate (env-mocked) and demonstrate fallback to the next.

**Footprint:** M. Needs `route.candidates` config + at least two real provider API keys (or mock providers via `MockProvider`).

---

## 03 — `ab-variants-with-judge` (quality routing)

**Features:** F9 (variants), F2 (cache for the judge to remain cheap on re-runs)

**What it proves:** the executor can fan out N image variants in parallel, run an LLM-judge against them, archive the losers, and surface the winner — without the caller writing the fan-out loop.

**Shape:**
1. One `image.generate` step with `variants: { n: 4, seedStrategy: 'sequential', judge: { type: 'llm-judge', criteria: 'best matches the prompt with no compositional errors', model: 'claude-sonnet-4-6' } }`.
2. Print the winner's score and the loser scores + rationales.
3. Re-run with `judge: { type: 'rule', expression: 'metadata.width >= 1024' }` to show the rule-judge path needs no LLM call.

**Footprint:** S–M.

---

## 04 — `resumable-long-running` (reliability under failure)

**Features:** F3 (resume), F1 (idempotency), F7 (webhook callback resume)

**What it proves:** a multi-step pipeline that fails mid-run can be resumed without re-paying for completed steps. Backbone of the "60% bill cut" story in the plan.

**Shape:**
1. Define a 5-step pipeline where step 3 is an artificially-flaky operation (provider returns 503 the first time).
2. Run it; expect a failure at step 3. Print `runId`.
3. Call `pipeline.resume({ runId })`. Steps 1 and 2 load their cached artifacts; step 3 retries and succeeds; steps 4–5 run normally.
4. Bonus: kill the example process between steps 2 and 3, restart it, and resume the same `runId` — this validates that resume works across process boundaries (Redis state store required).

**Footprint:** M. Needs Redis. The "flaky provider" can be a thin wrapper around `MockProvider`.

---

## 05 — `batch-1000-blog-heroes` (CSV batch)

**Features:** F15 (batch), F1 (per-row idempotency), F4 (per-run budget caps)

**What it proves:** one MCP call produces hundreds of artifacts from a CSV. Per-row failure isolation, deterministic retries, JSONL report artifact, per-row budget enforcement.

**Shape:**
1. `examples/05-batch-1000-blog-heroes/blog-posts.csv` with 50 rows (`headline,topic,brand`).
2. `pipeline.batch({ source: { type: 'csv', uri: 'file://blog-posts.csv' }, pipeline: { ... 'hero for {{headline}} on {{topic}}' ... }, concurrency: 10, onRowFailure: 'continue', perRunBudget: { maxUsd: 0.20, onExceed: 'abort' } })`.
3. Print `batchId`. Poll `pipeline.batch.status` until terminal.
4. Fetch the `reportArtifactId` JSONL and print success/failure counts.
5. Call `pipeline.batch.retry({ batchId, onlyFailed: true })` to demo retry semantics.

**Footprint:** L. Subfolder with the CSV.

---

## 06 — `aspect-ratio-fanout` (one prompt, three platforms)

**Features:** F11 (ratios), F2 (cache)

**What it proves:** the same prompt produces 1:1 (Instagram), 9:16 (Stories/TikTok), and 16:9 (YouTube) outputs in one step — native when the provider supports it, smart-cropped (entropy/face-aware) when it doesn't.

**Shape:**
1. One `image.generate` step with `ratios: { ratios: ['1:1', '9:16', '16:9'], fallback: 'smart-crop', faceAware: true }`.
2. Print the `RatioFanOutOutput.variants[]` array, noting which were `source: 'native'` vs `'cropped'`.
3. Bonus second pass with `fallback: 'pad'` and a `padColor: '#FF6B35'`.

**Footprint:** S.

---

## 07 — `voice-style-narration-with-burned-captions` (run context + subtitles)

**Features:** F13 (voice/style refs), F12 (subtitles + burn-in), F14 (loudness normalization)

**What it proves:** define a voice and a visual style once at pipeline scope, reuse them across steps via `{ $ref: ... }`, and produce a final mp4 with normalized audio and burned-in captions. The "shippable creator workflow" demo.

**Shape:**
1. Pipeline `context: { voices: { narrator: { provider: 'elevenlabs', voiceId: '...' } }, styles: { hero: { description: 'cinematic, golden hour' } } }`.
2. Step 1: `audio.tts` with `voice: { $ref: { kind: 'voice', name: 'narrator' } }`.
3. Step 2: loudness gate `{ type: 'loudness', preset: 'podcast', action: 'normalize' }`.
4. Step 3: `video.generate` with `style: { $ref: { kind: 'style', name: 'hero' } }`.
5. Step 4: `video.subtitle` with `burnIn: { fontSize: 28, position: 'bottom' }`.
6. Print artifact IDs and final mp4 URI.

**Footprint:** L. Needs ffmpeg.

---

## 08 — `multi-tenant-saas-bootstrap` (per-tenant key isolation)

**Features:** F18 (multi-tenant), F4 (per-tenant budget caps), F19 (tenant-scoped resources)

**What it proves:** one server instance can serve two tenants with separate provider keys, separate cost ledgers, separate artifact namespaces, and per-tenant budget caps — without the caller's pipeline definition changing.

**Shape:**
1. Bootstrap server with `multiTenant: { enabled: true, keyVault: new InMemoryKeyVault(...), resolver: { kind: 'header', headerName: 'X-Tenant-Id' } }`.
2. Pre-seed two tenants (`acme`, `beta`) with different fake API keys and different `budgetCaps.dailyUsd`.
3. Run the same pipeline as both tenants via two MCP clients (different `X-Tenant-Id` headers).
4. Print `cost.totalForTenant(acme, ...)` vs `cost.totalForTenant(beta, ...)`.
5. List storage objects under each tenant's prefix.
6. Trigger the `BUDGET_EXCEEDED(scope='tenant-daily')` path by pinning beta's cap below the run cost.

**Footprint:** M.

---

## 09 — `provenance-signed-news-image` (C2PA end-to-end)

**Features:** F17 (provenance), and verification via `c2patool`

**What it proves:** generated artifacts ship with a tamper-evident C2PA manifest naming the model, the pipeline DAG hash, and the operator. Required for EU AI Act compliance.

**Shape:**
1. Bootstrap server with `provenance: { enabled: true, signingKey: { source: { kind: 'pem-file', path: './fixtures/cert.pem', certPath: './fixtures/cert.crt' }, algorithm: 'es256' }, embedMode: 'in-file' }`.
2. Run a single-step `image.generate` pipeline.
3. Print the artifact path. The example documents next-step verification: `c2patool verify <file>`.
4. Subfolder includes a test PEM keypair (clearly labeled "FOR DEMO ONLY").

**Footprint:** L. Includes the throwaway cert fixture and a `README.md` with the verify command.

---

## 10 — `realtime-meeting-transcript` (live STT)

**Features:** F20 (audio.transcribeStream), F6 (progress events), F4 (per-stream budget cap)

**What it proves:** the server can hold a WebSocket open to Deepgram and stream interim + final transcripts back over MCP progress notifications — usable as the back-end for live captions or a voice agent.

**Shape:**
1. Open `audio.transcribeStream({ source: { kind: 'url', url: '<sample-30s-audio.wav>' }, language: 'en', diarize: true })` with a `progressToken`.
2. Subscribe to `notifications/progress` and print each `interim` and `final` event as it arrives.
3. Demonstrate the F4 cap: re-run with `budget: { maxUsd: 0.01, onExceed: 'abort' }` against a 5-minute input and show the mid-stream cancellation.

**Footprint:** M. Needs a `DEEPGRAM_API_KEY` and a sample audio URL (or a `fixtures/` mp3).

---

## 11 — `local-comfyui-workflow` (self-hosted image gen)

**Features:** F10 (ComfyUI provider), F2 (cache), F11 (ratios)

**What it proves:** with ComfyUI running locally, the same step API that hits Stability or Fal in the cloud can hit a local SDXL workflow for $0. Critical for high-volume internal use.

**Shape:**
1. Server bootstrap registers `ComfyUIProvider({ baseUrl: 'http://localhost:8188', workflowsDir: './workflows' })`.
2. Subfolder ships a `workflows/portrait-sdxl.json` user workflow.
3. Step: `{ operation: 'image.generate', provider: 'comfyui', model: 'workflow:custom/portrait-sdxl', inputs: { prompt: '...', seed: 42, steps: 25 } }`.
4. Re-run with the same seed and show the F2 cache hit ($0).
5. Bonus: combine with F11 `ratios` to fan out one ComfyUI call into 3 ratios.

**Footprint:** L. Requires ComfyUI on the user's machine; README documents the setup.

---

## 12 — `safety-gate-default-on` (default-on moderation)

**Features:** F16 (safety gate default-on), F9 (composes with variants)

**What it proves:** even without an explicit `gates: [{ type: 'safety' }]`, the executor injects a moderation gate for any moderable operation when `features.safetyGate: true` (the Phase 2.4 default). Validates the "you can't ship unmoderated outputs by accident" guarantee.

**Shape:**
1. Run an image-gen pipeline against a benign prompt — verify it completes, log the implicit verdict.
2. Run against a prompt likely to trip the moderation backend — verify `SAFETY_GATE_REJECTED`.
3. Re-run the same hostile prompt with `features.safetyGate: false` — verify it succeeds, demonstrating opt-out works (and proving the default matters).
4. Combine with F9 variants: 4-image fan-out where one variant trips safety and the judge picks from the remaining three.

**Footprint:** M.

---

## Suggested implementation order

If you can only build a few first, this is the order that maximizes "wow per hour":

1. **01 dry-run-then-execute** — shortest, immediately useful, no external services.
2. **05 batch-1000-blog-heroes** — biggest "I see why I'd buy this" moment.
3. **02 cheapest-routing-with-fallback** — the headline cost story.
4. **04 resumable-long-running** — the headline reliability story.
5. **07 voice-style-narration-with-burned-captions** — most concretely-shippable creator workflow.

Everything else is incremental coverage. The five-pack above hits eight features (F1, F2, F3, F4, F5, F7, F8, F12, F13, F14, F15) and demonstrates the Phase 2 thesis end-to-end.

---

## Out of scope for examples

These features are real but unlikely to make compelling standalone examples:

- **F6 streaming progress** — wired into the other examples (e.g., 10, 04) rather than its own.
- **F19 MCP resources** — better demonstrated implicitly by examples that produce artifacts (every example, really); a standalone "here are some artifacts" demo would be thin.
- **F21 3D mesh** — until format conversion (assimp/gltfpack) ships, the output viewer story is weak. Worth picking up once Phase 2.5 is complete.
