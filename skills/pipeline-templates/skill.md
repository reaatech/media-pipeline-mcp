# Pipeline Templates

## Capability

Pre-built pipeline templates for common media workflows — ready-to-use pipeline definitions that chain multiple operations together with quality gates, variable interpolation, and optimized provider routing.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `media.pipeline.templates` | `{}` | `{ templates: PipelineTemplate[] }` | 60 RPM |



## Available Templates

### 1. Product Photo Pipeline

**Template ID:** `product-photo`

**Use case:** Generate professional product photos with background removal and upscaling.

**Steps:**
1. Generate product image from prompt
2. Quality gate: LLM-judge evaluates product visibility
3. Upscale to 4x resolution
4. Remove background
5. Optional: Composite onto lifestyle background

**Input variables:**
- `prompt` — Product description
- `background_prompt` — Optional lifestyle background description

**Example usage:**
```json
{
  "template_id": "product-photo",
  "variables": {
    "prompt": "Professional product photo of a white ceramic coffee mug on a clean background",
    "background_prompt": "Modern kitchen counter with soft natural lighting"
  }
}
```

### 2. Podcast Clip Pipeline

**Template ID:** `podcast-clip`

**Use case:** Process podcast audio into clips with transcription and summary.

**Steps:**
1. Extract audio from video (if video input)
2. Transcribe with diarization
3. Summarize content
4. Generate TTS promo voiceover

**Input variables:**
- `audio_artifact_id` — Source audio/video
- `promo_text` — Promotional text for voiceover
- `voice` — TTS voice name

**Example usage:**
```json
{
  "template_id": "podcast-clip",
  "variables": {
    "audio_artifact_id": "artifact-podcast-ep1",
    "promo_text": "Listen to our latest episode where we discuss the future of AI in media production.",
    "voice": "Rachel"
  }
}
```

### 3. Document Intake Pipeline

**Template ID:** `document-intake`

**Use case:** Process documents for data extraction and validation.

**Steps:**
1. OCR document
2. Extract structured fields based on schema
3. Validate extracted data
4. Summarize document content

**Input variables:**
- `document_artifact_id` — Source document image/PDF
- `field_schema` — JSON schema for field extraction
- `validation_rules` — Optional validation rules

**Example usage:**
```json
{
  "template_id": "document-intake",
  "variables": {
    "document_artifact_id": "artifact-invoice-scan",
    "field_schema": [
      { "name": "invoice_number", "type": "string" },
      { "name": "total_amount", "type": "number" },
      { "name": "vendor_name", "type": "string" }
    ]
  }
}
```

### 4. Social Media Kit Pipeline

**Template ID:** `social-media-kit`

**Use case:** Generate images in multiple aspect ratios for social media.

**Steps:**
1. Generate base image from prompt
2. Quality gate: LLM-judge evaluates relevance
3. Resize to 1:1 (Instagram square)
4. Resize to 4:5 (Instagram portrait)
5. Resize to 16:9 (Twitter/LinkedIn banner)

**Input variables:**
- `prompt` — Image description
- `style` — Optional style modifier

**Example usage:**
```json
{
  "template_id": "social-media-kit",
  "variables": {
    "prompt": "A modern minimalist logo for a tech startup, blue and white color scheme",
    "style": "clean, professional"
  }
}
```

### 5. Video Thumbnail Pipeline

**Template ID:** `video-thumbnail`

**Use case:** Generate engaging thumbnails from video content.

**Steps:**
1. Extract frames from video at intervals
2. Describe each frame with vision model
3. Select best frame via LLM-judge
4. Upscale selected frame
5. Optional: Add text overlay

**Input variables:**
- `video_artifact_id` — Source video
- `overlay_text` — Optional text to add
- `frame_interval` — Seconds between frame extraction

**Example usage:**
```json
{
  "template_id": "video-thumbnail",
  "variables": {
    "video_artifact_id": "artifact-youtube-video",
    "overlay_text": "MUST WATCH!",
    "frame_interval": "5"
  }
}
```

### 6. Marketing Asset Pipeline

**Template ID:** `marketing-asset`

**Use case:** Create complete marketing asset set from single concept.

**Steps:**
1. Generate hero image
2. Generate variations (3 options)
3. Quality gate: Select best via LLM-judge
4. Create social media sizes
5. Generate alt-text descriptions

**Input variables:**
- `concept` — Marketing concept description
- `brand_colors` — Optional brand color palette
- `target_audience` — Target audience description

**Example usage:**
```json
{
  "template_id": "marketing-asset",
  "variables": {
    "concept": "Eco-friendly water bottle for outdoor enthusiasts",
    "brand_colors": "#2E7D32, #4CAF50, #81C784",
    "target_audience": "Environmentally conscious hikers and campers aged 25-45"
  }
}
```

## Usage Examples

### Example 1: List available templates

**Tool call:**
```json
{}
```

