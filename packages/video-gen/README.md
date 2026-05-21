# @reaatech/media-pipeline-mcp-video-gen

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-video-gen.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-video-gen)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Video generation and processing — text-to-video and image-to-video via provider delegation, plus local ffmpeg-based frame extraction, audio extraction, subtitle generation with burn-in, loudness normalization, and video cropping.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-video-gen
# or
pnpm add @reaatech/media-pipeline-mcp-video-gen
```

### Requirements

ffmpeg must be installed for local video processing operations (`extractFrames`, `extractAudio`, `FfmpegWrapper`, and subtitle burn-in):

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
apt-get install ffmpeg

# Windows (Chocolatey)
choco install ffmpeg
```

## Feature Overview

- **Text-to-video** — generate videos from text prompts via provider delegation (Kling, etc.)
- **Image-to-video** — animate still images into videos via provider delegation
- **Frame extraction** — extract frames at configurable intervals or specific timestamps via ffmpeg
- **Audio extraction** — extract audio tracks from video files as AAC via ffmpeg
- **Subtitle pipeline** — end-to-end subtitle generation (STT → segment processing → encoding → optional burn-in) with SRT/VTT/ASS format support
- **Subtitle burn-in** — render ASS subtitles into video with configurable fonts, colors, and positioning
- **Subtitle translation** — translate generated subtitles to a target language via LLM
- **Loudness measurement & normalization** — measure audio loudness (EBU R128) and normalize to a target loudness level
- **Video cropping** — crop videos to specified dimensions via ffmpeg
- **Multi-provider routing** — operation-based lookup with preferred provider selection

## Quick Start

```typescript
import { createVideoGenOperations } from "@reaatech/media-pipeline-mcp-video-gen";
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const ops = createVideoGenOperations(artifactRegistry, storage);

// Register a provider for video generation
ops.registerProvider("replicate", new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
}));

// Local operations (ffmpeg-based, no provider needed)

// Extract frames every 2 seconds
const frames = await ops.extractFrames({
  artifactId: "video-123",
  interval: 60,     // Extract every 60th frame (~1 per second at 60fps)
});

// Extract audio track
const audio = await ops.extractAudio({
  artifactId: "video-123",
});

// Provider-delegated operations

// Generate video from text prompt
const video = await ops.generate({
  prompt: "A drone flythrough of a canyon at golden hour",
  duration: 5,
  aspectRatio: "16:9",
  style: "cinematic",
});

// Animate an image into a video
const animated = await ops.imageToVideo({
  artifactId: "img-123",
  motionPrompt: "Gentle camera pan and zoom",
  duration: 5,
});
```

## API Reference

### `createVideoGenOperations(artifactRegistry, storage)`

Factory function that creates a `VideoGenOperations` instance.

```typescript
function createVideoGenOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): VideoGenOperations;
```

### `VideoGenOperations`

Main class providing video generation and local processing capabilities.

