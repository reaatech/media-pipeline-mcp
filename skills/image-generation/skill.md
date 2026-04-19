# Image Generation

## Capability

Text-to-image and image-to-image generation using multiple providers (Stability AI, Replicate, OpenAI, fal.ai) with support for various models including SD3, SDXL, Flux, and DALL-E 3.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `image.generate` | `{ prompt: string, negative_prompt?: string, dimensions?: string, aspect_ratio?: string, style_preset?: string, seed?: number, num_outputs?: number, model?: string }` | `{ artifacts: Artifact[], cost_usd: number, duration_ms: number }` | 30 RPM |
| `image.generate.batch` | `{ prompts: string[], negative_prompt?: string, dimensions?: string, aspect_ratio?: string, style_preset?: string, num_variations?: number }` | `{ artifacts: Artifact[], cost_usd: number, duration_ms: number }` | 10 RPM |
| `image.image_to_image` | `{ artifact_id: string, prompt: string, negative_prompt?: string, strength?: number, dimensions?: string, seed?: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |

## Usage Examples

### Example 1: Generate image from text

**Tool call:**
```json
{
  "prompt": "A professional product photo of a white sneaker on a clean white background, studio lighting, high quality",
  "dimensions": "1024x1024",
  "model": "sd3",
  "negative_prompt": "blurry, low quality, watermark"
}
```

**Expected response:**
```json
{
  "artifacts": [
    {
      "id": "artifact-img-123",
      "type": "image",
      "uri": "s3://bucket/artifacts/artifact-img-123.png",
      "mimeType": "image/png",
      "metadata": { "width": 1024, "height": 1024, "model": "sd3", "seed": 42, "dimensions": "1024x1024" }
    }
  ],
  "cost_usd": 0.007,
  "duration_ms": 4523
}
```

### Example 2: Batch generation

**Tool call:**
```json
{
  "prompts": [
    "A modern logo for a tech startup, minimalist design",
    "A modern logo for a tech startup, geometric style",
    "A modern logo for a tech startup, abstract design"
  ],
  "dimensions": "1024x1024",
  "style_preset": "flux"
}
```

**Expected response:**
```json
{
  "artifacts": [
    { "id": "artifact-1", "type": "image", "uri": "s3://...", "metadata": {} },
    { "id": "artifact-2", "type": "image", "uri": "s3://...", "metadata": {} },
    { "id": "artifact-3", "type": "image", "uri": "s3://...", "metadata": {} }
  ],
  "cost_usd": 0.021,
  "duration_ms": 12500
}
```

### Example 3: Image-to-image transformation

**Tool call:**
```json
{
  "artifact_id": "artifact-original",
  "prompt": "Transform this into a cyberpunk style with neon colors",
  "strength": 0.75
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-transformed",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-transformed.png",
    "mimeType": "image/png",
    "metadata": { "width": 1024, "height": 1024, "model": "sd3", "strength": 0.75 }
  },
  "cost_usd": 0.007,
  "duration_ms": 3800
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback provider |
| `INVALID_PROMPT` | Prompt contains prohibited content | Return error with content policy explanation |
| `TIMEOUT` | Generation exceeded timeout | Fail with actionable error, suggest reducing dimensions |
| `RATE_LIMITED` | Provider rate limit hit | Exponential backoff, queue for retry |

## Security Considerations

- **Content filtering** — Block prohibited content in prompts
- **NSFW detection** — Optional moderation on generated images
- **Prompt injection** — Sanitize prompts to prevent injection attacks
- **Cost controls** — Track costs per generation, enforce budgets

## Performance Characteristics

| Metric | Target |
|--------|--------|
| SD3 generation (1024x1024) | 3-8s |
| DALL-E 3 generation | 5-15s |
| Flux generation (1024x1024) | 2-5s |
| Batch generation (3 images) | 5-15s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_GENERATION_DEFAULT_MODEL` | `sd3` | Default model for generation |
| `IMAGE_GENERATION_TIMEOUT_MS` | `60000` | Timeout for generation |
| `IMAGE_GENERATION_MAX_DIMENSIONS` | `2048` | Maximum width/height |
| `IMAGE_GENERATION_DEFAULT_SEED` | `random` | Default seed (random or fixed) |

## Testing

```typescript
describe('image-generation', () => {
  it('should generate image from prompt', async () => {
    const result = await generateImage({
      prompt: 'A test image',
      width: 512,
      height: 512
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('image');
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should generate batch of images', async () => {
    const result = await generateImageBatch({
      prompts: ['Prompt 1', 'Prompt 2', 'Prompt 3'],
      width: 512,
      height: 512
    });

    expect(result.artifacts).toHaveLength(3);
  });

  it('should transform image with image-to-image', async () => {
    const sourceArtifact = await createTestArtifact('image');

    const result = await imageToImage({
      source_artifact_id: sourceArtifact.id,
      prompt: 'Transform to cyberpunk style',
      strength: 0.75
    });

    expect(result.artifact.type).toBe('image');
    expect(result.artifact.metadata.strength).toBe(0.75);
  });

  it('should handle provider fallback', async () => {
    const mockStability = { generate: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockReplicate = { generate: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await generateWithFallback({ prompt: 'test' }, {
      primary: mockStability,
      fallbacks: [mockReplicate]
    });

    expect(result.artifacts).toHaveLength(1);
  });
});
