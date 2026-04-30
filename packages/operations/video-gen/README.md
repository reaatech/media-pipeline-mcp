# @reaatech/media-pipeline-mcp-video-gen

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-video-gen.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-video-gen)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Video generation operations including text-to-video, image-to-video (provider delegation), and local video processing (frame extraction, audio extraction) using ffmpeg.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-video-gen
# or
pnpm add @reaatech/media-pipeline-mcp-video-gen
```

## Feature Overview

- **Text-to-video** — generate videos from text prompts via provider delegation (Kling)
- **Image-to-video** — animate still images into videos via provider delegation
- **Frame extraction** — extract frames at configurable intervals or specific timestamps via ffmpeg
- **Audio extraction** — extract audio tracks from video files as AAC via ffmpeg

## Quick Start

```typescript
import { createVideoGenOperations } from "@reaatech/media-pipeline-mcp-video-gen";

const ops = createVideoGenOperations();

// Extract frames from a video every 2 seconds
const frames = await ops.extractFrames({
  artifact_id: "video-123",
  interval: 2,
});

// Extract audio from a video
const audio = await ops.extractAudio({
  artifact_id: "video-123",
  format: "mp3",
});

// Generate a video from text (requires provider)
const video = await ops.generate({
  prompt: "A drone flythrough of a canyon at golden hour",
  duration: 5,
  aspect_ratio: "16:9",
  style: "cinematic",
});
```

## Supported Operations

| Operation | Method | Description |
|-----------|--------|-------------|
| `generate` | Provider delegation | Text-to-video generation |
| `imageToVideo` | Provider delegation | Animate a still image into video |
| `extractFrames` | ffmpeg (local) | Extract frames with interval or timestamps |
| `extractAudio` | ffmpeg (local) | Extract audio track as AAC/MP3/WAV |

## API Reference

### `createVideoGenOperations`

```typescript
function createVideoGenOperations(): VideoGenOperations;
```

### `VideoGenOperations`

```typescript
class VideoGenOperations {
  setProviders(providers: Provider[]): void;

  generate(config: VideoGenerateConfig): Promise<Artifact>;
  imageToVideo(config: ImageToVideoConfig): Promise<Artifact>;
  extractFrames(config: ExtractFramesConfig): Promise<Artifact>;
  extractAudio(config: ExtractAudioConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `VideoGenerateConfig`

```typescript
interface VideoGenerateConfig {
  prompt: string;
  duration?: number;
  aspect_ratio?: string;
  style?: string;
}
```

#### `ImageToVideoConfig`

```typescript
interface ImageToVideoConfig {
  artifact_id: string;
  motion_prompt?: string;
  duration?: number;
}
```

#### `ExtractFramesConfig`

```typescript
interface ExtractFramesConfig {
  artifact_id: string;
  interval?: number;         // Seconds between frames
  timestamps?: number[];     // Specific timestamps in seconds
}
```

#### `ExtractAudioConfig`

```typescript
interface ExtractAudioConfig {
  artifact_id: string;
  format?: "mp3" | "wav" | "aac";
}
```

## Usage Patterns

### Frame Extraction by Interval

```typescript
const frames = await ops.extractFrames({
  artifact_id: "video-123",
  interval: 5, // Extract every 5 seconds
});

console.log(frames.metadata.frameCount); // 12
console.log(frames.metadata.frameTimestamps); // [0, 5, 10, ..., 55]
// Returns an array of image artifacts
```

### Frame Extraction at Specific Timestamps

```typescript
const frames = await ops.extractFrames({
  artifact_id: "video-123",
  timestamps: [3.5, 12.0, 27.8, 45.2],
});

// Each frame artifact includes:
//   metadata.frameIndex, metadata.timestamp, metadata.width, metadata.height
```

### Extract Audio Track

```typescript
const audio = await ops.extractAudio({
  artifact_id: "video-123",
  format: "aac",
});

console.log(audio.mimeType); // "audio/aac"
console.log(audio.metadata.sampleRate); // 44100
console.log(audio.metadata.channels); // 2
```

### Provider Delegation for Generation

```typescript
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const ops = createVideoGenOperations();
ops.setProviders([
  new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! }),
]);

const video = await ops.generate({
  prompt: "Timelapse of a flower blooming in a sunlit garden",
  duration: 10,
  aspect_ratio: "16:9",
});

console.log(video.metadata.provider); // "replicate"
console.log(video.metadata.cost); // 0.10
```

## Requirements

ffmpeg must be installed locally for `extractFrames` and `extractAudio`:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
apt-get install ffmpeg

# Windows
choco install ffmpeg
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
