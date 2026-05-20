# @reaatech/media-pipeline-mcp-replicate

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-replicate.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Replicate provider for the media pipeline framework. Supports image upscaling (Real-ESRGAN), background removal (BRIA RMBG), inpainting (Stable Inpainting), audio isolation (Demucs), video generation (Kling), and image-to-video (Kling).

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-replicate
# or
pnpm add @reaatech/media-pipeline-mcp-replicate
```

## Quick Start

```typescript
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const provider = new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! });

// Upscale an image
const upscaled = await provider.execute("image.upscale", {
  params: { artifact_id: "img-123" },
  config: { scale: 4 },
});

// Remove background
const noBg = await provider.execute("image.remove_background", {
  params: { artifact_id: "img-123" },
  config: { output_format: "png" },
});

// Generate a video
const video = await provider.execute("video.generate", {
  params: { prompt: "A drone flythrough of a tropical island" },
  config: { duration: 5, aspect_ratio: "16:9" },
});
```

## Supported Operations

| Operation | Model | Description |
|-----------|-------|-------------|
| `image.upscale` | Real-ESRGAN | Upscale images with configurable scale factor (2x/4x/8x) |
| `image.remove_background` | BRIA RMBG 1.4 | Background removal with configurable output format |
| `image.inpaint` | Stable Inpainting | Inpaint/edit image regions with optional mask |
| `audio.isolate` | Demucs | Source separation (vocals, instruments, drums, bass) |
| `video.generate` | Kling Video | Text-to-video generation |
| `video.image_to_video` | Kling I2V | Image-to-video animation |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `image.upscale` | $0.005 |
| `image.remove_background` | $0.003 |
| `image.inpaint` | $0.01 |
| `audio.isolate` | $0.01 |
| `video.generate` | $0.10 |
| `video.image_to_video` | $0.08 |

## Configuration

```typescript
interface ReplicateProviderConfig {
  apiKey: string;
  modelOverrides?: Record<string, string>;
  pollingIntervalMs?: number;
  timeoutMs?: number;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