```typescript
class VideoGenOperations {
  constructor(artifactRegistry: ArtifactRegistry, storage: ArtifactStore);

  registerProvider(name: string, provider: MediaProvider): void;

  generate(config: VideoGenerateConfig): Promise<Artifact>;
  imageToVideo(config: ImageToVideoConfig): Promise<Artifact>;
  extractFrames(config: ExtractFramesConfig): Promise<Artifact[]>;
  extractAudio(config: ExtractAudioConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `VideoGenerateConfig`

```typescript
interface VideoGenerateConfig {
  prompt: string;                          // Text description of the video
  duration?: number;                       // Duration in seconds (default: 5)
  aspectRatio?: "16:9" | "9:16" | "1:1" | "4:3";  // Aspect ratio (default: "16:9")
  style?: string;                          // Style descriptor (e.g., "cinematic")
  provider?: string;                       // Force specific provider
}
```

#### `ImageToVideoConfig`

```typescript
interface ImageToVideoConfig {
  artifactId: string;                      // ID of the source image
  motionPrompt?: string;                   // Description of motion to apply
  duration?: number;                       // Duration in seconds (default: 5)
  provider?: string;                       // Force specific provider
}
```

#### `ExtractFramesConfig`

```typescript
interface ExtractFramesConfig {
  artifactId: string;                      // ID of the video
  interval?: number;                       // Extract every Nth frame (default: fps, i.e., 1 per sec)
  timestamps?: number[];                   // Specific timestamps in seconds to extract at
}
```

#### `ExtractAudioConfig`

```typescript
interface ExtractAudioConfig {
  artifactId: string;                      // ID of the video
}
```

### `FfmpegWrapper`

Low-level ffmpeg wrapper providing direct access to ffmpeg capabilities. All methods are static.

```typescript
class FfmpegWrapper {
  static isAvailable(): Promise<boolean>;
  static exec(args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  static extractAudio(inputPath: string, outputPath: string, format?: string): Promise<void>;
  static burnSubtitles(inputPath: string, subtitlePath: string, outputPath: string, options?: BurnInOptions): Promise<void>;
  static measureLoudness(inputPath: string): Promise<LoudnessMeasurement>;
  static normalizeLoudness(inputPath: string, target: LoudnessTarget, measured: LoudnessMeasurement, outputPath: string): Promise<void>;
  static cropVideo(inputPath: string, outputPath: string, width: number, height: number, x?: number, y?: number): Promise<void>;
}
```

#### `BurnInOptions`

```typescript
interface BurnInOptions {
  font?: string;                           // Font name (default: "Arial")
  fontSize?: number;                       // Font size in px (default: 24)
  fontColor?: string;                      // Font color hex (default: "FFFFFF")
  outline?: { color: string; widthPx: number };  // Text outline
  position?: "top" | "middle" | "bottom";  // Screen position (default: "bottom")
  marginPx?: number;                       // Margin from edge in px (default: 10)
  background?: { color: string; opacity: number };  // Subtitle background box
}
```

#### `LoudnessMeasurement`

```typescript
interface LoudnessMeasurement {
  iLufs: number;                           // Integrated loudness in LUFS
  lra: number;                             // Loudness range
  tpDb: number;                            // True peak in dB
}
```

#### `LoudnessTarget`

```typescript
interface LoudnessTarget {
  iLufs: number;                           // Target integrated loudness (LUFS)
  lra: number;                             // Target loudness range
  tpDb: number;                            // Target true peak (dB)
}
```

### `SubtitlePipeline`

End-to-end subtitle generation pipeline that extracts audio, runs STT, post-processes segments, optionally translates, and burns subtitles into the video.

```typescript
class SubtitlePipeline {
  constructor(providers: Map<string, MediaProvider>, storage: ArtifactStore);

  generate(config: SubtitleConfig): Promise<SubtitleOutput>;
}
```

#### `SubtitleConfig`

```typescript
interface SubtitleConfig {
  artifactId: string;                      // ID of the video artifact
  language?: string;                       // Language code (default: "en")
  format?: "srt" | "vtt" | "ass";          // Subtitle format (default: "srt")
  sttProvider?: string;                    // STT provider override
  sttModel?: string;                       // STT model override
  burnIn?: BurnInOptions;                  // Burn subtitles into video
  diarize?: boolean;                       // Enable speaker diarization (default: false)
  translateTo?: string;                    // Target language for translation
}
```

#### `SubtitleOutput`

```typescript
interface SubtitleOutput {
  subtitleArtifactId: string;              // Artifact ID of the generated subtitle text
  burnedArtifactId?: string;               // Artifact ID of the video with burned-in subtitles
  language: string;                        // Language used
  segments: SubtitleSegment[];             // All parsed subtitle segments
  totalCostUsd: number;                    // Total cost of the operation
}
```

#### `SubtitleSegment`

```typescript
interface SubtitleSegment {
  index: number;                           // Subtitle index (1-based)
  startMs: number;                         // Start time in milliseconds
  endMs: number;                           // End time in milliseconds
  text: string;                            // Subtitle text (may be multi-line)
  speaker?: string;                        // Identified speaker (if diarized)
  confidence?: number;                     // Segment confidence score
}
```

### `createSubtitlePipeline(providers, storage)`

```typescript
function createSubtitlePipeline(
  providers: Map<string, MediaProvider>,
  storage: ArtifactStore,
): SubtitlePipeline;
```

## Usage Patterns

### Frame Extraction by Interval

```typescript
// Extract frames at ~1 frame per second (defaults to interval = fps)
const frames = await ops.extractFrames({
  artifactId: "video-123",
});

// Extract every 5 seconds (at 30fps: interval = 150)
const every5s = await ops.extractFrames({
  artifactId: "video-123",
  interval: 150,
});

console.log(frames.length);  // number of frames extracted
for (const frame of frames) {
  console.log(frame.metadata.timestamp);   // seconds
  console.log(frame.metadata.frameIndex);  // 0-based
  console.log(frame.metadata.width, frame.metadata.height);
}
```

### Frame Extraction at Specific Timestamps

```typescript
const frames = await ops.extractFrames({
  artifactId: "video-123",
  timestamps: [3.5, 12.0, 27.8, 45.2],
});

// Returns exactly 4 frames at the specified times
```

### Extract Audio Track

```typescript
const audio = await ops.extractAudio({
  artifactId: "video-123",
});

console.log(audio.mimeType);            // "audio/aac"
console.log(audio.metadata.sampleRate); // 48000
console.log(audio.metadata.channels);   // 2
console.log(audio.metadata.codec);      // "aac"
console.log(audio.metadata.duration);   // seconds from source video
```

### Subtitle Generation Pipeline

```typescript
import { createSubtitlePipeline } from "@reaatech/media-pipeline-mcp-video-gen";

const pipeline = createSubtitlePipeline(providerMap, storage);

// Generate SRT subtitles
const result = await pipeline.generate({
  artifactId: "video-123",
  language: "en",
  format: "srt",
  diarize: true,
});

console.log(result.subtitleArtifactId);   // artifact ID for subtitle text
console.log(result.segments.length);      // number of subtitle segments
for (const seg of result.segments.slice(0, 3)) {
  console.log(`[${seg.startMs}ms → ${seg.endMs}ms] ${seg.speaker ?? "Narrator"}: ${seg.text}`);
}
```

### Subtitle Burn-in with Custom Styling

```typescript
const result = await pipeline.generate({
  artifactId: "video-123",
  format: "ass",
  language: "en",
  burnIn: {
    font: "Helvetica",
    fontSize: 28,
    fontColor: "#FFFFFF",
    outline: { color: "#000000", widthPx: 3 },
    position: "bottom",
    marginPx: 20,
    background: { color: "#000000", opacity: 0.4 },
  },
});

console.log(result.burnedArtifactId);  // artifact ID for video with burned subtitles
```

### Subtitle Translation

```typescript
const result = await pipeline.generate({
  artifactId: "video-123",
  language: "en",
  format: "srt",
  translateTo: "es",  // Translate to Spanish
});

console.log(result.language);  // "es"
// Segments contain the translated text
```

### Provider Delegation for Video Generation

```typescript
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";
import { FalProvider } from "@reaatech/media-pipeline-mcp-fal";

const ops = createVideoGenOperations(artifactRegistry, storage);
ops.registerProvider("replicate", new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! }));
ops.registerProvider("fal", new FalProvider({ apiKey: process.env.FAL_API_KEY! }));

