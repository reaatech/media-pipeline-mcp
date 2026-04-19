# Audio Transcription

## Capability

Speech-to-text (STT), transcription with timestamps, and speaker diarization using multiple providers (Deepgram, OpenAI Whisper) with support for multiple languages and audio formats.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `audio.stt` | `{ artifact_id: string, language?: string, diarize?: boolean }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `audio.diarize` | `{ artifact_id: string, num_speakers?: number }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `audio.isolate` | `{ artifact_id: string, target: 'vocals' \| 'instruments' \| 'drums' \| 'bass' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |

## Usage Examples

### Example 1: Speech-to-text transcription

**Tool call:**
```json
{
  "artifact_id": "artifact-audio-123",
  "language": "en",
  "include_timestamps": true
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-transcript-456",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-transcript-456.json",
    "mimeType": "application/json",
    "metadata": {
      "duration_seconds": 120.5,
      "language": "en",
      "confidence": 0.95,
      "word_count": 245,
      "segments": [
        {
          "start": 0.0,
          "end": 3.5,
          "text": "Hello and welcome to our podcast.",
          "confidence": 0.98
        },
        {
          "start": 3.5,
          "end": 7.2,
          "text": "Today we're discussing AI and media generation.",
          "confidence": 0.96
        }
      ]
    }
  },
  "cost_usd": 0.012,
  "duration_ms": 8500
}
```

### Example 2: Speaker diarization

**Tool call:**
```json
{
  "artifact_id": "artifact-interview",
  "language": "en",
  "num_speakers": 2
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-diarized-789",
    "type": "text",
    "uri": "s3://bucket/artifacts/artifact-diarized-789.json",
    "mimeType": "application/json",
    "metadata": {
      "duration_seconds": 300,
      "language": "en",
      "num_speakers": 2,
      "segments": [
        {
          "start": 0.0,
          "end": 15.3,
          "speaker": "Speaker 1",
          "text": "Thanks for joining us today."
        },
        {
          "start": 15.5,
          "end": 28.7,
          "speaker": "Speaker 2",
          "text": "Great to be here. Excited to talk about this topic."
        }
      ]
    }
  },
  "cost_usd": 0.03,
  "duration_ms": 15000
}
```

### Example 3: Audio isolation (stem separation)

**Tool call:**
```json
{
  "artifact_id": "artifact-song",
  "target": "vocals"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-vocals-only",
    "type": "audio",
    "uri": "s3://bucket/artifacts/artifact-vocals-only.wav",
    "mimeType": "audio/wav",
    "metadata": {
      "duration_seconds": 180,
      "sample_rate": 44100,
      "channels": 2,
      "source_artifact": "artifact-song",
      "isolated_stem": "vocals"
    }
  },
  "cost_usd": 0.05,
  "duration_ms": 25000
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback |
| `AUDIO_UNREADABLE` | Audio format not supported or corrupted | Return error with supported formats |
| `LANGUAGE_NOT_SUPPORTED` | Requested language not available | List supported languages |
| `TIMEOUT` | Transcription exceeded timeout | Fail with actionable error |
| `AUDIO_TOO_LONG` | Audio exceeds maximum duration | Suggest splitting audio |

## Security Considerations

- **PII redaction** — Optional automatic redaction of personal information
- **Content filtering** — Block prohibited audio content
- **Data retention** — Configurable retention policies for transcripts
- **Access control** — Restrict access to sensitive transcripts

## Performance Characteristics

| Metric | Target |
|--------|--------|
| STT (1 minute audio) | 3-8s |
| STT (10 minute audio) | 20-60s |
| Diarization (10 minute audio) | 30-90s |
| Audio isolation (3 minute song) | 15-30s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_TRANSCRIPTION_DEFAULT_PROVIDER` | `deepgram` | Default STT provider |
| `AUDIO_TRANSCRIPTION_DEFAULT_LANGUAGE` | `en` | Default language |
| `AUDIO_TRANSCRIPTION_TIMEOUT_MS` | `120000` | Timeout for transcription |
| `AUDIO_TRANSCRIPTION_MAX_DURATION_S` | `3600` | Maximum audio duration (1 hour) |
| `AUDIO_TRANSCRIPTION_INCLUDE_TIMESTAMPS` | `true` | Include timestamps by default |

## Testing

```typescript
describe('audio-transcription', () => {
  it('should transcribe audio to text', async () => {
    const audioArtifact = await createTestArtifact('audio', { duration_seconds: 30 });

    const result = await transcribeAudio({
      artifact_id: audioArtifact.id,
      language: 'en',
      include_timestamps: true
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.word_count).toBeGreaterThan(0);
    expect(result.artifact.metadata.segments).toBeDefined();
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should diarize multi-speaker audio', async () => {
    const audioArtifact = await createTestArtifact('audio', { duration_seconds: 60 });

    const result = await diarizeAudio({
      artifact_id: audioArtifact.id,
      num_speakers: 2
    });

    expect(result.artifact.type).toBe('text');
    expect(result.artifact.metadata.segments).toBeDefined();
    expect(result.artifact.metadata.segments[0].speaker).toBeDefined();
  });

  it('should isolate vocals from music', async () => {
    const audioArtifact = await createTestArtifact('audio', { duration_seconds: 180 });

    const result = await isolateAudio({
      artifact_id: audioArtifact.id,
      target: 'vocals'
    });

    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.metadata.isolated_stem).toBe('vocals');
  });

  it('should handle multiple languages', async () => {
    const audioArtifact = await createTestArtifact('audio');

    const result = await transcribeAudio({
      artifact_id: audioArtifact.id,
      language: 'es'
    });

    expect(result.artifact.type).toBe('text');
  });

  it('should use fallback provider on failure', async () => {
    const mockDeepgram = { stt: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockWhisper = { stt: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await sttWithFallback({ artifact_id: 'test' }, {
      primary: mockDeepgram,
      fallbacks: [mockWhisper]
    });

    expect(result.artifact).toBeDefined();
  });
});
