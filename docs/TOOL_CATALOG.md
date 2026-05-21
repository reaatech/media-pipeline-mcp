# Tool Catalog — media-pipeline-mcp

Complete reference of all MCP tools exposed by the media-pipeline-mcp server.
Covers Phase 1 + Phase 2 (batch, provenance, multi-tenant, streaming, mesh, subtitle).

---

## Pipeline Tools

### `media.pipeline.define`

Validates and previews a pipeline definition without executing it. Runs structural validation, checks variable interpolation references, and looks up operation-to-provider routing.

**Alias:** `pipeline.define`

**Input:**
```typescript
{
  pipeline: {
    id: string;
    steps: PipelineStep[];  // { id, operation, inputs, config?, qualityGate? }
  }
}
```

**Output:**
```typescript
{
  valid: boolean;
  estimated_cost_usd: number;
  estimated_duration_ms: number;
  errors?: string[];
  warnings?: string[];
}
```

**Cost:** Free (validation only)

---

### `media.pipeline.run`

Executes a pipeline definition. Returns output artifacts, step results, cost, and duration. Supports progress streaming when a `progressToken` is provided.

**Alias:** `pipeline.execute`

**Input:**
```typescript
{
  pipeline: PipelineDefinition | string; // inline or template ID
  progressToken?: string; // MCP streaming token for step-level progress
}
```

**Output:**
```typescript
{
  pipeline_id: string;
  status: 'completed' | 'failed' | 'gated';
  artifacts: Artifact[];
  cost_usd: number;
  duration_ms: number;
  stepResults: StepResult[];
}
```

**Cost:** Sum of all step costs + quality gate evaluation costs

---

### `media.pipeline.status`

Checks the status of a running or completed pipeline by ID.

**Alias:** `pipeline.status`

**Input:**
```typescript
{
  pipeline_id: string;
}
```

**Output:**
```typescript
{
  pipeline_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'gated';
  currentStep?: string;
  completedSteps: string[];
  artifacts: Artifact[];
}
```

---

### `media.pipeline.resume`

Resumes a pipeline that was paused by a quality gate or failed at a retryable step.

**Alias:** `pipeline.resume`

**Input:**
```typescript
{
  pipeline_id: string;
  action: 'retry' | 'skip' | 'abort';
  modifiedParams?: Record<string, unknown>;
}
```

**Output:**
```typescript
{
  pipeline_id: string;
  status: 'running' | 'aborted';
  message: string;
}
```

---

### `media.pipeline.cancel`

Immediately cancels a running pipeline. In-flight provider requests are aborted when supported. Already-completed steps remain in storage.

**Alias:** `pipeline.cancel`

**Input:**
```typescript
{
  pipeline_id: string;
  reason?: string; // Optional cancellation reason for audit log
}
```

**Output:**
```typescript
{
  pipeline_id: string;
  status: 'cancelled';
  cancelledAt: string; // ISO 8601 timestamp
}
```

---

### `media.pipeline.estimate`

Dry-run cost and duration estimation without executing any provider operations. Useful for budget checking before committing to a run.

**Alias:** `pipeline.estimate`

**Input:**
```typescript
{
  pipeline: {
    id: string;
    steps: {
      id: string;
      operation: string;
      config?: Record<string, unknown>;
    }[];
  };
}
```

**Output:**
```typescript
{
  pipeline_id: string;
  estimated_cost_usd: number;
  estimated_duration_ms: number;
  breakdown: {
    stepId: string;
    operation: string;
    provider: string;
    estimatedCost: number;
    estimatedDurationMs: number;
  }[];
}
```

---

### `media.pipeline.subscribe`

Subscribes to real-time events from a pipeline execution via a webhook URL. Events are sent as JSON POST requests.

**Alias:** `pipeline.subscribe`

**Input:**
```typescript
{
  pipeline_id: string;
  url: string;                  // Webhook callback URL
  events: string[];             // Event types, e.g. ["step:complete", "pipeline:complete"]
  secret?: string;              // HMAC secret for request signing
}
```

