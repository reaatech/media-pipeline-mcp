# Image Editing

## Capability

Image manipulation operations including upscaling, background removal, inpainting, resizing, cropping, and compositing. Supports both local operations (via sharp) and provider-based operations (Replicate, fal.ai, Stability AI).

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `image.upscale` | `{ artifact_id: string, scale?: 2 \| 4, model?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `image.remove_background` | `{ artifact_id: string, output_format?: 'png' \| 'webp' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `image.inpaint` | `{ artifact_id: string, mask_artifact_id?: string, prompt: string, negative_prompt?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `image.resize` | `{ artifact_id: string, dimensions: string, fit?: 'cover' \| 'contain' \| 'fill' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 60 RPM |
| `image.crop` | `{ artifact_id: string, x: number, y: number, width: number, height: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 60 RPM |
| `image.composite` | `{ base_artifact_id: string, overlay_artifact_id: string, position?: string, opacity?: number, blend_mode?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 60 RPM |
| `image.describe` | `{ artifact_id: string, detail?: 'brief' \| 'detailed' \| 'structured', format?: 'text' \| 'json' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |

## Usage Examples

### Example 1: Upscale image

**Tool call:**
```json
{
  "artifact_id": "artifact-low-res",
  "scale": 4,
  "model": "real-esrgan"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-upscaled",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-upscaled.png",
    "mimeType": "image/png",
    "metadata": { "width": 4096, "height": 4096, "original_width": 1024, "original_height": 1024, "scale": 4 }
  },
  "cost_usd": 0.015,
  "duration_ms": 8500
}
```

### Example 2: Remove background

**Tool call:**
```json
{
  "artifact_id": "artifact-product",
  "output_format": "png"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-no-bg",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-no-bg.png",
    "mimeType": "image/png",
    "metadata": { "width": 1024, "height": 1024, "has_alpha": true }
  },
  "cost_usd": 0.005,
  "duration_ms": 3200
}
```

### Example 3: Inpaint image

**Tool call:**
```json
{
  "artifact_id": "artifact-original",
  "prompt": "Add a red bow tie to the subject",
  "negative_prompt": "blurry, low quality"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-inpainted",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-inpainted.png",
    "mimeType": "image/png",
    "metadata": { "width": 1024, "height": 1024 }
  },
  "cost_usd": 0.007,
  "duration_ms": 5100
}
```

### Example 4: Resize image

**Tool call:**
```json
{
  "artifact_id": "artifact-large",
  "width": 800,
  "height": 600,
  "fit": "cover",
  "background": "#FFFFFF"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-resized",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-resized.jpg",
    "mimeType": "image/jpeg",
    "metadata": { "width": 800, "height": 600, "fit": "cover" }
  },
  "cost_usd": 0.001,
  "duration_ms": 450
}
```

### Example 5: Describe image

**Tool call:**
```json
{
  "artifact_id": "artifact-mystery",
  "detail": "structured",
  "format": "json"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-description",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-description.json",
    "mimeType": "application/json",
    "metadata": {}
  },
  "cost_usd": 0.003,
  "duration_ms": 2800
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback |
| `INVALID_ARTIFACT` | Artifact not found or wrong type | Return 404, suggest checking artifact_id |
| `UNSUPPORTED_OPERATION` | Operation not supported for artifact type | Return error with supported operations |
| `TIMEOUT` | Operation exceeded timeout | Fail with actionable error |

## Security Considerations

- **Image content validation** — Check for prohibited content
- **File size limits** — Enforce maximum upload size
- **Metadata stripping** — Remove EXIF data for privacy
- **Cost tracking** — Track costs per operation

## Performance Characteristics

| Metric | Target |
|--------|--------|
| Upscale (4x) | 5-15s |
| Remove background | 2-5s |
| Inpaint | 3-8s |
| Resize (local) | < 1s |
| Crop (local) | < 1s |
| Composite (local) | < 1s |
| Describe (vision model) | 2-5s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_EDITING_DEFAULT_UPSCALE_MODEL` | `real-esrgan` | Default upscaling model |
| `IMAGE_EDITING_TIMEOUT_MS` | `60000` | Timeout for editing operations |
| `IMAGE_EDITING_MAX_DIMENSIONS` | `4096` | Maximum output dimensions |
| `IMAGE_EDITING_LOCAL_OPS` | `true` | Enable local operations (resize, crop, composite) |

## Testing

```typescript
describe('image-editing', () => {
  it('should upscale image', async () => {
    const sourceArtifact = await createTestArtifact('image', { width: 512, height: 512 });

    const result = await upscaleImage({
      artifact_id: sourceArtifact.id,
      scale: 2
    });

    expect(result.artifact.metadata.width).toBe(1024);
    expect(result.artifact.metadata.height).toBe(1024);
  });

  it('should remove background', async () => {
    const sourceArtifact = await createTestArtifact('image');

    const result = await removeBackground({
      artifact_id: sourceArtifact.id
    });

    expect(result.artifact.metadata.has_alpha).toBe(true);
  });

  it('should resize image locally', async () => {
    const sourceArtifact = await createTestArtifact('image', { width: 1024, height: 768 });

    const result = await resizeImage({
      artifact_id: sourceArtifact.id,
      width: 800,
      height: 600,
      fit: 'cover'
    });

    expect(result.artifact.metadata.width).toBe(800);
    expect(result.artifact.metadata.height).toBe(600);
    expect(result.cost_usd).toBeLessThan(0.01); // Local operation, very cheap
  });

  it('should describe image with vision model', async () => {
    const sourceArtifact = await createTestArtifact('image');

    const result = await describeImage({
      artifact_id: sourceArtifact.id,
      detail: 'brief'
    });

    expect(result.artifact.type).toBe('text');
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should handle provider fallback for upscaling', async () => {
    const mockReplicate = { upscale: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockFal = { upscale: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await upscaleWithFallback({ artifact_id: 'test' }, {
      primary: mockReplicate,
      fallbacks: [mockFal]
    });

    expect(result.artifact).toBeDefined();
  });
});
