# @reaatech/media-pipeline-mcp-audio-gen

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-audio-gen.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-audio-gen)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Audio generation and processing operations — text-to-speech, speech-to-text, speaker diarization, source separation, music generation, and sound effects — all via provider delegation with multi-provider routing.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-audio-gen
# or
pnpm add @reaatech/media-pipeline-mcp-audio-gen
```

## Feature Overview

- **Text-to-speech** — convert text to natural speech with voice, speed, and format options
- **Speech-to-text** — transcribe audio with optional language detection and diarization
- **Speaker diarization** — identify and label individual speakers in multi-speaker audio
- **Source separation** — isolate audio stems (vocals, instruments, drums, bass)
- **Music generation** — generate music from a text prompt with style, tempo, and instrumentation control
- **Sound effects** — generate sound effects from a text prompt with configurable duration
- **Multi-provider routing** — operation-based lookup with preferred provider selection; falls back to first capable provider
- **Realtime STT streaming** — WebSocket-based streaming transcription via Deepgram with interim results and speaker diarization (via `TranscribeStream`)
- **Provider-agnostic** — works with OpenAI, ElevenLabs, Deepgram, and any conformant provider

## Quick Start

```typescript
import { createAudioGenOperations } from "@reaatech/media-pipeline-mcp-audio-gen";
import { ElevenLabsProvider } from "@reaatech/media-pipeline-mcp-elevenlabs";
import { DeepgramProvider } from "@reaatech/media-pipeline-mcp-deepgram";
import { OpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";

const ops = createAudioGenOperations(artifactRegistry, storage);

// Register providers — operations auto-route to the right one
ops.registerProvider("openai", new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }));
ops.registerProvider("elevenlabs", new ElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! }));
ops.registerProvider("deepgram", new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! }));

// Text to speech — routes to OpenAI or ElevenLabs
const speech = await ops.textToSpeech({
  text: "Welcome to the media pipeline.",
  voice: "alloy",
  speed: 1.0,
  format: "mp3",
  provider: "openai", // optional: force a specific provider
});

// Transcribe audio — routes to Deepgram or OpenAI
const transcript = await ops.speechToText("audio-123", {
  language: "en",
  diarize: true,
  model: "whisper-1",
});

// Identify speakers
const speakers = await ops.diarize("meeting-456", {
  language: "en",
});

// Separate audio stems
const vocals = await ops.isolate("song-789", {
  target: "vocals",
  model: "demucs",
});

// Generate music
const music = await ops.generateMusic({
  prompt: "Upbeat electronic pop with a driving beat",
  duration: 60,
  instrumental: false,
  style: "electronic-pop",
  tempo: 128,
  format: "mp3",
});

// Generate a sound effect
const sfx = await ops.generateSoundEffect({
  prompt: "Heavy wooden door creaking open",
  duration: 3,
  format: "wav",
});
```

## API Reference

### `createAudioGenOperations(artifactRegistry, storage)`

Factory function that creates an `AudioGenOperations` instance bound to the given artifact registry and store.

```typescript
function createAudioGenOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): AudioGenOperations;
```

### `AudioGenOperations`

Main class providing all audio generation and processing capabilities. Operations delegate to registered providers based on operation type.

```typescript
class AudioGenOperations {
  constructor(artifactRegistry: ArtifactRegistry, storage: ArtifactStore);

  registerProvider(name: string, provider: MediaProvider): void;