**Events:**
| Event | Payload |
|-------|---------|
| `step:start` | `{ pipeline_id, step_id, operation, timestamp }` |
| `step:complete` | `{ pipeline_id, step_id, operation, duration_ms, cost_usd, artifact_id }` |
| `step:failed` | `{ pipeline_id, step_id, operation, error }` |
| `step:gated` | `{ pipeline_id, step_id, gate_type, score }` |
| `pipeline:complete` | `{ pipeline_id, status, artifacts[], total_cost_usd, duration_ms }` |
| `pipeline:failed` | `{ pipeline_id, failed_step, error }` |
| `batch:row:complete` | `{ batch_id, row_index, pipeline_id, status, cost_usd }` |

**Output:**
```typescript
{
  subscription_id: string;
  pipeline_id: string;
  status: 'active';
}
```

---

### `media.pipeline.templates`

Lists all available pre-built pipeline templates.

**Input:** `{}`

**Output:**
```typescript
{
  templates: {
    id: string;
    name: string;
    description: string;
  }[];
}
```

---

### `media.pipeline.batch`

Executes multiple pipeline runs from a CSV, JSONL, or inline data source. Supports variable interpolation (`{{row.field}}`) in pipeline definitions. Each row becomes one pipeline execution with its own artifact output and cost tracking.

**Alias:** `pipeline.batch`

**Input:**
```typescript
{
  pipeline: {
    id: string;
    steps: PipelineStep[];  // May contain {{row.field}} references
  };
  source: {
    type: 'csv' | 'jsonl' | 'inline';
    uri?: string;           // File URI for csv/jsonl sources
    rows?: Record<string, string>[];  // Inline row data
    columnMap?: Record<string, string>; // Column name remapping
  };
  concurrency?: number;     // Max concurrent runs (default: 1)
  onRowFailure?: 'continue' | 'stop' | 'retry-once'; // (default: continue)
  perRunBudget?: {
    maxUsd: number;
    onExceed: 'abort' | 'suspend';
  };
  artifactTags?: string[];
  idempotencyKey?: string;
}
```

**Output:**
```typescript
{
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  totalRows: number;
  estimatedCostMaxUsd?: number;
}
```

---

### `media.pipeline.batch.status`

Checks the progress and results of a batch execution.

**Alias:** `pipeline.batch.status`

**Input:**
```typescript
{
  batchId: string;
}
```

**Output:**
```typescript
{
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  totalRows: number;
  completedRows: number;
  failedRows: number;
  totalCostUsd: number;
  rows: {
    index: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
    pipelineId?: string;
    artifacts?: ArtifactMeta[];
    costUsd?: number;
    error?: string;
  }[];
  reportArtifactId?: string; // JSONL report artifact when completed
}
```

---

### `media.pipeline.batch.retry`

Retries failed rows in a batch. Can target all failed rows or specific row indexes.

**Alias:** `pipeline.batch.retry`

**Input:**
```typescript
{
  batchId: string;
  onlyFailed?: boolean;       // Retry only failed rows (default: true)
  onlyRowIndexes?: number[];  // Retry specific rows by index
}
```

**Output:**
```typescript
{
  batchId: string;
  retriedRows: number;
  status: 'running' | 'completed' | 'partial' | 'failed';
}
```

---

### `media.pipeline.batch.cancel`

Cancels a running batch execution. In-flight runs are aborted when possible. Already-completed row results are preserved.

**Alias:** `pipeline.batch.cancel`

**Input:**
```typescript
{
  batchId: string;
}
```

**Output:**
```typescript
{
  batchId: string;
  status: 'cancelled';
  cancelledAt: string;
}
```

---

## Artifact Tools

### `media.artifact.get`

Retrieves an artifact by ID. Returns binary data for local storage or a signed URL for remote storage.

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:** Artifact data (binary or signed URL) with metadata.

---

### `media.artifact.list`

Lists artifacts with optional prefix filtering.

