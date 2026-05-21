# @reaatech/media-pipeline-mcp-comfyui

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-comfyui.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-comfyui)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Local ComfyUI provider for the media pipeline framework. Supports image generation, image editing, and video generation via custom ComfyUI workflows at zero API cost. Ships with built-in SDXL and Flux workflows and supports loading custom workflows from a directory.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-comfyui
# or
pnpm add @reaatech/media-pipeline-mcp-comfyui
```

## Feature Overview

- **Zero API cost** — all generation runs on your own GPU
- **Built-in workflows** — SDXL text-to-image, SDXL image-to-image, Flux text-to-image, and Stable Video Diffusion image-to-video
- **Custom workflows** — load your own ComfyUI JSON workflows from a directory
- **Workflow registry** — register, list, and retrieve workflows at runtime
- **Poll-based completion** — automatic polling with configurable interval and retention
- **Progress streaming** — per-node progress surfaced during workflow execution
- **Parameters per workflow** — each workflow exposes its own typed input parameter spec

## Quick Start

```typescript
import { ComfyUIProvider } from "@reaatech/media-pipeline-mcp-comfyui";

const provider = new ComfyUIProvider({
  baseUrl: "http://localhost:8188",
  downloadOutputs: true,
});

const result = await provider.execute({
  operation: "image.generate",
  params: {
    prompt: "A majestic dragon flying over a castle at sunset",
    negative_prompt: "blurry, low quality, distorted",
    seed: 42,
    steps: 30,
    cfg: 7,
    width: 1024,
    height: 1024,
  },
  config: {},
});

console.log(result.metadata.workflow); // "sdxl-text2img"
console.log(result.metadata.prompt_id); // "abc123..."
console.log(result.costUsd); // 0
```

Using a specific workflow:

```typescript
const result = await provider.execute({
  operation: "image.generate",
  params: {
    prompt: "A futuristic city skyline, neon lights, cyberpunk",
    seed: 100,
    steps: 20,
    model: "workflow:flux-text2img",
  },
  config: {},
});
```

Loading custom workflows from a directory:

```typescript
const provider = new ComfyUIProvider({
  baseUrl: "http://localhost:8188",
  workflowsDir: "./my-workflows",
});

