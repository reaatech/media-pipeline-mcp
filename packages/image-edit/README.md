# @reaatech/media-pipeline-mcp-image-edit

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-image-edit.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-image-edit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Image editing operations using Sharp for local processing (resize, crop, composite) with provider delegation for upscale, background removal, inpainting, and description.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-image-edit
# or
pnpm add @reaatech/media-pipeline-mcp-image-edit
```

## Feature Overview

- **Local processing** — resize, crop, and composite via Sharp (no external API calls)
- **Provider delegation** — upscale, background removal, inpainting, and description via registered providers
- **Multi-provider routing** — operation-based lookup with preferred provider selection
- **Fit modes** — cover, contain, fill, inside, outside for resize operations
- **Compositing** — gravity positioning, blend modes, opacity control

## Quick Start

```typescript
import { createImageEditOperations } from "@reaatech/media-pipeline-mcp-image-edit";

const ops = createImageEditOperations();

// Resize an image
const resized = await ops.resize({
  artifact_id: "img-123",
  dimensions: "800x600",
  fit: "cover",
});

// Crop an image
const cropped = await ops.crop({
  artifact_id: "img-123",
  x: 100,
  y: 50,
  width: 400,
  height: 300,
});

// Composite an overlay
const composed = await ops.composite({
  base_artifact_id: "img-123",
  overlay_artifact_id: "watermark-456",
  position: "southeast",
  opacity: 0.5,
  blend_mode: "over",
});
```

## Supported Operations

### Local (Sharp-based)

| Operation | Description |
|-----------|-------------|
| `resize` | Resize with fit modes, proportional scaling |
| `crop` | Crop with x/y/width/height coordinates |
| `composite` | Overlay compositing with positioning and blending |

### Provider-delegated

| Operation | Description |
|-----------|-------------|
| `upscale` | Upscale via external provider (Real-ESRGAN, etc.) |
| `remove_background` | Background removal via external provider |
| `inpaint` | Region inpainting with optional mask artifact |
| `describe` | Image description via vision-capable provider |

## API Reference

### `createImageEditOperations()`

```typescript
function createImageEditOperations(): ImageEditOperations;
```

### `ImageEditOperations`

```typescript
class ImageEditOperations {
  setProviders(providers: Provider[]): void;

  resize(config: ResizeConfig): Promise<Artifact>;
  crop(config: CropConfig): Promise<Artifact>;
  composite(config: CompositeConfig): Promise<Artifact>;
  upscale(config: UpscaleConfig): Promise<Artifact>;
  removeBackground(config: RemoveBackgroundConfig): Promise<Artifact>;
  inpaint(config: InpaintConfig): Promise<Artifact>;
  describe(config: DescribeConfig): Promise<Artifact>;
}
```

### Operation Configs

#### `ResizeConfig`

```typescript
interface ResizeConfig {
  artifact_id: string;
  dimensions: string;           // "WxH" or single dimension
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
}
```

#### `CropConfig`

```typescript
interface CropConfig {
  artifact_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
```

#### `CompositeConfig`

```typescript
interface CompositeConfig {
  base_artifact_id: string;
  overlay_artifact_id: string;
  position?: string;           // Gravity position (north, southeast, center, etc.)
  opacity?: number;            // 0–1
  blend_mode?: string;         // Sharp blend mode
}
```

#### `UpscaleConfig`

```typescript
interface UpscaleConfig {
  artifact_id: string;
  scale: "2x" | "4x" | "8x";
  model?: string;
}
```

#### `RemoveBackgroundConfig`

```typescript
interface RemoveBackgroundConfig {
  artifact_id: string;
  output_format?: "png" | "webp";
}
```

#### `InpaintConfig`

```typescript
interface InpaintConfig {
  artifact_id: string;
  mask_artifact_id?: string;
  prompt: string;
  negative_prompt?: string;
}
```

#### `DescribeConfig`

```typescript
interface DescribeConfig {
  artifact_id: string;
  detail?: "brief" | "detailed" | "structured";
}
```

## Usage Patterns

### Resize with Proportional Scaling

```typescript
// Fix width, auto-height
await ops.resize({ artifact_id: "img-123", dimensions: "800" });

// Fix height, auto-width
await ops.resize({ artifact_id: "img-123", dimensions: "x600" });

// Exact dimensions with fit
await ops.resize({ artifact_id: "img-123", dimensions: "800x600", fit: "contain" });
```

### Composite with Gravity Positioning

```typescript
// Position watermark at bottom-right
await ops.composite({
  base_artifact_id: "photo-123",
  overlay_artifact_id: "logo-456",
  position: "southeast",
  opacity: 0.3,
});

// Center overlay with custom blend mode
await ops.composite({
  base_artifact_id: "photo-123",
  overlay_artifact_id: "texture-789",
  position: "center",
  blend_mode: "multiply",
});
```

### Provider Delegation

```typescript
import { StabilityProvider } from "@reaatech/media-pipeline-mcp-stability";

const ops = createImageEditOperations();
ops.setProviders([
  new StabilityProvider({ apiKey: process.env.STABILITY_API_KEY! }),
]);

const artifact = await ops.upscale({
  artifact_id: "img-123",
  scale: "4x",
});
console.log(artifact.metadata.source); // "upscale"
console.log(artifact.metadata.provider); // "stability"
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