**Input:**
```typescript
{
  prefix?: string;  // Optional artifact ID prefix filter
  limit?: number;   // Max results to return
}
```

**Output:**
```typescript
{
  artifacts: {
    id: string;
    type: 'image' | 'audio' | 'video' | 'document' | 'mesh' | 'text';
    size: number;
    createdAt: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }[];
  total: number;
}
```

---

### `media.artifact.delete`

Deletes an artifact by ID from all storage backends.

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:**
```typescript
{
  success: boolean;
  deleted: boolean;
}
```

---

## Provider Tools

### `media.providers.list`

Lists all configured providers, their supported operations, and current health status.

**Input:** `{}`

**Output:**
```typescript
{
  providers: {
    name: string;
    healthy: boolean;
    operations: string[];   // e.g. ["image.generate", "audio.tts"]
    latency_ms?: number;    // Last health check latency
    lastChecked?: string;   // ISO 8601 timestamp
  }[];
}
```

---

### `media.providers.health`

Checks health of a specific provider by performing a lightweight API call.

**Input:**
```typescript
{
  provider_id: string;
}
```

**Output:**
```typescript
{
  provider_id: string;
  healthy: boolean;
  latency_ms: number;
  lastChecked: string;
  error?: string;
}
```

---

## Cost Tools

### `media.costs.summary`

Returns aggregated cost data for all operations performed during the current session or billing period.

**Input:** `{}`

**Output:**
```typescript
{
  total_usd: number;
  by_operation: Record<string, number>;
  by_provider: Record<string, number>;
  by_pipeline?: Record<string, number>;
  budget_remaining?: {
    daily: number | null;
    monthly: number | null;
    per_pipeline: number | null;
  };
}
```

---

## Image Operations

### `image.generate`

Generates an image from a text prompt.

**Providers:** Stability AI (SD3, SDXL), OpenAI (DALL-E 3), Replicate (Flux), fal.ai (Flux)

**Cost Range:** $0.002 - $0.08 per image

**Input:**
```typescript
{
  prompt: string;
  negative_prompt?: string;
  dimensions?: string;       // e.g. "1024x1024"
  aspect_ratio?: string;     // e.g. "1:1", "16:9", "3:2" (F11)
  model?: string;            // e.g. "sd3", "dall-e-3", "flux"
  style_preset?: string;
  seed?: number;
  num_outputs?: number;      // 1-10 (F9 variants)
  route?: string;            // Provider routing hint (F8)
  cache_ttl?: number;        // Cache result for N seconds (F2)
}
```

**Output:** Image artifact(s)

**Pipeline-specific config (F8, F9, F11):**
- `variants` — generate N variations in parallel within a single step (overrides `num_outputs`)
- `aspect_ratios` — array of ratios; generates one output per ratio in a fan-out pattern
- `route` — force a specific provider (e.g. `"stability-ai/sd3"`, `"fal-ai/flux"`)
- `cache` — set `{ enabled: true, ttl: 3600 }` to reuse cached results for identical prompts

---

### `image.generate.batch`

Generates multiple images from an array of prompt variations.

**Input:**
```typescript
{
  prompts: string[];
  negative_prompt?: string;
  dimensions?: string;
  aspect_ratio?: string;
  style_preset?: string;
  num_variations?: number;  // Variations per prompt (1-5)
}
```

**Output:** Array of image artifacts with prompt-index tracking

---

### `image.image_to_image`

Transforms an existing image based on a text prompt (img2img).

**Providers:** Stability AI, OpenAI, Replicate

**Cost Range:** $0.002 - $0.08 per image

**Input:**
```typescript
{
  artifact_id: string;
  prompt: string;
  negative_prompt?: string;
  strength?: number;         // 0.0 - 1.0 (how much to transform)
  dimensions?: string;
  seed?: number;
}
```

**Output:** Transformed image artifact

---

### `image.upscale`

Upscales an image to a higher resolution.

**Providers:** Replicate (Real-ESRGAN), fal.ai, Stability AI

