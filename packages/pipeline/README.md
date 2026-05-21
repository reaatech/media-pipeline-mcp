# @reaatech/media-pipeline-mcp-pipeline

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-pipeline.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Pipeline operations package providing pre-built templates, variable interpolation, variants execution with LLM/image/rule-based judging, batch processing from CSV/JSONL, aspect-ratio fan-out with native/derived rendering, run context resolution (voices, styles, brand kit), and audio/video quality gates (loudness normalization, content safety classification).

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-pipeline
# or
pnpm add @reaatech/media-pipeline-mcp-pipeline
```

## Feature Overview

- **Pre-built pipeline templates** — `product-photo`, `social-media-kit`, `document-intake`, `video-thumbnail` with variable substitution
- **Variable interpolation** — `{{variable_name}}` for template instantiation and `{{stepN.output}}` for step reference resolution
- **Variants execution (F9)** — generate N variants with configurable seed strategy, judge them via `llm-judge`, `image-judge` (CLIP/aesthetic), `rule` expression, or `custom` tool, and pick a winner
- **Batch processing (F15)** — process CSV, JSONL, or inline rows through a pipeline template with configurable concurrency, per-run budgets, retry-once mode, and JSONL report persistence
- **Aspect-ratio fan-out (F11)** — native rendering for supported ratios, smart-crop/pad derivation for unsupported ones, optional `sharp` peer dependency for image manipulation, face-aware cropping support
- **Run context resolution (F13)** — resolve `$ref` objects for voice (ElevenLabs, OpenAI, Google, Deepgram), style (per-provider prompt overrides), and brand kit (colors, fonts, logo)
- **Loudness gate (F14)** — EBU R128 loudness measurement via ffmpeg `loudnorm`, normalize/warn/fail actions, presets for YouTube, Spotify, podcast, ATSC, and EBU broadcast standards
- **Content safety gate (F16)** — multi-provider safety classification via OpenAI Moderation API and Replicate NSFW detector, per-category thresholds, unconditional CSAM blocking, audit logging
- **Type/mime auto-inference** — operation prefixes (`image.*`, `audio.*`, `video.*`, `document.*`) mapped to artifact types and MIME types
- **Pipeline validation** — duplicate step IDs, circular references, forward references, missing step references

## Quick Start

```typescript
import { createPipelineOperations } from "@reaatech/media-pipeline-mcp-pipeline";
import { ArtifactRegistry } from "@reaatech/media-pipeline-mcp-core";

const registry = new ArtifactRegistry();
const ops = createPipelineOperations(registry);

// List available templates
const templates = ops.listTemplates();
// [{ id: "product-photo", name: "Product Photo Pipeline", ... }, ...]

// Instantiate a template with variables
const pipeline = ops.interpolateVariables(
  ops.getTemplate("product-photo")!,
  { prompt: "Professional product photo of a running shoe", dimensions: "1080x1080" },
);

// Validate and execute
const validation = ops.validatePipeline({ id: "my-run", steps: pipeline });
if (validation.valid) {
  const result = await ops.executePipeline({ id: "my-run", steps: pipeline });
  console.log(result.status); // "completed"
  result.artifacts.forEach(a => console.log(a.id, a.type));
}
```

## API Reference

### `PipelineOperations`

Central class for template management and pipeline execution.

```typescript
class PipelineOperations {
  constructor(artifactRegistry: ArtifactRegistry, options?: PipelineOperationsOptions);

  // Template management
  listTemplates(): PipelineTemplate[];
  getTemplate(templateId: string): PipelineTemplate | undefined;
  interpolateVariables(template: PipelineTemplate, variables: Record<string, string>): PipelineStep[];

  // Validation & execution
  validatePipeline(pipeline: { id?: string; steps: Array<{ id: string; inputs: Record<string, unknown> }> }): { valid: boolean; errors: string[] };
  executePipeline(pipeline: { id?: string; steps: Array<{ id: string; operation: string; inputs: Record<string, unknown>; config?: Record<string, unknown> }> }): Promise<{ status: PipelineStatus; artifacts: Artifact[]; cost_usd: number; duration_ms: number; error?: string }>;

