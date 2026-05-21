# Quality Gates Guide

Quality gates are validation checkpoints between pipeline steps that ensure output quality before proceeding to the next step.

## Gate Types

### 1. LLM-Judge Gate

Uses an LLM to evaluate output quality based on a custom prompt.

**Best for:** Subjective quality assessment, relevance checking, creative evaluation

**Cost:** LLM API call per evaluation (e.g., ~$0.002-0.01 per image with GPT-4o-mini)

```json
{
  "type": "llm-judge",
  "config": {
    "prompt": "Evaluate this image for: relevance to prompt, visual quality, composition. Return JSON with scores 1-10 and a 'pass' boolean (pass if average >= 7).",
    "model": "gpt-4o-mini",
    "timeout": 30000
  },
  "action": "retry",
  "maxRetries": 2
}
```

### 2. Threshold Gate

Numeric checks on artifact metadata (dimensions, file size, duration, etc.).

**Best for:** Objective technical requirements, format validation

**Cost:** Free (local evaluation)

```json
{
  "type": "threshold",
  "config": {
    "checks": [
      { "field": "metadata.width", "operator": ">=", "value": 1024 },
      { "field": "metadata.height", "operator": ">=", "value": 1024 },
      { "field": "metadata.fileSize", "operator": "<", "value": 10485760 }
    ]
  },
  "action": "fail"
}
```

### 3. Dimension-Check Gate

Verifies output dimensions match expectations with optional tolerance.

**Best for:** Ensuring consistent output sizes for downstream processing

**Cost:** Free (local evaluation)

```json
{
  "type": "dimension-check",
  "config": {
    "expectedWidth": 1024,
    "expectedHeight": 1024,
    "tolerance": 0.05
  },
  "action": "warn"
}
```

### 4. Custom Gate

User-provided function for programmatic validation.

**Best for:** Complex business logic, integration with external systems

**Cost:** Varies by implementation

```typescript
{
  "type": "custom",
  "config": {
    "validator": "my-custom-validator",
    "params": { /* custom params */ }
  },
  "action": "fail"
}
```

### 5. Safety Gate

Content moderation gate using LLM-based or dedicated classifier models to detect unsafe content.

**Best for:** Content moderation, default-on safety for generative outputs, CSAM detection

**Cost:** Free with OpenAI omni-moderation-latest; ~$0.0003 with Replicate image classifier

**Feature flag:** `features.safetyGate: true` (default-on in Phase 2.4)

```json
{
  "type": "safety",
  "provider": "openai",
  "model": "omni-moderation-latest",
  "block": ["sexual/minors", "graphic-violence", "hate"],
  "thresholds": { "sexual/minors": 0.5, "graphic-violence": 0.5 },
  "action": "fail"
}
```

**Default-on policy:** When `features.safetyGate: true` (the Phase 2.4 default), the executor injects an implicit safety gate for every moderable operation. No explicit gate declaration is required. The implicit gate triggers `fail` on any detected violation.

**CSAM:** CSAM content triggers unconditional fail regardless of threshold or action setting. This behavior cannot be overridden.

**Opt-out:** Disable default-on safety by setting `features.safetyGate: false` at the pipeline level. Alternatively, set `action: 'warn'` on an explicit safety gate to log violations without halting the pipeline.

**Categories:** The `block` array supports: `sexual`, `sexual/minors`, `hate`, `harassment`, `self-harm`, `violence`, `graphic-violence`, `illegal`, `pii`, `misinformation`, `csam`.

### 6. Loudness Gate

Audio loudness normalization to broadcast specs using two-pass ffmpeg loudnorm processing.

**Best for:** Audio/video loudness normalization to broadcast specs, cross-provider LUFS consistency

**Cost:** Free (local ffmpeg processing)

```json
{
  "type": "loudness",
  "preset": "podcast",
  "action": "normalize",
  "inPlace": false
}
```

**Presets:**

| Preset | Integrated LUFS | LRA | True Peak |
|--------|----------------|-----|-----------|
| `youtube` | -14 | 7 | -2 dBTP |
| `spotify` | -14 | 6 | -1 dBTP |
| `podcast` | -16 | 5 | -2 dBTP |
| `broadcast-ebu` | -23 | 7 | -1 dBTP |
| `broadcast-atsc` | -24 | 6 | -2 dBTP |

**Custom target:** Override the preset by specifying `integratedLufs`, `lra`, and `tpDb` directly.

**Two-pass processing:** The gate runs ffmpeg's `loudnorm` filter in two passes — first to measure, second to normalize — ensuring ITU-R BS.1770-4 compliance.

**`inPlace: false`** (default) produces a derived artifact, preserving the original. Set `inPlace: true` to replace the artifact in-place (irreversible).

**Tolerance band:** Configure `tolerance` (dB, default ±0.5) to allow slight deviations without re-processing. Useful when artifacts are close to spec and only need a gate check, not full normalization.

## Action Types

| Action | Behavior | Use Case |
|--------|----------|----------|
| `fail` | Pipeline halts immediately | Critical quality requirements |
| `retry` | Re-executes step up to maxRetries | Transient issues, generative variance |
| `warn` | Logs warning but continues | Non-critical checks, informational |

## Tuning Guidance

### When to Use Each Gate

| Scenario | Recommended Gate |
|----------|-----------------|
| "Does this look good?" | LLM-Judge |
| "Is the image 1024x1024?" | Threshold or Dimension-Check |
| "Is the file under 5MB?" | Threshold |
| "Does the prompt match the output?" | LLM-Judge |
| "Is the audio under 30 seconds?" | Threshold |
| "Check against our brand guidelines" | LLM-Judge or Custom |
| "Is this content safe for production?" | Safety |
| "Is the audio at broadcast loudness?" | Threshold or Loudness |

### Cost Considerations

- **LLM-Judge gates are not free** — each evaluation costs an LLM API call
- Budget ~$0.002-0.01 per evaluation with GPT-4o-mini
- For high-volume pipelines, consider using threshold gates first, then LLM-judge only for borderline cases
- Use `warn` action for non-critical LLM-judge checks to avoid blocking pipelines

### Performance Tips

1. **Use threshold gates before LLM-judge** — fail fast on obvious issues
2. **Set reasonable timeouts** — LLM-judge should have 30-60s timeout
3. **Limit retries** — maxRetries of 2-3 is usually sufficient
4. **Cache LLM evaluations** — same artifact shouldn't be evaluated twice

## Observability

Quality gate results are exposed via metrics:

- `media.quality_gate.pass_rate` — gauge by gate type
- `media.quality_gate.retry_count` — counter of retries

All gate evaluations are logged with structured context including pipeline ID, step ID, gate type, and result.