**Cost Range:** $0.005 - $0.02 per image

**Input:**
```typescript
{
  artifact_id: string;
  scale?: '2x' | '4x' | '8x';
  model?: string;
}
```

**Output:** Upscaled image artifact

---

### `image.remove_background`

Removes the background from an image, leaving transparency.

**Providers:** Replicate (RMBG, BiRefNet), fal.ai

**Cost Range:** $0.003 - $0.01 per image

**Input:**
```typescript
{
  artifact_id: string;
  output_format?: 'png' | 'webp';
}
```

**Output:** Image artifact with transparent background

---

### `image.inpaint`

Inpaints or edits a region of an image based on a mask and text prompt.

**Providers:** Stability AI (SD3), Replicate, fal.ai

**Cost Range:** $0.005 - $0.02 per image

**Input:**
```typescript
{
  artifact_id: string;
  mask_artifact_id?: string;  // Optional mask; if omitted, entire image is regenerated
  prompt: string;
  negative_prompt?: string;
}
```

**Output:** Inpainted image artifact

---

### `image.describe`

Generates a text description of an image using vision-language models.

**Providers:** OpenAI (GPT-4o), Anthropic (Claude), Google (Gemini)

**Cost Range:** $0.003 - $0.01 per image

**Input:**
```typescript
{
  artifact_id: string;
  detail_level?: 'brief' | 'detailed' | 'structured';
  model?: string;
}
```

**Output:** Text artifact with description

---

### `image.resize`

Resizes an image to target dimensions. Supports fit modes.

**Type:** Local operation (sharp)

**Cost:** $0.00

**Input:**
```typescript
{
  artifact_id: string;
  dimensions: string;          // e.g. "1080x1080"
  fit?: 'cover' | 'contain' | 'fill';
}
```

**Output:** Resized image artifact

---

### `image.crop`

Crops an image to a specific region by coordinates.

**Type:** Local operation (sharp)

**Cost:** $0.00

**Input:**
```typescript
{
  artifact_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
```

**Output:** Cropped image artifact

---

### `image.composite`

Composites an overlay image onto a base image with configurable position, opacity, and blend mode.

**Type:** Local operation (sharp)

**Cost:** $0.00

**Input:**
```typescript
{
  base_artifact_id: string;
  overlay_artifact_id: string;
  position?: string;             // e.g. "center", "top-left", "bottom-right"
  blend_mode?: 'normal' | 'multiply' | 'screen' | 'overlay' | 'source-over';
  opacity?: number;              // 0.0 - 1.0 (default: 1)
}
```

**Output:** Composited image artifact

---

## Audio Operations

### `audio.tts`

Converts text to speech using TTS providers.

**Providers:** ElevenLabs, OpenAI TTS, Deepgram Aura

**Cost Range:** $0.005 - $0.03 per minute

**Input:**
```typescript
{
  text: string;
  voice?: string;
  speed?: number;          // 0.5 - 2.0
  output_format?: 'mp3' | 'wav' | 'opus';
  model?: string;
}
```

**Output:** Audio artifact

---

### `audio.stt`

Transcribes audio to text with optional speaker diarization and timestamps.

**Providers:** Deepgram (Nova-2), OpenAI Whisper

**Cost Range:** $0.005 - $0.02 per minute

**Input:**
```typescript
{
  artifact_id: string;
  language?: string;        // e.g. "en", "es", "fr"
  diarize?: boolean;        // Enable speaker identification
}
```

**Output:** Text artifact with segments, timestamps, and per-word confidence

---

### `audio.diarize`

Identifies and labels speakers in audio.

**Providers:** Deepgram (diarization), Replicate (pyannote)

**Cost Range:** $0.01 - $0.03 per minute

**Input:**
```typescript
{
  artifact_id: string;
  num_speakers?: number;    // Expected number of speakers
}
```

**Output:** Text artifact with speaker-labeled segments

---

### `audio.isolate`

Isolates specific audio stems (vocals, instruments, drums, bass).