// Text-to-video — routes to first provider supporting "video.generate"
const video = await ops.generate({
  prompt: "Timelapse of a flower blooming in a sunlit garden",
  duration: 10,
  aspectRatio: "16:9",
  style: "cinematic",
});

console.log(video.metadata.provider);     // provider name
console.log(video.metadata.costUsd);      // cost in USD
console.log(video.metadata.duration);     // seconds
console.log(video.metadata.fps);          // 30
console.log(video.metadata.codec);        // "h264"

// Image-to-video
const animated = await ops.imageToVideo({
  artifactId: "img-123",
  motionPrompt: "Gentle camera drift left to right",
  duration: 8,
  provider: "fal",  // force specific provider
});
```

### Direct ffmpeg Usage

```typescript
import { FfmpegWrapper } from "@reaatech/media-pipeline-mcp-video-gen";

// Check availability
const available = await FfmpegWrapper.isAvailable();
if (!available) throw new Error("ffmpeg is required");

// Execute arbitrary ffmpeg commands
await FfmpegWrapper.exec([
  "-i", "/tmp/input.mp4",
  "-vf", "scale=1280:720",
  "-y", "/tmp/output.mp4",
]);

// Extract audio in specific format
await FfmpegWrapper.extractAudio("/tmp/input.mp4", "/tmp/audio.aac", "aac");
await FfmpegWrapper.extractAudio("/tmp/input.mp4", "/tmp/audio.mp3", "mp3");

// Measure loudness (EBU R128)
const loudness = await FfmpegWrapper.measureLoudness("/tmp/audio.wav");
console.log(loudness.iLufs, loudness.lra, loudness.tpDb);

// Normalize to broadcast standard
const target: LoudnessTarget = { iLufs: -23, lra: 7, tpDb: -2 };
await FfmpegWrapper.normalizeLoudness("/tmp/input.wav", target, loudness, "/tmp/normalized.wav");

// Crop a video
await FfmpegWrapper.cropVideo("/tmp/input.mp4", "/tmp/cropped.mp4", 1280, 720, 100, 50);
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and interfaces
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface and router
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-replicate`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate) — Video generation provider
- [`@reaatech/media-pipeline-mcp-fal`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal) — Video generation provider
- [`@reaatech/media-pipeline-mcp-audio-gen`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-audio-gen) — Audio operations (used by subtitle pipeline)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
