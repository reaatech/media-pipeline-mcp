# @reaatech/media-pipeline-mcp-audio-gen

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-audio-gen.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-audio-gen)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Audio generation operations including text-to-speech, speech-to-text, speaker diarization, source separation, music generation, and sound effects — all via provider delegation.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-audio-gen
# or
pnpm add @reaatech/media-pipeline-mcp-audio-gen
```

## Quick Start

```typescript
import { createAudioGenOperations } from "@reaatech/media-pipeline-mcp-audio-gen";

const ops = createAudioGenOperations();

// Text to speech
const speech = await ops.textToSpeech({
  text: "Welcome to the media pipeline.",
  voice: "alloy",
  speed: 1.0,
  format: "mp3",
});

// Transcribe audio
const transcript = await ops.speechToText({
  artifact_id: "audio-123",
  language: "en",
});

// Identify speakers
const speakers = await ops.diarize({
  artifact_id: "meeting-456",
  num_speakers: 3,
});
```

## Supported Operations

| Operation | Description |
|-----------|-------------|
| `textToSpeech` | Convert text to speech with voice/speed/format options |
| `speechToText` | Transcribe audio with optional language and diarization |
| `diarize` | Identify and label speakers in audio |
| `isolate` | Separate audio into stems (vocals, instruments, drums, bass) |
| `generateMusic` | Generate music from a text prompt with style/tempo control |
| `generateSoundEffect` | Generate sound effects from a text prompt |

## API Reference

### `createAudioGenOperations`

```typescript
function createAudioGenOperations(): AudioGenOperations;
```

### `AudioGenOperations`

```typescript
class AudioGenOperations {
  setProviders(providers: Provider[]): void;

  textToSpeech(config: TTSConfig): Promise<Artifact>;
  speechToText(config: STTConfig): Promise<Artifact>;
  diarize(config: DiarizeConfig): Promise<Artifact>;
  isolate(config: IsolateConfig): Promise<Artifact>;
  generateMusic(config: MusicConfig): Promise<Artifact>;
  generateSoundEffect(config: SoundEffectConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `TTSConfig`

```typescript
interface TTSConfig {
  text: string;
  voice?: string;
  speed?: number;
  output_format?: "mp3" | "wav" | "opus";
  model?: string;
}
```

#### `STTConfig`

```typescript
interface STTConfig {
  artifact_id: string;
  language?: string;
  diarize?: boolean;
}
```

#### `DiarizeConfig`

```typescript
interface DiarizeConfig {
  artifact_id: string;
  num_speakers?: number;
}
```

#### `IsolateConfig`

```typescript
interface IsolateConfig {
  artifact_id: string;
  target: "vocals" | "instruments" | "drums" | "bass";
}
```

#### `MusicConfig`

```typescript
interface MusicConfig {
  prompt: string;
  duration?: number;
  instrumental?: boolean;
  style?: string;
  tempo?: number;
  format?: "mp3" | "wav" | "ogg";
}
```

#### `SoundEffectConfig`

```typescript
interface SoundEffectConfig {
  prompt: string;
  duration?: number;
  format?: "mp3" | "wav" | "ogg";
}
```

## Usage Patterns

### Multi-Provider Setup

```typescript
import { OpenAIProvider } from "@reaatech/media-pipeline-mcp-openai";
import { DeepgramProvider } from "@reaatech/media-pipeline-mcp-deepgram";
import { ElevenLabsProvider } from "@reaatech/media-pipeline-mcp-elevenlabs";

const ops = createAudioGenOperations();
ops.setProviders([
  new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  new DeepgramProvider({ apiKey: process.env.DEEPGRAM_API_KEY! }),
  new ElevenLabsProvider({ apiKey: process.env.ELEVENLABS_API_KEY! }),
]);
```

### Transcription with Diarization

```typescript
// Use STT with built-in diarization
const result = await ops.speechToText({
  artifact_id: "meeting-audio",
  language: "en",
  diarize: true,
});

console.log(result.metadata.transcript);
console.log(result.metadata.segments);
// [
//   { speaker: "Speaker 1", text: "...", start: 0.0, end: 2.5 },
//   { speaker: "Speaker 2", text: "...", start: 3.0, end: 5.8 },
// ]
```

### Dedicated Diarization

```typescript
const result = await ops.diarize({
  artifact_id: "meeting-audio",
  num_speakers: 3,
});

console.log(result.metadata.speakerCount); // 3
for (const segment of result.metadata.segments) {
  console.log(`${segment.speaker}: ${segment.text} (${segment.confidence})`);
}
```

### Source Separation

```typescript
const vocals = await ops.isolate({
  artifact_id: "song-123",
  target: "vocals",
});

const drums = await ops.isolate({
  artifact_id: "song-123",
  target: "drums",
});
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
});
```

### Sound Effects

```typescript
const sfx = await ops.generateSoundEffect({
  prompt: "Heavy wooden door creaking open",
  duration: 3,
  format: "wav",
});
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — TTS/STT provider
- [`@reaatech/media-pipeline-mcp-elevenlabs`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-elevenlabs) — TTS provider
- [`@reaatech/media-pipeline-mcp-deepgram`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-deepgram) — STT/diarization provider

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