**Providers:** Replicate (Demucs)

**Cost Range:** $0.01 - $0.02 per track

**Input:**
```typescript
{
  artifact_id: string;
  target?: 'vocals' | 'instruments' | 'drums' | 'bass';
}
```

**Output:** Audio artifact — separated stem

---

### `audio.music`

Generates original music from a text description.

**Providers:** Replicate (MusicGen, AudioCraft), fal.ai

**Cost Range:** $0.01 - $0.05 per generation

**Input:**
```typescript
{
  prompt: string;                // e.g. "upbeat electronic with bass"
  duration?: number;             // Seconds (default: 30)
  instrumental?: boolean;        // No vocals (default: true)
  style?: string;                // e.g. "pop", "rock", "classical", "jazz"
  tempo?: number;                // BPM
  format?: 'mp3' | 'wav' | 'ogg';
}
```

**Output:** Audio artifact (music track)

---

### `audio.sound_effect`

Generates a sound effect from a text description.

**Providers:** Replicate, fal.ai

**Cost Range:** $0.005 - $0.02 per generation

**Input:**
```typescript
{
  prompt: string;                // e.g. "door creaking opening"
  duration?: number;             // Seconds (default: 5)
  format?: 'mp3' | 'wav' | 'ogg';
}
```

**Output:** Audio artifact (sound effect)

---

### `audio.transcribeStream`

Real-time streaming speech-to-text transcription. Accepts inline audio data (base64-encoded), a URL to an audio file, or configuration for microphone capture.

**Providers:** Deepgram (Nova-2), OpenAI Whisper, Google STT

**Cost Range:** $0.005 - $0.02 per minute (streaming); free for inline samples under 30s

**Input:**
```typescript
{
  source: {
    kind: 'inline' | 'url' | 'mic' | 'inline-sample';
    encoding?: 'linear16' | 'opus' | 'mulaw';  // For inline modes
    sampleRateHz?: number;
    data?: string;            // Base64-encoded audio (preferred inline mode)
    audioData?: string;       // Legacy alias for inline-sample mode
    url?: string;             // For url mode
  };
  language?: string;           // e.g. "en-US"
  model?: string;              // STT model override
  provider?: 'deepgram' | 'openai' | 'google';
  interim?: boolean;           // Return interim (partial) results
  diarize?: boolean;           // Enable speaker diarization
  endpointingMs?: number;      // Endpointing sensitivity in ms
}
```

**Output:**
```typescript
{
  text: string;
  isFinal: boolean;
  segments?: {
    text: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: string;
  }[];
  duration_ms: number;
}
```

---

## Video Operations

### `video.generate`

Generates a video from a text prompt.

**Providers:** Replicate (Kling, LTX-Video, Wan), fal.ai

**Cost Range:** $0.05 - $0.20 per second of output

**Input:**
```typescript
{
  prompt: string;
  duration?: number;         // Seconds (default: 5)
  aspect_ratio?: string;     // e.g. "16:9", "9:16", "1:1"
  style?: string;
  model?: string;
}
```

**Output:** Video artifact

---

### `video.image_to_video`

Animates an image into a video with optional motion description.

**Providers:** Replicate (Kling i2v, Stable Video Diffusion), fal.ai

**Cost Range:** $0.05 - $0.15 per second

**Input:**
```typescript
{
  artifact_id: string;       // Source image
  motion_prompt?: string;    // Description of desired motion
  duration?: number;         // Seconds (default: 5)
  model?: string;
}
```

**Output:** Video artifact

---

### `video.extract_frames`

Extracts frames from a video at specified intervals or timestamps.

**Type:** Local operation (ffmpeg)

**Cost:** $0.00

**Input:**
```typescript
{
  artifact_id: string;
  interval?: number;         // Extract every Nth frame
  timestamps?: number[];     // Specific timestamps in seconds
}
```

**Output:** Array of image artifacts

---

### `video.extract_audio`

Extracts the audio track from a video file.

**Type:** Local operation (ffmpeg)

