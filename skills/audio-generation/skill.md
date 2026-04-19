# Audio Generation

## Capability

Text-to-speech (TTS), music generation, and sound effects creation using multiple providers (ElevenLabs, OpenAI, Deepgram) with support for various voices, languages, and audio formats.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `audio.tts` | `{ text: string, voice?: string, speed?: number, output_format?: 'mp3' \| 'wav' \| 'opus' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 30 RPM |
| `audio.music` | `{ prompt: string, duration?: number, instrumental?: boolean, style?: string, tempo?: number, format?: 'mp3' \| 'wav' \| 'ogg' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |
| `audio.sound_effect` | `{ prompt: string, duration?: number, format?: 'mp3' \| 'wav' \| 'ogg' }` | `{ artifact: Artifact, cost_usd: number, duration_ms: number }` | 10 RPM |

## Usage Examples

### Example 1: Text-to-speech

**Tool call:**
```json
{
  "text": "Welcome to our platform. We're excited to have you here.",
  "voice": "Rachel",
  "speed": 1.0,
  "output_format": "mp3"
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-tts-123",
    "type": "audio",
    "uri": "s3://bucket/artifacts/artifact-tts-123.mp3",
    "mimeType": "audio/mpeg",
    "metadata": {
      "duration_seconds": 4.2,
      "sample_rate": 44100,
      "channels": 1,
      "voice": "Rachel",
      "model": "eleven_monolingual_v1"
    }
  },
  "cost_usd": 0.008,
  "duration_ms": 3500
}
```

### Example 2: Music generation

**Tool call:**
```json
{
  "prompt": "Upbeat electronic dance music with a catchy synth melody",
  "duration": 30,
  "style": "electronic",
  "tempo": 128
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-music-456",
    "type": "audio",
    "uri": "s3://bucket/artifacts/artifact-music-456.mp3",
    "mimeType": "audio/mpeg",
    "metadata": {
      "duration_seconds": 30,
      "sample_rate": 44100,
      "channels": 2,
      "style": "electronic",
      "tempo": 128
    }
  },
  "cost_usd": 0.05,
  "duration_ms": 15000
}
```

### Example 3: Sound effect generation

**Tool call:**
```json
{
  "prompt": "A futuristic UI click sound, short and crisp",
  "duration": 1
}
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-sfx-789",
    "type": "audio",
    "uri": "s3://bucket/artifacts/artifact-sfx-789.wav",
    "mimeType": "audio/wav",
    "metadata": {
      "duration_seconds": 1,
      "sample_rate": 44100,
      "channels": 1
    }
  },
  "cost_usd": 0.02,
  "duration_ms": 8000
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_ERROR` | Provider API failure | Retry with backoff, use fallback |
| `INVALID_TEXT` | Text too long or contains prohibited content | Return error with limits |
| `VOICE_NOT_FOUND` | Requested voice not available | List available voices |
| `TIMEOUT` | Generation exceeded timeout | Fail with actionable error |

## Security Considerations

- **Voice cloning restrictions** — Only allow approved voices
- **Content filtering** — Block prohibited text content
- **Copyright compliance** — Ensure generated content doesn't infringe
- **Rate limiting** — Protect against abuse

## Performance Characteristics

| Metric | Target |
|--------|--------|
| TTS (short text, < 100 chars) | 1-3s |
| TTS (long text, < 1000 chars) | 3-8s |
| Music generation (30s) | 10-20s |
| Sound effect (1s) | 5-10s |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUDIO_GENERATION_DEFAULT_VOICE` | `Rachel` | Default TTS voice |
| `AUDIO_GENERATION_DEFAULT_PROVIDER` | `elevenlabs` | Default provider |
| `AUDIO_GENERATION_TIMEOUT_MS` | `60000` | Timeout for generation |
| `AUDIO_GENERATION_MAX_TEXT_LENGTH` | `5000` | Maximum text length for TTS |
| `AUDIO_GENERATION_DEFAULT_FORMAT` | `mp3` | Default audio format |

## Testing

```typescript
describe('audio-generation', () => {
  it('should generate speech from text', async () => {
    const result = await generateTTS({
      text: 'Hello world',
      voice: 'Rachel'
    });

    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.metadata.duration_seconds).toBeGreaterThan(0);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should generate music from prompt', async () => {
    const result = await generateMusic({
      prompt: 'Upbeat electronic music',
      duration_seconds: 10,
      genre: 'electronic'
    });

    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.metadata.duration_seconds).toBe(10);
  });

  it('should generate sound effect', async () => {
    const result = await generateSoundEffect({
      prompt: 'Futuristic click sound',
      duration_seconds: 1
    });

    expect(result.artifact.type).toBe('audio');
  });

  it('should handle long text TTS', async () => {
    const longText = 'A'.repeat(4000);
    const result = await generateTTS({
      text: longText,
      voice: 'Rachel'
    });

    expect(result.artifact.type).toBe('audio');
    expect(result.artifact.metadata.duration_seconds).toBeGreaterThan(10);
  });

  it('should use fallback provider on failure', async () => {
    const mockElevenLabs = { tts: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockOpenAI = { tts: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await ttsWithFallback({ text: 'test' }, {
      primary: mockElevenLabs,
      fallbacks: [mockOpenAI]
    });

    expect(result.artifact).toBeDefined();
  });
});
