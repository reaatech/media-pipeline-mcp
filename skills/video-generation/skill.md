# Video Generation

## Capability

Text-to-video and image-to-video generation using providers like Replicate (Kling, LTX-Video, Wan) and fal.ai, plus local video operations via ffmpeg for frame extraction and audio extraction.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `video.generate` | `{ prompt: string, duration?: number, aspect_ratio?: string, style?: string }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `video.image_to_video` | `{ artifact_id: string, motion_prompt?: string, duration?: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `video.extract_frames` | `{ artifact_id: string, interval?: number, timestamps?: number[] }` | `{ artifacts: Artifact[], cost_usd: number, duration_ms: number }` | 30 RPM |
| `video.extract_audio` | `{ artifact_id: string, format?: 'mp3' \| 'wav' \| 'aac' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |

## Usage Examples

### Example 1: Generate video from text

**Tool call:**
```json
{
  "prompt": "A cinematic drone shot flying over a mountain range at sunset, golden hour lighting, 4K quality",
  "duration_seconds": 5,
  "width": 1920,
  "height": 1080,
  "aspect_ratio": "16:9"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-video-123",
    "type": "video",
    "uri": "s3://bucket/artifacts/artifact-video-123.mp4",
    "mimeType": "video/mp4",
    "metadata": {
      "duration_seconds": 5,
      "width": 1920,
      "height": 1080,
      "fps": 24,
      "codec": "h264",
      "model": "kling"
    }
  },
  "cost_usd": 0.15,
  "duration_ms": 45000
}
```

### Example 2: Image-to-video conversion

**Tool call:**
```json
{
  "source_artifact_id": "artifact-image-456",
  "motion_prompt": "Slow zoom in with subtle camera movement",
  "duration_seconds": 4
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-vid-from-img-789",
    "type": "video",
    "uri": "s3://bucket/artifacts/artifact-vid-from-img-789.mp4",
    "mimeType": "video/mp4",
    "metadata": {
      "duration_seconds": 4,
      "width": 1024,
      "height": 1024,
      "fps": 24,
      "source_image": "artifact-image-456"
    }
  },
  "cost_usd": 0.10,
  "duration_ms": 35000
}
```

### Example 3: Extract frames from video

**Tool call:**
```json
{
  "artifact_id": "artifact-video-123",
  "interval_seconds": 1,
  "max_frames": 10
}
```

**Expected response:**
```json
{
  "artifacts": [
    {
      "id": "artifact-frame-1",
      "type": "image",
      "uri": "s3://bucket/artifacts/artifact-frame-1.jpg",
      "mimeType": "image/jpeg",
      "metadata": { "width": 1920, "height": 1080, "timestamp_seconds": 0 }
    },
    {
      "id": "artifact-frame-2",
      "type": "image",
      "uri": "s3://bucket/artifacts/artifact-frame-2.jpg",
      "mimeType": "image/jpeg",
      "metadata": { "width": 1920, "height": 1080, "timestamp_seconds": 1 }
    }
  ],
  "cost_usd": 0.005,
  "duration_ms": 3500
}
```

### Example 4: Extract audio from video

**Tool call:**
```json
{
  "artifact_id": "artifact-video-123",
  "output_format": "mp3"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-audio-from-video",
    "type": "audio",
    "uri": "s3://bucket/artifacts/artifact-audio-from-video.mp3",
    "mimeType": "audio/mpeg",
    "metadata": {
      "duration_seconds": 5,
      "sample_rate": 44100,
      "channels": 2,
      "source_video": "artifact-video-123"
    }
  },
  "cost_usd": 0.002,
  "duration_ms": 1500
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback |
| `VIDEO_GENERATION_TIMEOUT` | Generation exceeded timeout (common for video) | Return polling URL, allow async retrieval |
| `INVALID_SOURCE_IMAGE` | Source image not found or wrong format | Return error with supported formats |
| `VIDEO_TOO_LONG` | Requested duration exceeds limits | Return error with maximum duration |
| `FFMPEG_ERROR` | Local video processing failed | Return error with ffmpeg output |

## Security Considerations

- **Content moderation** — Screen video content for prohibited material
- **Copyright compliance** — Ensure generated videos don't infringe
- **File size limits** — Enforce maximum video file sizes
- **Resource limits** — Prevent abuse of expensive video generation

## Performance Characteristics

| Metric | Target |
|--------|--------|
| Text-to-video (5s) | 30-90s |
| Image-to-video (4s) | 20-60s |
| Extract frames (10 frames) | 2-5s |
| Extract audio (5min video) | 3-10s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_GENERATION_DEFAULT_PROVIDER` | `replicate` | Default video generation provider |
| `VIDEO_GENERATION_TIMEOUT_MS` | `180000` | Timeout for video generation (3 minutes) |
| `VIDEO_GENERATION_MAX_DURATION_S` | `10` | Maximum video duration |
| `VIDEO_GENERATION_DEFAULT_FPS` | `24` | Default frames per second |
| `VIDEO_EXTRACTION_DEFAULT_INTERVAL_S` | `1` | Default frame extraction interval |

## Testing

```typescript
describe('video-generation', () => {
  it('should generate video from prompt', async () => {
    const result = await generateVideo({
      prompt: 'A scenic mountain landscape',
      duration_seconds: 3,
      width: 1280,
      height: 720
    });

    expect(result.artifact.type).toBe('video');
    expect(result.artifact.metadata.duration_seconds).toBe(3);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should convert image to video', async () => {
    const imageArtifact = await createTestArtifact('image', { width: 1024, height: 1024 });

    const result = await imageToVideo({
      source_artifact_id: imageArtifact.id,
      motion_prompt: 'Slow zoom',
      duration_seconds: 3
    });

    expect(result.artifact.type).toBe('video');
    expect(result.artifact.metadata.source_image).toBe(imageArtifact.id);
  });

  it('should extract frames from video', async () => {
    const videoArtifact = await createTestArtifact('video', { duration_seconds: 10 });

    const result = await extractFrames({
      artifact_id: videoArtifact.id,
      interval_seconds: 2,
      max_frames: 5
    });

    expect(result.artifacts).toHaveLength(5);
    expect(result.artifacts[0].type).toBe('image');
    expect(result.cost_usd).toBeLessThan(0.01); // Local operation, cheap
  });

  it('should extract audio from video', async () => {
    const videoArtifact = await createTestArtifact('video', { duration_seconds: 30 });

    const result = await extractAudio({
      artifact_id: videoArtifact.id,
      output_format: 'mp3'
    });

    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.metadata.source_video).toBe(videoArtifact.id);
  });

  it('should handle long video generation with polling', async () => {
    const result = await generateVideoAsync({
      prompt: 'Epic cinematic scene',
      duration_seconds: 10
    });

    // Should return immediately with a job ID
    expect(result.job_id).toBeDefined();
    expect(result.status).toBe('processing');

    // Poll for completion
    const status = await checkVideoJobStatus(result.job_id);
    expect(['processing', 'completed', 'failed']).toContain(status.status);
  });
});