**Cost:** $0.00

**Input:**
```typescript
{
  artifact_id: string;
  format?: 'mp3' | 'wav' | 'aac';
}
```

**Output:** Audio artifact

---

### `video.subtitle`

Full subtitle pipeline: transcribes video audio via STT, generates subtitle files in SRT / VTT / ASS format, and optionally burns subtitles directly into the video.

**Providers:** STT backends (Deepgram, OpenAI Whisper) for transcription; ffmpeg for burn-in

**Cost Range:** $0.005 - $0.02 per minute (STT portion); $0.00 for subtitle assembly / burn-in

**Input:**
```typescript
{
  artifactId: string;            // Video artifact ID
  language?: string;             // Language code (default: "en")
  format?: 'srt' | 'vtt' | 'ass';  // Subtitle format (default: "srt")
  sttProvider?: string;          // STT provider override
  sttModel?: string;             // STT model override
  burnIn?: {                     // Optional: burn subtitles into video
    font?: string;
    fontSize?: number;
    fontColor?: string;          // Hex color
    position?: 'top' | 'middle' | 'bottom';
  };
  diarize?: boolean;             // Enable speaker identification
  translateTo?: string;          // Target language for translation
}
```

**Output:**
```typescript
{
  subtitle_artifact_id: string;  // Subtitle file (SRT/VTT/ASS)
  format: string;
  segments: number;
  duration_ms: number;
  burnedVideo_artifact_id?: string; // Present only if burnIn was specified
}
```

---

## Mesh Operations

### `mesh.generate`

Generates a 3D mesh model from a text prompt or reference image.

**Providers:** Replicate, fal.ai

**Cost Range:** $0.05 - $0.30 per mesh

**Input:**
```typescript
{
  prompt: string;                  // Text description of the 3D model
  sourceArtifactId?: string;       // Reference image for image-to-3d
  format?: 'glb' | 'fbx' | 'obj' | 'usdz' | 'ply';  // (default: glb)
  polyBudget?: number;             // Target polygon count
  topology?: 'quads' | 'tris';    // Mesh topology
  texture?: {
    enabled?: boolean;             // Generate textures (default: true)
    pbr?: boolean;                 // PBR materials (default: true)
    resolution?: number;           // Texture resolution (default: 2048)
  };
}
```

**Output:**
```typescript
{
  artifact_id: string;
  format: string;
  polyCount: number;
  hasTexture: boolean;
  size: number;
}
```

---

## Document Operations

### `document.ocr`

Extracts text from images or PDFs using OCR.

**Providers:** Google Document AI, Anthropic Claude (vision), OpenAI GPT-4o (vision)

**Cost Range:** $0.005 - $0.02 per page

**Input:**
```typescript
{
  artifact_id: string;
  output_format?: 'plain_text' | 'structured_json' | 'markdown';
  model?: string;
}
```

**Output:** Text artifact

---

### `document.extract_tables`

Extracts tables from images or PDFs.

**Providers:** Google Document AI, Anthropic Claude (vision), OpenAI GPT-4o (vision)

**Cost Range:** $0.01 - $0.03 per page

**Input:**
```typescript
{
  artifact_id: string;
  output_format?: 'markdown' | 'json';
}
```

**Output:** Text artifact (markdown tables or JSON arrays)

---

### `document.extract_fields`

Extracts structured fields from documents based on a schema definition.

**Providers:** Anthropic Claude (vision), OpenAI GPT-4o (vision)

**Cost Range:** $0.01 - $0.03 per page

**Input:**
```typescript
{
  artifact_id: string;
  field_schema: Record<string, string>;  // e.g. { "invoice_number": "string", "total": "number" }
  model?: string;
}
```

**Output:** Text artifact (JSON matching the schema)

---

### `document.summarize`

Summarizes document content at configurable length and style.

**Providers:** OpenAI GPT-4, Anthropic Claude, Google Gemini

**Cost Range:** $0.005 - $0.02 per page