// Workflows are loaded lazily on first execution
const result = await provider.execute({
  operation: "image.generate",
  params: {
    model: "workflow:custom/my-ip-adapter",
    prompt: "A portrait in the style of Van Gogh",
    image: "https://example.com/reference.png",
  },
  config: {},
});
```

## Supported Operations

| Operation | Built-in Workflow | Description |
|-----------|------------------|-------------|
| `image.generate` | `sdxl-text2img` (default), `flux-text2img` | Text-to-image generation |
| `image.edit` | `sdxl-img2img` | Image-to-image transformation |
| `video.generate` | `svd-img2vid` | Image-to-video (Stable Video Diffusion) |

## Built-in Workflows

| Name | Type | Description |
|------|------|-------------|
| `sdxl-text2img` | Text-to-Image | SDXL generation with full parameter control |
| `sdxl-img2img` | Image-to-Image | SDXL image-to-image with denoise control |
| `flux-text2img` | Text-to-Image | Flux.1-dev text-to-image generation |
| `svd-img2vid` | Image-to-Video | Stable Video Diffusion with motion control |

## Configuration

```typescript
interface ComfyUIConfig {
  baseUrl?: string;          // Default: "http://localhost:8188"
  workflowsDir?: string;     // Directory of custom JSON workflow files
  downloadOutputs?: boolean; // Default: true
  pollIntervalMs?: number;   // Default: 1000
  retentionMs?: number;      // Default: 600000 (10 min)
}
```

## API Reference

### `ComfyUIProvider`

Main provider class extending `MediaProvider`.

| Member | Type | Description |
|--------|------|-------------|
| `supportedOperations` | `string[]` | `['image.generate', 'image.edit', 'video.generate']` |
| `supportsStreaming` | `Set<string>` | Operations that surface per-node progress |
| `supportsWebhooks` | `boolean` | `false` — ComfyUI has no outbound webhook callbacks |
| `healthCheck()` | `Promise<ProviderHealth>` | Checks `/system_stats` endpoint |
| `estimateCost()` | `Promise<CostEstimate>` | Always returns `{ costUsd: 0 }` |
| `execute(input)` | `Promise<ProviderOutput>` | Runs a workflow and returns the output data buffer |
| `registerWorkflow(name, workflow)` | `void` | Register a custom workflow at runtime |
| `getWorkflow(name)` | `ComfyUIWorkflow \| undefined` | Retrieve a workflow by name |
| `listWorkflows()` | `string[]` | List all registered workflow names |
| `loadWorkflowsFromDir()` | `Promise<void>` | Load JSON workflows from `workflowsDir` |

### `createComfyUIProvider(config?)`

Factory function that returns a new `ComfyUIProvider` instance.

### `ComfyUIConfig`

Configuration interface (see Configuration section above).

### `ComfyUIWorkflow`

```typescript
interface ComfyUIWorkflow {
  name: string;
  apiFormat: object;                           // Raw ComfyUI API JSON
  inputs: Record<string, ComfyParamSpec>;      // Typed input parameters
  outputs: Record<string, "image" | "video" | "mask" | "latent">;
}
```

### `ComfyParamSpec`

```typescript
interface ComfyParamSpec {
  path: string;                                 // Dot-separated JSON path (e.g. "6.inputs.text")
  type: "string" | "number" | "boolean" | "enum";
  enum?: string[];
  default?: unknown;
  required?: boolean;
}
```

## Built-in Workflow Parameters

### SDXL Text-to-Image (`sdxl-text2img`)

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `prompt` | `string` | — | Yes | Positive text prompt |
| `negative_prompt` | `string` | `""` | No | Negative prompt |
| `seed` | `number` | `-1` | No | Random seed (-1 = random) |
| `steps` | `number` | `20` | No | Sampling steps |
| `cfg` | `number` | `7` | No | CFG scale |
| `width` | `number` | `1024` | No | Image width |
| `height` | `number` | `1024` | No | Image height |

### SDXL Image-to-Image (`sdxl-img2img`)

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `prompt` | `string` | — | Yes | Positive text prompt |
| `negative_prompt` | `string` | `""` | No | Negative prompt |
| `seed` | `number` | `-1` | No | Random seed |
| `steps` | `number` | `20` | No | Sampling steps |
| `cfg` | `number` | `7` | No | CFG scale |
| `denoise` | `number` | `0.75` | No | Denoising strength |
| `image` | `string` | — | Yes | Input image URL or artifact ID |

### Flux Text-to-Image (`flux-text2img`)

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `prompt` | `string` | — | Yes | Positive text prompt |
| `negative_prompt` | `string` | `""` | No | Negative prompt |
| `seed` | `number` | `-1` | No | Random seed |
| `steps` | `number` | `20` | No | Sampling steps |
| `cfg` | `number` | `1` | No | CFG scale |
| `width` | `number` | `1024` | No | Image width |
| `height` | `number` | `1024` | No | Image height |

### Stable Video Diffusion (`svd-img2vid`)

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `image` | `string` | — | Yes | Input image URL or artifact ID |
| `seed` | `number` | `-1` | No | Random seed |
| `steps` | `number` | `20` | No | Sampling steps |
| `cfg` | `number` | `2.5` | No | CFG scale |
| `width` | `number` | `1024` | No | Output width |
| `height` | `number` | `576` | No | Output height |
| `video_frames` | `number` | `14` | No | Number of video frames |
| `motion_bucket_id` | `number` | `127` | No | Motion intensity |
| `fps` | `number` | `6` | No | Frames per second |

## Cost Estimation

| Operation | Estimated Cost |
|-----------|---------------|
| `image.generate` | $0.00 (local) |
| `image.edit` | $0.00 (local) |
| `video.generate` | $0.00 (local) |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Shared types and errors
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
