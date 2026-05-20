# @reaatech/media-pipeline-mcp-fal

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-fal.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Fal.ai provider for the media pipeline framework. Supports image generation (Fast Flux Pro), upscaling, background removal, video generation, and image-to-video via the fal.ai API.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-fal
# or
pnpm add @reaatech/media-pipeline-mcp-fal
```

## Quick Start

```typescript
import { FalProvider } from "@reaatech/media-pipeline-mcp-fal";

const provider = new FalProvider({ apiKey: process.env.FAL_API_KEY! });

const result = await provider.execute("image.generate", {
  params: { prompt: "A photorealistic portrait of a cat wearing a spacesuit" },
  config: {
    model: "fast-flux-pro",
    aspect_ratio: "1:1",
    guidance_scale: 7.5,
    inference_steps: 28,
    safety_checker: true,
  },
});

console.log(result.metadata.width, result.metadata.height); // 1024, 1024
```

## Supported Operations

| Operation | Model | Description |
|-----------|-------|-------------|
| `image.generate` | Fast Flux Pro | Text-to-image with inference config control |
| `image.upscale` | Real-ESRGAN | Image upscaling via fal |
| `image.remove_background` | — | Background removal via fal |
| `video.generate` | Kling Video | Text-to-video generation |
| `video.image_to_video` | Kling I2V | Image-to-video animation |

## Aspect Ratio Mapping

| Ratio | Dimensions |
|-------|-----------|
| `1:1` | 1024 × 1024 |
| `16:9` | 1360 × 768 |
| `9:16` | 768 × 1360 |
| `4:3` | 1152 × 896 |
| `3:4` | 896 × 1152 |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `image.generate` | $0.008 |
| `image.upscale` | $0.004 |
| `image.remove_background` | $0.002 |
| `video.generate` | $0.12 |
| `video.image_to_video` | $0.10 |

## Configuration

```typescript
interface FalProviderConfig {
  apiKey: string;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
