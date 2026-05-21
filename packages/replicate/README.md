# @reaatech/media-pipeline-mcp-replicate

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-replicate.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Replicate provider for the media pipeline framework. Supports image upscaling (Real-ESRGAN), background removal (BRIA RMBG 1.4), inpainting (Stable Inpainting), audio source separation (Demucs), text-to-video generation (Kling), and image-to-video animation (Kling I2V). Features native webhook support and streaming progress via prediction polling.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-replicate
# or
pnpm add @reaatech/media-pipeline-mcp-replicate
```

## Feature Overview

- Image upscaling via Real-ESRGAN with configurable scale factor (2x/4x)
- Background removal with BRIA RMBG 1.4
- Inpainting with Stable Inpainting (mask-based region editing)
- Audio source separation with Demucs (vocals, instruments, drums, bass stems)
- Text-to-video generation with Kling Video
- Image-to-video animation with Kling I2V
- Streaming support via prediction log polling (`supportsStreaming`)
- Webhook support for async completion notifications (`supportsWebhooks`)
- Configurable model overrides for all operations
- Automatic URL-to-Buffer conversion for Replicate output URLs

## Quick Start

```typescript
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const provider = new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! });

// Upscale an image
const upscaled = await provider.execute({
  operation: "image.upscale",
  params: { image_data: imageBuffer, scale: 4 },
  config: {},
});

// Remove background
const noBg = await provider.execute({
  operation: "image.remove_background",
  params: { image_data: imageBuffer },
  config: {},
});

// Inpaint a region
const inpainted = await provider.execute({
  operation: "image.inpaint",
  params: {
    image_data: imageBuffer,
    mask_data: maskBuffer,
    prompt: "A modern living room with natural lighting",
    negative_prompt: "blurry, distorted",
  },
  config: {},
});

// Isolate vocals from a song
const vocals = await provider.execute({
  operation: "audio.isolate",
  params: { audio_data: songBuffer, target: "vocals" },
  config: {},
});

// Generate a video from text
const video = await provider.execute({
  operation: "video.generate",
  params: { prompt: "A drone flythrough of a tropical island at sunset", duration: 5, aspect_ratio: "16:9" },
  config: {},
});
```

## Supported Operations

| Operation | Default Model | Description |
|-----------|---------------|-------------|
| `image.upscale` | `nightmareai/real-esrgan` | Upscale images with configurable scale factor |
| `image.remove_background` | `briaai/rmbg-1.4` | Background removal with transparent PNG output |
| `image.inpaint` | `stability-ai/stable-inpainting` | Mask-based region editing/inpainting |
| `audio.isolate` | `cwqkwg/demucs` | Source separation into stems (vocals, instruments, drums, bass) |
| `video.generate` | `kling-video` | Text-to-video generation with duration and aspect ratio control |
| `video.image_to_video` | `kling-i2v` | Image-to-video animation with motion prompt |

## Configuration Parameters

### `image.upscale`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `scale` | `number` | `4` | Scale factor (2 or 4) |

### `image.remove_background`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |

### `image.inpaint`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `mask_data` | `Buffer` | — | Mask image defining the region to inpaint |
| `prompt` | `string` | *required* | Description of desired result |
| `negative_prompt` | `string` | — | Description of what to avoid |

### `audio.isolate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `audio_data` | `Buffer` | *required* | Audio data as raw buffer |
| `target` | `string` | `"vocals"` | Stem to isolate: `vocals`, `instruments`, `drums`, `bass` |

### `video.generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Text description of the desired video |
| `duration` | `number` | `5` | Video duration in seconds |
| `aspect_ratio` | `string` | `"16:9"` | Video aspect ratio |

### `video.image_to_video`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `motion_prompt` | `string` | — | Description of desired motion |
| `duration` | `number` | `5` | Video duration in seconds |

## API Reference

### `ReplicateProvider`

```typescript
class ReplicateProvider extends MediaProvider {
  constructor(config: ReplicateProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `ReplicateProviderConfig`

```typescript
interface ReplicateProviderConfig {
  apiKey: string;
  models?: {
    upscale?: string;             // Default: "nightmareai/real-esrgan"
    removeBackground?: string;    // Default: "briaai/rmbg-1.4"
    inpaint?: string;             // Default: "stability-ai/stable-inpainting"
    isolate?: string;             // Default: "cwqkwg/demucs"
    videoGenerate?: string;       // Default: "kling-video"
    videoImageToVideo?: string;   // Default: "kling-i2v"
  };
  pollingInterval?: number;       // Prediction polling interval in ms
  timeout?: number;                // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const provider = defineReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by fetching `/v1/collections` from the Replicate API |
| `estimateCost(input)` | `CostEstimate` | Returns fixed per-operation cost from pricing table |
| `execute(input)` | `ProviderOutput` | Submits prediction to Replicate, polls for output URL, fetches and returns the result |

### Output Handling

The provider handles multiple output types from Replicate:
- **URL string**: Fetches the URL and returns the response body
- **Buffer / Uint8Array**: Returns directly
- **Plain string**: Returns as `text/plain`
- **Other**: Serializes to JSON and returns

### Non-Retryable Errors

The provider classifies these errors as non-retryable: authentication failed, invalid API key, permission denied, model not found.

## Cost Estimation

| Operation | Model | Cost |
|-----------|-------|------|
| `image.upscale` | Real-ESRGAN | $0.005 / image |
| `image.remove_background` | BRIA RMBG 1.4 | $0.003 / image |
| `image.inpaint` | Stable Inpainting | $0.01 / image |
| `audio.isolate` | Demucs | $0.01 / track |
| `video.generate` | Kling Video | $0.10 / video |
| `video.image_to_video` | Kling I2V | $0.08 / video |

Costs are fixed per-operation rates from `pricing.json`. Actual Replicate billing is based on the underlying model's hardware runtime; these values are estimates for cost-tracking purposes.

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `prompt`, `model_version`, `seed`

**Non-deterministic parameters:** `webhook`, `webhook_url`

The `normalize()` function filters out webhook parameters and trims/collapses whitespace in all string-valued inputs. The narrow set of deterministic params means most image/audio binary inputs are excluded from cache keys — this provider benefits from caching primarily for prompt-based operations (inpaint, video generation).

## Health Check

The health check sends a GET request to `/v1/collections` on the Replicate API using the `Authorization: Bearer <apiKey>` header. Returns `{ healthy: true, latency: <ms> }` on success, or `{ healthy: false, error: "HTTP <status>: <message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-fal`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal) — Alternative video generation provider (Kling on Fal)
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Alternative image generation provider (SD3)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