  // Advanced features
  resumePipeline(runId: string, fromStepId?: string): Promise<Pipeline>;
  estimatePipeline(pipeline: PipelineDefinition): Promise<PipelineEstimate>;
  executeVariants(step: PipelineStep, variantsConfig: VariantsConfig, context: VariantsExecutorContext): Promise<VariantsStepOutput>;
}
```

#### `PipelineOperationsOptions`

| Property | Type | Description |
|----------|------|-------------|
| `executor` | `PipelineExecutor` | Pipeline executor instance (enables resume) |
| `estimator` | `PipelineEstimator` | Cost estimator instance (enables estimate) |
| `variantsExecutor` | `VariantsExecutor` | Variants executor instance (enables variants) |

#### `PipelineTemplate`

```typescript
interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: Omit<PipelineStep, "id">[];
}
```

### Pre-Built Templates

| Template ID | Name | Steps |
|-------------|------|-------|
| `product-photo` | Product Photo Pipeline | generate (1024x1024) → upscale (4x) → remove background |
| `social-media-kit` | Social Media Kit | generate (1024x1024) → resize to 1080x1080, 1080x1350, 1200x630 |
| `document-intake` | Document Intake | OCR → extract fields → summarize (short, bullet-points) |
| `video-thumbnail` | Video Thumbnail | extract frames (interval: 30s) → describe (brief) → upscale (2x) |

### `VariantsExecutor` (F9)

Generates N variants of a step and judges them to pick a winner.

```typescript
class VariantsExecutor {
  executeVariants(step: PipelineStep, config: VariantsConfig, context: VariantsExecutorContext): Promise<VariantsStepOutput>;
}
```

#### Judge Types

| Type | Config | Description |
|------|--------|-------------|
| `llm-judge` | `{ criteria: string; model?: string; rubric?: JudgeRubric }` | LLM scores each variant against criteria |
| `image-judge` | `{ criteria: "clip-score" \| "aesthetic"; reference?: string }` | External CLIP or aesthetic model scoring |
| `rule` | `{ expression: string }` | Rule-based scoring: `"metadata.width >= 1024"` |
| `custom` | `{ toolName: string }` | External tool integration |

#### Seed Strategies

| Strategy | Behavior |
|----------|----------|
| `random` | Random seed per variant |
| `sequential` | Incrementing seeds (1, 2, 3, ...) |
| `fixed-list` | Seeds from a provided fixed array |

#### `VariantResult`

```typescript
interface VariantResult {
  variantIndex: number;
  artifactId?: string;
  costUsd: number;
  judgeScore?: number;
  judgeRationale?: string;
  winner: boolean;
  rejected?: "safety" | "judge-low" | "gate-fail" | "generation-error";
  generationError?: { code: string; message: string };
}
```

### `BatchExecutor` (F15)

Processes pipelines across multiple input rows with concurrent workers.

```typescript
class BatchExecutor {
  setRowExecutor(fn: (pipeline: unknown, row: Record<string, unknown>, batchId: string) => Promise<RowExecutorResult>): void;
  setReportPersister(fn: (batchId: string, rows: BatchReportRow[]) => Promise<string>): void;
  start(request: BatchRequest): Promise<{ batchId: string; status: string }>;
  getStatus(batchId: string): Promise<BatchStatus | null>;
  cancel(batchId: string): Promise<boolean>;
  retry(request: BatchRetryRequest): Promise<{ batchId: string; status: string }>;
}
```

#### `BatchRequest`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `pipeline` | `unknown` | **required** | Pipeline template with `{{column}}` placeholders |
| `source` | `BatchSource` | **required** | CSV, JSONL, or inline row data |
| `concurrency` | `number` | `5` | Max concurrent worker count |
| `onRowFailure` | `"continue" \| "stop" \| "retry-once"` | `"continue"` | Behavior on row failure |
| `perRunBudget` | `{ maxUsd: number; onExceed: "abort" \| "suspend" }` | — | Budget cap per row |
| `artifactTags` | `string[]` | — | Tags applied to generated artifacts |
| `idempotencyKey` | `string` | — | Deduplication key |

#### `BatchSource`

```typescript
type BatchSource =
  | { type: "csv"; uri?: string; columnMap?: Record<string, string>; delimiter?: "," | ";" | "\t"; hasHeader?: boolean; rows?: string }
  | { type: "jsonl"; uri?: string; rows?: string }
  | { type: "inline"; rows: Record<string, unknown>[] };