**Input:**
```typescript
{
  artifact_id: string;
  length?: 'short' | 'medium' | 'long' | 'detailed';
  style?: string;              // e.g. "neutral", "bullet-points", "executive"
}
```

**Output:** Text artifact (summary)

---

## Quality Gate Tools

### `quality_gate.evaluate`

Evaluates an artifact against a quality gate configuration outside of a pipeline. Supports all gate types: threshold, dimension-check, llm-judge, and custom.

**Input:**
```typescript
{
  artifact_id: string;
  gate: {
    type: 'threshold' | 'dimension-check' | 'llm-judge' | 'custom';
    config: Record<string, unknown>;  // Gate-specific configuration
    action?: 'fail' | 'retry' | 'warn';  // (default: fail)
    maxRetries?: number;
  };
}
```

**Output:**
```typescript
{
  passed: boolean;
  score?: number;              // 0.0 - 1.0 (for llm-judge)
  details: {
    checkName: string;
    passed: boolean;
    actual: unknown;
    expected: unknown;
    message?: string;
  }[];
  evaluation_cost_usd?: number;
}
```

**Gate Types and Config:**
- `threshold` — `{ checks: [{ field: "metadata.width", operator: ">=", value: 1024 }] }`
- `dimension-check` — `{ expectedWidth: 1024, expectedHeight: 1024, tolerance: 0.05 }`
- `llm-judge` — `{ prompt: "...", model: "gpt-4o-mini", timeout: 30000 }`
- `custom` — `{ customCheckFn: "async (artifact, ctx) => { return { pass: true }; }" }`

---

## Pipeline Templates

### `product-photo`
generate → upscale → remove_background → composite

### `social-media-kit`
generate → resize (1:1) → resize (4:5) → resize (16:9)

### `podcast-clip`
audio.stt → audio.diarize → audio.isolate → audio.tts (voiceover)

### `document-intake`
document.ocr → document.extract_fields → quality_gate.evaluate → document.summarize

### `video-thumbnail`
video.extract_frames → image.describe → quality_gate.evaluate → image.upscale

---

## Notes

### Phase 2 Additions

- **Batch (F15):** `media.pipeline.batch` / `.status` / `.retry` / `.cancel` — process hundreds of rows from CSV/JSONL with per-run budgets, concurrency control, and JSONL report output.
- **Provenance (F18):** All pipeline artifacts can be cryptographically signed via the ProvenanceSigner. Signatures include pipeline ID, step ID, timestamp, and parent artifact references. Enables supply-chain audit for regulated environments.
- **Multi-tenant (F18):** Key Vault integration for tenant-scoped API key resolution. Each tenant's provider keys are isolated. The `X-Tenant-ID` header routes requests to the correct key store.
- **Streaming STT (F20):** `audio.transcribeStream` supports real-time transcription via WebSocket-compatible flow. Accepts inline base64, URL, or mic source configurations. Supports interim results and diarization.
- **Mesh (F21):** `mesh.generate` creates 3D models (GLB/FBX/OBJ/USDZ/PLY) from text or image prompts. Supports PBR texturing, topology control, and poly budgets.
- **Subtitle (F12):** `video.subtitle` runs a full subtitle pipeline: STT transcription → SRT/VTT/ASS generation → optional burn-in with font/color/position control.

### General

- All costs are approximate and vary by provider pricing.
- Local operations (resize, crop, composite, extract_frames, extract_audio) have no provider cost.
- Quality gates add additional LLM call costs when using `llm-judge` type.
- Pipeline execution cost = sum of all step costs + quality gate costs.
- Provider routing is automatic; use the `route` config field to pin a specific provider.
- All tool names are also advertised under `pipeline.*` aliases per MCP spec §0.4 compatibility.
- `image.generate` supports per-step config for variants (`variants`), aspect ratio fan-out (`aspect_ratios`), provider pinning (`route`), and result caching (`cache`).
- Rate limiting, budget enforcement, and authentication (JWT / API key) are configured via environment variables.
