# @reaatech/media-pipeline-mcp-fal

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-fal.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Fal.ai provider for the media pipeline framework. Supports image generation (Fast Flux Pro), upscaling (Real-ESRGAN), background removal, video generation (Kling Video), and image-to-video animation via the fal.ai API. Features native webhook support with HMAC signatures and streaming queue events for long-running operations.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-fal
# or
pnpm add @reaatech/media-pipeline-mcp-fal
```

## Feature Overview

- Image generation with Fast Flux Pro (configurable inference steps, guidance scale)
- Image upscaling with Real-ESRGAN (2x/4x scale, optional face enhancement)
- Background removal with dedicated fal model
- Text-to-video generation with Kling Video (duration, aspect ratio, FPS control)
- Image-to-video animation with Kling I2V
- Streaming support for all operations via fal SDK queue events (`supportsStreaming`)
- Webhook support for async completion notifications (`supportsWebhooks`)
- Aspect ratio mapping for common social media dimensions

## Quick Start

```typescript
import { FalProvider } from "@reaatech/media-pipeline-mcp-fal";

const provider = new FalProvider({ apiKey: process.env.FAL_API_KEY! });

// Generate an image
const result = await provider.execute({
  operation: "image.generate",
  params: {
    prompt: "A photorealistic portrait of a cat wearing a spacesuit",
    aspect_ratio: "1:1",
  },
  config: {},
});
console.log(result.metadata.model); // "fal-ai/fast-flux-pro"

// Generate a video from text
const video = await provider.execute({
  operation: "video.generate",
  params: {
    prompt: "A drone flythrough of a futuristic city at golden hour",
    duration: 5,
    aspect_ratio: "16:9",
  },
  config: {},
});

// Upscale an existing image
const upscaled = await provider.execute({
  operation: "image.upscale",
  params: { image_data: imageBuffer, scale: 4 },
  config: {},
});
```

## Supported Operations

| Operation | Default Model | Description | Output |
|-----------|---------------|-------------|--------|
| `image.generate` | `fal-ai/fast-flux-pro` | Text-to-image with inference config control | PNG image buffer |
| `image.upscale` | `fal-ai/real-esrgan` | Image upscaling with configurable scale factor | Upscaled image buffer |
| `image.remove_background` | `fal-ai/background-removal` | Background removal | Transparent PNG buffer |
| `video.generate` | `fal-ai/kling-video/v1/prod/text-to-video` | Text-to-video generation | MP4 video buffer |
| `video.image_to_video` | `fal-ai/kling-video/v1/prod/image-to-video` | Image-to-video animation | MP4 video buffer |

## Configuration Parameters

### `image.generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Text description of the desired image |
| `aspect_ratio` | `string` | `"1:1"` | One of `1:1`, `16:9`, `9:16`, `4:3`, `3:4` |

### `image.upscale`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `scale` | `number` | `4` | Scale factor (2 or 4) |

### `image.remove_background`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |

### `video.generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Text description of the desired video |
| `duration` | `number` | `5` | Video duration in seconds |
| `aspect_ratio` | `string` | `"16:9"` | Video aspect ratio (`16:9`, `9:16`, `1:1`) |

### `video.image_to_video`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `image_data` | `Buffer` | *required* | Input image as raw buffer |
| `motion_prompt` | `string` | — | Description of desired motion |
| `duration` | `number` | `5` | Video duration in seconds |

## API Reference

### `FalProvider`

```typescript
class FalProvider extends MediaProvider {
  constructor(config: FalProviderConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `FalProviderConfig`

```typescript
interface FalProviderConfig {
  apiKey: string;
  models?: {
    imageGenerate?: string;       // Default: "fal-ai/fast-flux-pro"
    upscale?: string;             // Default: "fal-ai/real-esrgan"
    removeBackground?: string;    // Default: "fal-ai/background-removal"
    videoGenerate?: string;       // Default: "fal-ai/kling-video/v1/prod/text-to-video"
    videoImageToVideo?: string;   // Default: "fal-ai/kling-video/v1/prod/image-to-video"
  };
  pollingInterval?: number;       // Queue polling interval in ms
  timeout?: number;                // Request timeout in ms
}
```

### Factory Function

```typescript
import { defineFalProvider } from "@reaatech/media-pipeline-mcp-fal";

const provider = defineFalProvider({ apiKey: process.env.FAL_API_KEY! });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by querying the fal balance endpoint |
| `estimateCost(input)` | `CostEstimate` | Returns fixed per-operation cost from pricing table |
| `execute(input)` | `ProviderOutput` | Submits to fal queue via `fal.subscribe()`, polls for completion, fetches output |

### Non-Retryable Errors

The provider classifies these errors as non-retryable: authentication failed, invalid API key, permission denied, model not found, insufficient credits.

## Cost Estimation

| Operation | Model | Cost |
|-----------|-------|------|
| `image.generate` | Fast Flux Pro | $0.008 / image |
| `image.upscale` | Real-ESRGAN | $0.004 / image |
| `image.remove_background` | Background Removal | $0.002 / image |
| `video.generate` | Kling Video (T2V) | $0.12 / video |
| `video.image_to_video` | Kling I2V | $0.10 / video |

Costs are fixed per-operation and retrieved from `pricing.json`. No per-step or per-second multipliers are applied.

## Aspect Ratio Mapping

| Ratio | Dimensions |
|-------|-----------|
| `1:1` | 1024 × 1024 |
| `16:9` | 1920 × 1080 |
| `9:16` | 1080 × 1920 |
| `4:3` | 1024 × 768 |
| `3:4` | 768 × 1024 |

## Cache Configuration

The provider exposes `static cacheConfig` with deterministic and non-deterministic parameters.

**Deterministic parameters:** `prompt`, `negative_prompt`, `model`, `seed`, `image_url`, `image_size`, `num_inference_steps`, `guidance_scale`, `duration`, `aspect_ratio`

**Non-deterministic parameters:** `request_id`, `webhook_url`, `sync_mode`

The `normalize()` function trims and collapses whitespace in prompt strings, and drops webhook/sync fields so that cache keys are based solely on model input parameters.

## Health Check

The health check sends a GET request to `https://api.fal.ai/v1/balance` using the API key as a Bearer token. Returns `{ healthy: true, latency: <ms> }` on success, or `{ healthy: false, error: "HTTP <status>: <message>" }` on failure.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Alternative image generation provider (SD3)
- [`@reaatech/media-pipeline-mcp-replicate`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate) — Alternative video generation provider (Kling on Replicate)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
