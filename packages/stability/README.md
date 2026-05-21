# @reaatech/media-pipeline-mcp-stability

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-stability.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Stability AI provider for the media pipeline framework. Supports image generation using SD3, SDXL, and SD1.5 models via the Stable Image v2beta REST API. Fully self-contained with no SDK dependency — all requests use the native Fetch API with FormData for multipart image uploads.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-stability
# or
pnpm add @reaatech/media-pipeline-mcp-stability
```

## Feature Overview

- Image generation with SD3, SD3 Turbo, SDXL, and SD1.5 models
- Full parameter control: prompt, negative prompt, dimensions, seed, steps, CFG scale
- PNG output format with optional seed for reproducible generation
- Per-step cost estimation with model-specific base + per-step rates
- Deterministic caching when seed is provided
- Base URL override for custom endpoints and proxies
- Balance-based health check

## Quick Start

```typescript
import { StabilityProvider } from "@reaatech/media-pipeline-mcp-stability";

const provider = new StabilityProvider({ apiKey: process.env.STABILITY_API_KEY! });

const result = await provider.execute({
  operation: "image.generate",
  params: {
    prompt: "A serene mountain lake at dawn, professional photography",
    negative_prompt: "blurry, low quality, distorted",
    width: 1024,
    height: 1024,
    seed: 42,
    steps: 30,
    cfg_scale: 7.0,
  },
  config: {},
});

console.log(result.metadata.model); // "sd3"
console.log(result.metadata.seed);  // 42
console.log(result.costUsd);        // 0.007
```

## Supported Operations

| Operation | Supported Models | Description | Output Format |
|-----------|-----------------|-------------|---------------|
| `image.generate` | `sd3`, `sdxl`, `stable-diffusion-v1-5` | Text-to-image generation with full parameter control | PNG image buffer |

## Configuration Parameters

### `image.generate`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Text description of the desired image |
| `negative_prompt` | `string` | — | Text describing what to avoid in the output |
| `width` | `number` | — | Image width in pixels (model-dependent constraints) |
| `height` | `number` | — | Image height in pixels (model-dependent constraints) |
| `seed` | `number` | — | Random seed for reproducible generation (omit for random) |
| `steps` | `number` | — | Number of diffusion inference steps |
| `cfg_scale` | `number` | — | Classifier-free guidance scale (higher = more prompt adherence) |
| `model` | `string` | `"sd3"` | Model identifier: `sd3`, `sdxl`, `stable-diffusion-v1-5` |

### Model Constraints

Different Stability AI models have different dimension requirements. Refer to the [Stability AI documentation](https://platform.stability.ai/docs/api-reference) for each model's supported resolutions. Common defaults:

| Model | Default Dimensions | Notes |
|-------|-------------------|-------|
| `sd3` | 1024 × 1024 | Supports various aspect ratios |
| `sdxl` | 1024 × 1024 | Optimized for 1024px |
| `stable-diffusion-v1-5` | 512 × 512 | Legacy resolution |

## API Reference

### `StabilityProvider`

```typescript
class StabilityProvider extends MediaProvider {
  constructor(config: StabilityConfig)

  healthCheck(): Promise<ProviderHealth>
  estimateCost(input: ProviderInput): Promise<CostEstimate>
  execute(input: ProviderInput): Promise<ProviderOutput>
}
```

### `StabilityConfig`

```typescript
interface StabilityConfig {
  apiKey: string;                                               // Stability AI API key (required)
  model?: "sd3" | "sdxl" | "stable-diffusion-v1-5";           // Default: "sd3"
  baseUrl?: string;                                             // Default: "https://api.stability.ai/v2beta"
}
```

### Factory Function

```typescript
import { createStabilityProvider } from "@reaatech/media-pipeline-mcp-stability";

const provider = createStabilityProvider({ apiKey: process.env.STABILITY_API_KEY!, model: "sd3" });
```

### Key Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `healthCheck()` | `ProviderHealth` | Validates API key by querying the balance endpoint |
| `estimateCost(input)` | `CostEstimate` | Estimates cost based on model base rate + per-step multiplier |
| `execute(input)` | `ProviderOutput` | Generates image via multipart form POST and returns the PNG buffer |

### Non-Retryable Errors

Non-retryable errors are determined by Stability AI HTTP status codes. The provider relies on the base class retry logic for transient failures.

## Cost Estimation

### Per-Image Pricing

| Model | Base Cost | Per Step | Est. Cost (30 steps) |
|-------|-----------|----------|---------------------|
| `sd3` | $0.007 | $0.00 | $0.007 |
| `sdxl` | $0.009 | $0.00 | $0.009 |
| `stable-diffusion-v1-5` | $0.004 | $0.00 | $0.004 |

Cost is computed as `baseCost + (perStep × steps)`. Both values are sourced from `pricing.json` per model. The `perStep` field defaults to 0 for current models, meaning cost is fixed per generation regardless of step count.

## Cache Configuration

The provider exposes `static cacheConfig` with all parameters treated as deterministic.

**Deterministic parameters:** `prompt`, `model`, `steps`, `cfg_scale`, `width`, `height`, `seed`, `sampler`

**Non-deterministic parameters:** (none)

The `normalize()` function trims and collapses whitespace in `prompt`, and drops `sampler` when it's set to `"auto"` (the default). When a `seed` is provided, identical prompt + model + seed + dimensions + steps + cfg_scale combinations are fully cacheable.

**Important:** If `seed` is omitted, outputs will differ on each call and cache hits will not occur. For reproducible generations and effective caching, always provide an explicit seed.

## Health Check

The health check sends a GET request to `{baseUrl}/user/balance` using the API key as a Bearer token. Returns `{ healthy: true, latency: <ms> }` on 2xx response, or `{ healthy: false, error: "HTTP <status>: <message>" }` on failure. The balance endpoint provides a lightweight way to validate both connectivity and API key validity.

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Alternative image generation provider (DALL-E 3)
- [`@reaatech/media-pipeline-mcp-fal`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal) — Alternative image generation provider (Fast Flux Pro)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
