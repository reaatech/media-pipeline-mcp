# @reaatech/media-pipeline-mcp-stability

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-stability.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Stability AI provider for the media pipeline framework. Supports image generation using SD3, SDXL, and SD1.5 models via the Stable Image v2beta API.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-stability
# or
pnpm add @reaatech/media-pipeline-mcp-stability
```

## Quick Start

```typescript
import { StabilityProvider } from "@reaatech/media-pipeline-mcp-stability";

const provider = new StabilityProvider({ apiKey: process.env.STABILITY_API_KEY! });

const result = await provider.execute("image.generate", {
  params: {
    prompt: "A serene mountain lake at dawn, professional photography",
    negative_prompt: "blurry, low quality, distorted",
  },
  config: {
    model: "sd3",
    width: 1024,
    height: 1024,
    seed: 42,
    steps: 30,
    cfg_scale: 7.0,
  },
});

console.log(result.metadata.model); // "sd3"
console.log(result.costUsd); // 0.007
```

## Supported Operations

| Operation | Model | Description |
|-----------|-------|-------------|
| `image.generate` | SD3 / SDXL / SD1.5 | Text-to-image with full parameter control |

## Configuration Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | `string` | `"sd3"` | Model: `sd3`, `sd3-turbo`, `core`, `ultra` |
| `width` | `number` | `1024` | Image width (must match model constraints) |
| `height` | `number` | `1024` | Image height (must match model constraints) |
| `seed` | `number` | — | Random seed for reproducible output |
| `steps` | `number` | — | Diffusion steps |
| `cfg_scale` | `number` | — | Classifier-free guidance scale |
| `negative_prompt` | `string` | — | Text describing what to avoid |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `image.generate` | $0.007 / image |

## Configuration

```typescript
interface StabilityConfig {
  apiKey: string;
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