**Expected response:**
```json
{
  "templates": [
    {
      "id": "product-photo",
      "name": "Product Photo",
      "description": "Generate professional product photos with background removal",
      "steps": 5,
      "estimated_cost_usd": 0.035,
      "estimated_duration_ms": 25000
    },
    {
      "id": "social-media-kit",
      "name": "Social Media Kit",
      "description": "Generate images in multiple aspect ratios",
      "steps": 5,
      "estimated_cost_usd": 0.028,
      "estimated_duration_ms": 20000
    }
  ]
}
```

### Example 2: Get template details

**Tool call:**
```json
{ "template_id": "product-photo" }
```

**Expected response:**
```json
{
  "template": {
    "id": "product-photo",
    "name": "Product Photo",
    "description": "Generate professional product photos with background removal",
    "steps": [
      {
        "id": "generate",
        "operation": "image.generate",
        "inputs": { "prompt": "{{prompt}}" },
        "qualityGate": { "type": "llm-judge", "config": { "prompt": "Is the product clearly visible?" } }
      },
      {
        "id": "upscale",
        "operation": "image.upscale",
        "inputs": { "artifact_id": "{{generate.output}}" },
        "config": { "scale": "4x" }
      },
      {
        "id": "remove_bg",
        "operation": "image.remove_background",
        "inputs": { "artifact_id": "{{upscale.output}}" }
      }
    ],
    "variables": ["prompt", "background_prompt"]
  },
  "estimated_cost_usd": 0.035,
  "estimated_duration_ms": 25000
}
```

### Example 3: Run template pipeline

**Tool call:**
```json
{
  "template_id": "product-photo",
  "variables": {
    "prompt": "Professional product photo of wireless earbuds on a white background"
  }
}
```

**Expected response:**
```json
{
  "pipeline_id": "pipeline-template-run-123",
  "status": "completed",
  "artifacts": [
    { "id": "artifact-generated", "type": "image", "uri": "s3://...", "sourceStep": "generate" },
    { "id": "artifact-upscaled", "type": "image", "uri": "s3://...", "sourceStep": "upscale" },
    { "id": "artifact-final", "type": "image", "uri": "s3://...", "sourceStep": "remove_bg" }
  ],
  "cost_usd": 0.032,
  "duration_ms": 23450
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `TEMPLATE_NOT_FOUND` | Template ID doesn't exist | List available templates |
| `MISSING_VARIABLE` | Required variable not provided | Return list of required variables |
| `INVALID_VARIABLE` | Variable value doesn't match expected format | Return validation error |
| `TEMPLATE_EXECUTION_FAILED` | Pipeline execution failed | Return step-level error details |

## Security Considerations

- **Template validation** — All templates validated before execution
- **Variable sanitization** — Prevent injection in variable interpolation
- **Cost limits** — Templates have estimated costs, enforce budgets
- **Access control** — Restrict template execution by permission

## Performance Characteristics

| Template | Estimated Cost | Estimated Duration |
|----------|---------------|-------------------|
| `product-photo` | $0.035 | 20-30s |
| `podcast-clip` | $0.045 | 30-60s |
| `document-intake` | $0.050 | 15-25s |
| `social-media-kit` | $0.028 | 15-25s |
| `video-thumbnail` | $0.040 | 30-60s |
| `marketing-asset` | $0.070 | 45-90s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPLATE_DEFAULT_QUALITY_GATE` | `llm-judge` | Default quality gate for templates |
| `TEMPLATE_MAX_RETRIES` | `2` | Default max retries for template steps |
| `TEMPLATE_COST_MULTIPLIER` | `1.0` | Multiplier for cost estimates (buffer) |

## Testing

```typescript
describe('pipeline-templates', () => {
  it('should list available templates', async () => {
    const result = await listTemplates();

    expect(result.templates).toBeDefined();
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.templates.find(t => t.id === 'product-photo')).toBeDefined();
  });

  it('should get template details', async () => {
    const result = await getTemplate('product-photo');

    expect(result.template).toBeDefined();
    expect(result.template.id).toBe('product-photo');
    expect(result.template.steps).toBeDefined();
    expect(result.estimated_cost_usd).toBeGreaterThan(0);
  });

  it('should run template with variables', async () => {
    const result = await runTemplate({
      template_id: 'social-media-kit',
      variables: {
        prompt: 'A modern logo for a coffee shop'
      }
    });

    expect(result.pipeline_id).toBeDefined();
    expect(result.status).toBe('completed');
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it('should fail on missing required variables', async () => {
    await expect(runTemplate({
      template_id: 'product-photo'
      // Missing required 'prompt' variable
    })).rejects.toThrow('MISSING_VARIABLE');
  });

  it('should handle template execution failures gracefully', async () => {
    const result = await runTemplate({
      template_id: 'product-photo',
      variables: {
        prompt: 'This prompt should trigger a quality gate failure'
      }
    });

    // Template should handle failures according to quality gate config
    expect(['completed', 'gated', 'failed']).toContain(result.status);
  });
});
