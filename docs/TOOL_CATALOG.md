# Tool Catalog — media-pipeline-mcp

Complete reference of all MCP tools exposed by the media-pipeline-mcp server.

---

## Pipeline Tools

### `media.pipeline.define`

Validates and previews a pipeline definition without executing it.

**Input:**
```typescript
{
  pipeline: {
    id: string;
    steps: PipelineStep[];
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

---

### `media.pipeline.run`

Executes a pipeline definition and returns all output artifacts.

**Input:**
```typescript
{
  pipeline: PipelineDefinition | string; // inline or template ID
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

---

### `media.pipeline.status`

Checks the status of a running or completed pipeline.

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

Resumes a gated or failed pipeline with a specified action.

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

### `media.pipeline.templates`

Lists available pre-built pipeline templates.

**Input:** `{}`

**Output:**
```typescript
{
  templates: {
    id: string;
    name: string;
    description: string;
    steps: PipelineStep[];
  }[]
}
```

---

## Artifact Tools

### `media.artifact.get`

Retrieves an artifact by ID.

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:** Artifact data (binary or signed URL)

---

### `media.artifact.list`

Lists artifacts with optional filtering.

**Input:**
```typescript
{
  prefix?: string;
  limit?: number;
}
```

**Output:**
```typescript
{
  artifacts: ArtifactMeta[];
  total: number;
}
```

---

### `media.artifact.delete`

Deletes an artifact.

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:** `{ success: boolean }`

---

## Provider Tools

### `media.providers.list`

Lists all configured providers and their health status.

**Input:** `{}`

**Output:**
```typescript
{
  providers: {
    name: string;
    healthy: boolean;
    operations: string[];
    latency_ms?: number;
  }[]
}
```

---

### `media.providers.health`

Checks health of a specific provider.

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
}
```

---

## Cost Tools

### `media.costs.summary`

Gets running cost totals.

**Input:** `{}`

**Output:**
```typescript
{
  total_usd: number;
  by_operation: Record<string, number>;
  by_provider: Record<string, number>;
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
  dimensions?: string; // e.g. "1024x1024"
  model?: string; // e.g. "sd3", "dall-e-3"
  style_preset?: string;
  seed?: number;
  num_outputs?: number; // 1-4
}
```

**Output:** Image artifact(s)

---

### `image.generate.batch`

Generates multiple images from prompt variations.

**Input:**
```typescript
{
  prompts: string[];
  negative_prompt?: string;
  dimensions?: string;
  aspect_ratio?: string;
  style_preset?: string;
  num_variations?: number;
}
```

**Output:** Array of image artifacts

---

### `image.image_to_image`

Transforms an existing image based on a text prompt.

**Providers:** Stability AI, OpenAI

**Cost Range:** $0.002 - $0.08 per image

**Input:**
```typescript
{
  artifact_id: string;
  prompt: string;
  negative_prompt?: string;
  strength?: number; // 0.0 - 1.0
  dimensions?: string;
  seed?: number;
}
```

**Output:** Transformed image artifact

---

### `image.upscale`

Upscales an image by a specified scale factor.

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

Removes the background from an image.

**Providers:** Replicate (RMBG, BiRefNet), fal.ai

**Cost Range:** $0.003 - $0.01 per image

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:** Image artifact with transparent background

---

### `image.inpaint`

Inpaints a region of an image based on a mask and prompt.

**Providers:** Stability AI (SD3), Replicate, fal.ai

**Cost Range:** $0.005 - $0.02 per image

**Input:**
```typescript
{
  artifact_id: string;
  mask_artifact_id?: string;
  prompt: string;
  negative_prompt?: string;
}
```

**Output:** Inpainted image artifact

---

### `image.describe`

Generates a text description of an image using vision models.

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

Resizes an image to target dimensions.

**Type:** Local operation (no provider API call)

**Cost:** $0.00 (local processing)

**Input:**
```typescript
{
  artifact_id: string;
  dimensions: string; // e.g. "1080x1080"
  fit?: 'cover' | 'contain' | 'fill';
}
```

**Output:** Resized image artifact

---

### `image.crop`

Crops an image to a specified region.

**Type:** Local operation

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

Composites an overlay image onto a base image.

**Type:** Local operation

**Cost:** $0.00

**Input:**
```typescript
{
  base_artifact_id: string;
  overlay_artifact_id: string;
  position?: string;
  blend_mode?: 'normal' | 'multiply' | 'screen' | 'overlay';
  opacity?: number; // 0.0 - 1.0
}
```

**Output:** Composited image artifact

---

## Audio Operations

### `audio.tts`

Converts text to speech.

**Providers:** ElevenLabs, OpenAI TTS, Deepgram Aura

**Cost Range:** $0.005 - $0.03 per minute

**Input:**
```typescript
{
  text: string;
  voice?: string;
  speed?: number; // 0.5 - 2.0
  output_format?: 'mp3' | 'wav' | 'opus';
  model?: string;
}
```

**Output:** Audio artifact

---

### `audio.stt`

Transcribes audio to text.

**Providers:** Deepgram (Nova-2), OpenAI Whisper

**Cost Range:** $0.005 - $0.02 per minute

**Input:**
```typescript
{
  artifact_id: string;
  language?: string; // e.g. "en"
  diarize?: boolean;
}
```

**Output:** Text artifact with timestamps and segments

---

### `audio.diarize`

Identifies speakers in audio.

**Providers:** Deepgram (with diarization), Replicate (pyannote)

**Cost Range:** $0.01 - $0.03 per minute

**Input:**
```typescript
{
  artifact_id: string;
}
```

**Output:** Text artifact with speaker-labeled segments

---

### `audio.isolate`

Isolates specific audio stems (vocals, instruments, etc.).

**Providers:** Replicate (Demucs)

**Cost Range:** $0.01 - $0.02 per track

**Input:**
```typescript
{
  artifact_id: string;
  target?: 'vocals' | 'instruments' | 'drums' | 'bass';
}
```

**Output:** Audio artifact(s) — separated stems

---

## Video Operations

### `video.generate`

Generates video from a text prompt.

**Providers:** Replicate (Kling, LTX-Video, Wan), fal.ai

**Cost Range:** $0.05 - $0.20 per second

**Input:**
```typescript
{
  prompt: string;
  duration?: number; // seconds
  aspect_ratio?: string; // e.g. "16:9"
  style?: string;
  model?: string;
}
```

**Output:** Video artifact

---

### `video.image_to_video`

Generates video from an image with motion.

**Providers:** Replicate (Kling i2v, Stable Video Diffusion), fal.ai

**Cost Range:** $0.05 - $0.15 per second

**Input:**
```typescript
{
  artifact_id: string;
  motion_prompt?: string;
  duration?: number;
  model?: string;
}
```

**Output:** Video artifact

---

### `video.extract_frames`

Extracts frames from a video.

**Type:** Local operation (ffmpeg)

**Cost:** $0.00

**Input:**
```typescript
{
  artifact_id: string;
  interval?: number; // every Nth frame
  timestamps?: number[]; // specific timestamps in seconds
}
```

**Output:** Array of image artifacts

---

### `video.extract_audio`

Extracts audio track from a video.

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

## Document Operations

### `document.ocr`

Extracts text from images or PDFs.

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

**Output:** Text artifact (markdown table or JSON)

---

### `document.extract_fields`

Extracts structured fields from documents.

**Providers:** Anthropic Claude (vision), OpenAI GPT-4o (vision)

**Cost Range:** $0.01 - $0.03 per page

**Input:**
```typescript
{
  artifact_id: string;
  field_schema: { name: string; type: string }[];
  model?: string;
}
```

**Output:** Text artifact (JSON matching schema)

---

### `document.summarize`

Summarizes document content.

**Providers:** OpenAI GPT-4, Anthropic Claude, Google Gemini

**Cost Range:** $0.005 - $0.02 per page

**Input:**
```typescript
{
  artifact_id: string;
  length?: 'short' | 'medium' | 'long' | 'detailed';
  style?: string;
}
```

**Output:** Text artifact (summary)

---

## Pipeline Templates

### `product-photo`
generate → upscale → remove_background → composite

### `podcast-clip`
audio.stt → audio.diarize → audio.isolate

### `document-intake`
document.ocr → document.extract_fields → document.summarize

### `social-media-kit`
generate → resize (1:1) → resize (4:5) → resize (16:9)

### `video-thumbnail`
video.extract_frames → image.describe → quality_gate.evaluate → image.upscale

### `marketing-asset`
generate → image_to_image → composite → resize

---

## Notes

- All costs are approximate and vary by provider pricing
- Local operations (resize, crop, composite, extract_frames, extract_audio) have no provider cost
- Quality gates add additional LLM call costs when using `llm-judge` type
- Pipeline execution cost = sum of all step costs + quality gate costs