```

#### `BatchStatus`

```typescript
interface BatchStatus {
  batchId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "partial";
  totalRows: number;
  completed: number;
  failed: number;
  inFlight: number;
  costUsd: number;
  startedAt: string;
  completedAt?: string;
  reportArtifactId?: string;
}
```

### `RatioFanOutExecutor` (F11)

Fan out an image generation across multiple aspect ratios, deriving non-native ratios via smart-crop or pad.

```typescript
class RatioFanOutExecutor {
  executeFanOut(operation: string, inputs: Record<string, unknown>, config: RatioFanOutConfig, providerContext: ProviderContext): Promise<RatioFanOutOutput>;

  // Utility: find the closest matching native ratio from an available set
  findBestNativeRatio(target: AspectRatio, available: AspectRatio[]): string | undefined;
}
```

#### `RatioFanOutConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `ratios` | `AspectRatio[]` | **required** | Target aspect ratios |
| `fallback` | `"smart-crop" \| "fail" \| "pad"` | `"smart-crop"` | Behavior for non-native ratios |
| `reuseLargest` | `boolean` | `false` | Derive all outputs from the single largest native render |
| `faceAware` | `boolean` | `false` | Use attention-based smart-crop for face-aware framing |
| `padColor` | `string` | `"#000000"` | Background hex color for pad fallback |

#### Supported Aspect Ratios

`1:1`, `4:5`, `9:16`, `16:9`, `3:2`, `2:3`, `21:9`, plus any custom `W:H` (max 32×32).

### `ContextResolver` (F13)

Resolves `$ref` values in step inputs against a `RunContext` with voice, style, and brand definitions.

```typescript
class ContextResolver {
  resolve(context: RunContext, ref: ContextRef, provider: string): unknown;
  resolveInputs(inputs: Record<string, unknown>, context: RunContext, provider: string, operation?: string): Record<string, unknown>;
}
```

Input keys with expected ref kinds:
- `voice` → expects a `{ "$ref": { kind: "voice", name: "..." } }` (used in `audio.tts`)
- `style` / `negative_style` → expects a `{ "$ref": { kind: "style", name: "..." } }` (used in `image.generate`)
- `brand.<key>` → resolved inline from brand kit

### `LoudnessGateEvaluator` (F14)

Measures and normalizes audio loudness using ffmpeg's `loudnorm` filter (EBU R128).

```typescript
class LoudnessGateEvaluator {
  evaluate(artifactPath: string, gate: LoudnessGate): Promise<LoudnessVerdict>;
}
```

#### `LoudnessGate`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"loudness"` | **required** | Gate discriminator |
| `preset` | `LoudnessPreset` | `"youtube"` | Predefined target loudness |
| `target` | `LoudnessTarget` | — | Custom target (overrides preset) |
| `toleranceLu` | `number` | `1.0` | Allowed LU tolerance |
| `action` | `"normalize" \| "warn" \| "fail"` | **required** | Action on out-of-tolerance |
| `inPlace` | `boolean` | `false` | Replace original artifact with normalized version |

#### Presets (`LOUDNESS_PRESETS`)

| Preset | Integrated LUFS | LRA | True Peak |
|--------|-----------------|-----|-----------|
| `youtube` | -14 | 11 | -1.0 dB |
| `spotify` | -14 | 11 | -1.0 dB |
| `podcast` | -16 | 10 | -1.0 dB |
| `broadcast-ebu` | -23 | 10 | -1.0 dB |
| `broadcast-atsc` | -24 | 10 | -2.0 dB |

### `SafetyGateEvaluator` (F16)

Content safety classification with pluggable backends and unconditional CSAM blocking.

```typescript
class SafetyGateEvaluator {
  constructor(config?: SafetyGateEvaluatorConfig);
  registerClassifier(provider: string, classifier: SafetyClassifier): void;
  evaluate(artifact: SafetyArtifact, gate: SafetyGate): Promise<SafetyVerdict>;
}
```

#### Safety Classifiers

**`OpenAIModerationClassifier`** — Uses OpenAI's `omni-moderation-latest` endpoint. Accepts text and image URLs. Free (as of 2025).

```typescript
new OpenAIModerationClassifier({ apiKey: "sk-..." });
```

**`ReplicateNsfwClassifier`** — Uses `falcons-ai/nsfw_image_detection` on Replicate. Polls prediction until completion. Approx $0.0003 per call.