  textToSpeech(config: TTSConfig): Promise<Artifact>;
  speechToText(artifactId: string, config?: STTConfig): Promise<Artifact>;
  diarize(artifactId: string, config?: DiarizeConfig): Promise<Artifact>;
  isolate(artifactId: string, config: IsolateConfig): Promise<Artifact>;
  generateMusic(config: MusicConfig): Promise<Artifact>;
  generateSoundEffect(config: SoundEffectConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `TTSConfig`

```typescript
interface TTSConfig {
  text: string;                     // Text to convert to speech
  voice?: string;                   // Voice ID (default: "alloy")
  speed?: number;                   // Speech speed 0.5–2.0 (default: 1.0)
  format?: "mp3" | "wav" | "ogg" | "flac";  // Output format (default: "mp3")
  model?: string;                   // Model override (default: "tts-1")
  provider?: string;                // Force specific provider (e.g., "openai", "elevenlabs")
}
```

#### `STTConfig`

```typescript
interface STTConfig {
  language?: string;                // Language code (e.g., "en", "es")
  diarize?: boolean;                // Enable speaker diarization (default: false)
  model?: string;                   // Model override (default: "whisper-1")
  provider?: string;                // Force specific provider (e.g., "openai", "deepgram")
}
```

#### `DiarizeConfig`

```typescript
interface DiarizeConfig {
  language?: string;                // Language code
  model?: string;                   // Model override (default: "pyannote")
  provider?: string;                // Force specific provider (e.g., "deepgram")
}
```

#### `IsolateConfig`

```typescript
interface IsolateConfig {
  target: "vocals" | "instruments" | "drums" | "bass";  // Stem to isolate
  model?: string;                   // Model override (default: "demucs")
  provider?: string;                // Force specific provider (e.g., "replicate")
}
```

#### `MusicConfig`

```typescript
interface MusicConfig {
  prompt: string;                   // Text description of music to generate
  duration?: number;                // Duration in seconds (default: 30)
  instrumental?: boolean;           // Instrumental only (default: true)
  style?: string;                   // Musical style (e.g., "pop", "rock", "classical")
  tempo?: number;                   // BPM tempo (e.g., 120)
  format?: "mp3" | "wav" | "ogg" | "flac";  // Output format (default: "mp3")
  model?: string;                   // Model override (default: "music-gen")
  provider?: string;                // Force specific provider
}
```

#### `SoundEffectConfig`

```typescript
interface SoundEffectConfig {
  prompt: string;                   // Text description of the sound effect
  duration?: number;                // Duration in seconds (default: 5)
  format?: "mp3" | "wav" | "ogg" | "flac";  // Output format (default: "mp3")
  model?: string;                   // Model override (default: "sfx-gen")
  provider?: string;                // Force specific provider
}
```

### `TranscribeStream` (Real-time STT)

WebSocket-based streaming transcription for real-time audio. Supports Deepgram with interim results, word-level timings, and speaker diarization.

```typescript
class TranscribeStream extends EventEmitter {
  constructor(options: TranscribeStreamOptions);

  start(request: TranscribeStreamRequest): Promise<void>;
  sendAudio(data: Buffer): void;
  close(): Promise<TranscribeStreamResult>;

  on(event: "event", listener: (event: TranscribeStreamEvent) => void): this;
}
```

#### `TranscribeStreamRequest`

```typescript
interface TranscribeStreamRequest {
  source: {
    kind: "inline" | "url" | "mic" | "inline-sample";
    encoding?: "linear16" | "opus" | "mulaw";
    sampleRateHz?: number;
    data?: string;                  // Base64-encoded audio for inline mode
    url?: string;                   // Audio URL for url mode
  };
  language?: string;
  model?: string;
  provider?: string;
  interim?: boolean;                // Return interim results (default: false)
  diarize?: boolean;                // Enable speaker diarization (default: false)
  endpointingMs?: number;           // Endpointing sensitivity in ms
}
```

#### `TranscribeStreamEvent`

```typescript
type TranscribeStreamEvent =
  | { kind: "interim"; transcript: string; confidence?: number; words?: WordTiming[] }
  | { kind: "final"; transcript: string; confidence?: number; words?: WordTiming[]; startMs: number; endMs: number; speaker?: string }
  | { kind: "metadata"; languageDetected?: string; sampleRateHz?: number }
  | { kind: "error"; code: string; message: string };
```

#### `ProviderUnsupportedError`

Thrown when a provider does not support streaming STT (e.g., OpenAI Whisper is batch-only).

#### `MicNotAvailableError`

Thrown when microphone capture is requested but `node-record-lpcm16` is not installed.

## Usage Patterns

### Multi-Provider Setup with Routing

```typescript
const ops = createAudioGenOperations(artifactRegistry, storage);
ops.registerProvider("openai", new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }));
ops.registerProvider("deepgram", new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! }));
ops.registerProvider("elevenlabs", new ElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! }));

// Automatically routes: TTS → ElevenLabs prefers audio.tts, STT → Deepgram prefers audio.stt
// Use `provider` param to override the default routing
```

### Transcription with Diarization

```typescript
const result = await ops.speechToText("meeting-audio", {
  language: "en",
  diarize: true,
  model: "whisper-1",
});

const segments = JSON.parse(
  (await storage.get(result.id)).data.toString()
);
// segments = [
//   { speaker: "Speaker 1", text: "...", start: 0.0, end: 2.5, confidence: 0.97 },
//   { speaker: "Speaker 2", text: "...", start: 3.0, end: 5.8, confidence: 0.94 },
// ]
```

### Dedicated Diarization with Fallback

```typescript
// If a dedicated diarization provider exists, uses it.
// Falls back to STT provider with diarize: true if not available.
const result = await ops.diarize("meeting-audio", {
  language: "en",
  model: "pyannote",
});

console.log(result.metadata.speakers); // 3
for (const segment of result.metadata.segments) {
  console.log(`${segment.speaker}: ${segment.text} (${segment.confidence})`);
}
```

### Source Separation (Audio Stems)

```typescript
const vocals = await ops.isolate("song-123", { target: "vocals" });
const drums = await ops.isolate("song-123", { target: "drums" });
const bass = await ops.isolate("song-123", { target: "bass" });
const instruments = await ops.isolate("song-123", { target: "instruments" });
```

### Music Generation

```typescript
const music = await ops.generateMusic({
  prompt: "Upbeat electronic pop with a driving beat and synth melody",
  duration: 60,
  instrumental: false,
  style: "electronic-pop",
  tempo: 128,
  format: "mp3",
  provider: "elevenlabs",  // optional provider override
});
```

### Sound Effects

```typescript
const sfx = await ops.generateSoundEffect({
  prompt: "Heavy wooden door creaking open slowly",
  duration: 3,
  format: "mp3",
});
```

### Real-time STT Streaming

```typescript
import { TranscribeStream, ProviderUnsupportedError } from "@reaatech/media-pipeline-mcp-audio-gen";

const ts = new TranscribeStream({ apiKey: process.env.DEEPGRAM_API_KEY! });

// Listen for streaming events
ts.on("event", (event) => {
  if (event.kind === "interim") {
    console.log("Partial:", event.transcript);
  } else if (event.kind === "final") {
    console.log("Final:", event.transcript, `(${event.speaker ?? "unknown"})`);
  } else if (event.kind === "error") {
    console.error(event.code, event.message);
  }
});

// Stream from URL
await ts.start({
  source: { kind: "url", url: "https://example.com/live-audio" },
  language: "en",
  interim: true,
  diarize: true,
  endpointingMs: 800,
});

const result = await ts.close();
console.log("Full transcript:", result.transcript);
console.log("Duration:", result.durationMs, "ms");
console.log("Audio bytes:", result.bytes);
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and interfaces
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — TTS/STT via OpenAI
- [`@reaatech/media-pipeline-mcp-elevenlabs`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-elevenlabs) — TTS via ElevenLabs
- [`@reaatech/media-pipeline-mcp-deepgram`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram) — STT/diarization via Deepgram

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