```typescript
new ReplicateNsfwClassifier({ apiKey: "r8-..." });
```

#### `SafetyVerdict`

```typescript
interface SafetyVerdict {
  blocked: boolean;
  category?: SafetyCategory;
  score?: number;
  perCategoryScores: Partial<Record<SafetyCategory, number>>;
  provider: string;
  model: string;
  action: "fail" | "warn" | "redact";
  costUsd: number;
  redactedArtifactId?: string;
}
```

#### Safety Categories

`sexual`, `sexual/minors`, `hate`, `harassment`, `self-harm`, `violence`, `graphic-violence`, `illegal`, `pii`, `misinformation`, `csam` (always blocked unconditionally).

## Usage Patterns

### Variants Execution

```typescript
const variantsExecutor = new VariantsExecutor();
const result = await variantsExecutor.executeVariants(
  step,
  {
    n: 4,
    seedStrategy: "sequential",
    judge: { type: "llm-judge", criteria: "Which image looks most professional?" },
    minScore: 0.7,
    loserAction: "archive",
  },
  {
    executeOperation: async (op, inputs, config) => ({
      artifact: { id: "art-1", type: "image", uri: "...", mimeType: "image/png", metadata: {} },
      costUsd: 0.007,
    }),
    llmJudgeFn: async (criteria, artifact, rubric) => ({
      score: 0.85,
      rationale: "Clean composition and lighting",
    }),
  },
);
console.log(result.winner?.judgeScore); // 0.85
console.log(result.losers.length);      // 3
```

### Batch Execution with CSV

```typescript
const batch = new BatchExecutor();
batch.setRowExecutor(async (pipeline, row, batchId) => ({
  artifactIds: ["art-1"],
  costUsd: 0.01,
}));

const { batchId } = await batch.start({
  pipeline: {
    id: "batch-product",
    steps: [{
      id: "step1",
      operation: "image.generate",
      inputs: { prompt: "{{headline}} product" },
      config: {},
    }],
  },
  source: {
    type: "csv",
    rows: "headline,pricing\nNew Arrival,$99\nLimited Edition,$149",
    columnMap: { headline: "headline" },
  },
  concurrency: 3,
  onRowFailure: "retry-once",
});

// Poll status
let status = await batch.getStatus(batchId);
while (status?.status === "running" || status?.status === "pending") {
  await sleep(1000);
  status = await batch.getStatus(batchId);
}
console.log(status); // { status: "completed", completed: 2, failed: 0, costUsd: 0.02 }
```

### Ratio Fan-Out

```typescript
const ratioExecutor = createRatioFanOutExecutor();
const output = await ratioExecutor.executeFanOut(
  "image.generate",
  { prompt: "A modern logo", dimensions: "1024x1024" },
  {
    ratios: ["1:1", "16:9", "4:5"],
    fallback: "smart-crop",
    faceAware: true,
  },
  {
    provider: myImageProvider,
    storage: storageBackend,
    operation: "image.generate",
  },
);

for (const variant of output.variants) {
  console.log(variant.ratio, variant.source, variant.width, variant.height);
}
```

### Loudness Normalization

```typescript
const loudnessGate = createLoudnessGateEvaluator();
const verdict = await loudnessGate.evaluate(
  "/path/to/audio.wav",
  {
    type: "loudness",
    preset: "podcast",
    toleranceLu: 0.5,
    action: "normalize",
    inPlace: true,
  },
);

console.log(verdict.status);     // "out-of-tolerance" → normalize applied
console.log(verdict.measured);   // { iLufs: -18.5, lra: 8, tpDb: -0.5 }
console.log(verdict.target);     // { iLufs: -16, lra: 10, tpDb: -1.0 }
```

### Safety Screening

```typescript
const safetyGate = new SafetyGateEvaluator();
safetyGate.registerClassifier("openai", new OpenAIModerationClassifier({ apiKey: "sk-..." }));

const verdict = await safetyGate.evaluate(
  { id: "art-123", type: "text", text: "User-generated caption" },
  {
    type: "safety",
    provider: "openai",
    block: ["sexual", "hate", "violence"],
    action: "fail",
  },
);

if (verdict.blocked) {
  console.error(`Blocked: ${verdict.category} (score: ${verdict.score})`);
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and execution engine
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider base class and router
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence for variant/ratio outputs

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
