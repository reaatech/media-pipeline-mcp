# @reaatech/media-pipeline-mcp-image-edit

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-image-edit.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-image-edit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Image editing operations — local Sharp-based processing for resize, crop, and composite, plus provider delegation for upscale, background removal, inpainting, and description via vision-capable LLMs.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-image-edit
# or
pnpm add @reaatech/media-pipeline-mcp-image-edit
```

## Feature Overview

- **Local processing** — resize, crop, and composite via Sharp (no external API calls, zero latency overhead)
- **Provider delegation** — upscale, background removal, inpainting, and image description via registered providers
- **Multi-provider routing** — operation-based lookup with preferred provider selection
- **Proportional scaling** — specify one dimension and the other auto-calculates from aspect ratio
- **Fit modes** — cover, contain, fill, inside, outside for resize operations
- **Gravity compositing** — position overlays with Sharp gravity (north, southeast, center, etc.)
- **Blend modes** — Sharp blend modes for composite operations with opacity control
- **Inpainting with masks** — region-based inpainting using optional mask artifacts
- **Image description** — generate text descriptions at brief, detailed, or structured levels

## Quick Start

```typescript
import { createImageEditOperations } from "@reaatech/media-pipeline-mcp-image-edit";
import { StabilityProvider } from "@reaatech/media-pipeline-mcp-stability";
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const ops = createImageEditOperations(artifactRegistry, storage);

// Register providers for delegated operations
ops.registerProvider("stability", new StabilityProvider({ apiKey: process.env.STABILITY_API_KEY! }));
ops.registerProvider("replicate", new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! }));

// Local operations (no provider needed)

// Resize an image — Sharp-based, local
const resized = await ops.resize("img-123", {
  width: 800,
  height: 600,
  fit: "cover",
});

// Crop an image region — Sharp-based, local
const cropped = await ops.crop("img-123", {
  x: 100,
  y: 50,
  width: 400,
  height: 300,
});

// Composite an overlay image — Sharp-based, local
const composed = await ops.composite("base-123", "watermark-456", {
  gravity: "southeast",
  blend: "over",
  opacity: 0.5,
});

// Provider-delegated operations

// Upscale via external provider
const upscaled = await ops.upscale({
  artifactId: "img-123",
  scale: 4,
  model: "real-esrgan",
});

// Remove background
const cutout = await ops.removeBackground({
  artifactId: "img-123",
  provider: "replicate",
});

// Inpaint a region
const inpainted = await ops.inpaint({
  artifactId: "img-123",
  maskArtifactId: "mask-456",  // optional
  prompt: "Replace this area with blue sky",
});

// Describe an image
const desc = await ops.describe({
  artifactId: "img-123",
  detail: "detailed",
  provider: "anthropic",
});
```

## API Reference

### `createImageEditOperations(artifactRegistry, storage)`

Factory function that creates an `ImageEditOperations` instance bound to the given artifact registry and store.

```typescript
function createImageEditOperations(
  artifactRegistry: ArtifactRegistry,
  storage: ArtifactStore,
): ImageEditOperations;
```

### `ImageEditOperations`

Main class providing all image editing capabilities. Local operations (resize, crop, composite) run via Sharp. Provider-delegated operations (upscale, remove_background, inpaint, describe) route to the first registered provider that supports the operation type.

```typescript
class ImageEditOperations {
  constructor(artifactRegistry: ArtifactRegistry, storage: ArtifactStore);

  registerProvider(name: string, provider: MediaProvider): void;

  // Local operations (Sharp-based)
  resize(artifactId: string, config: ResizeConfig): Promise<Artifact>;
  crop(artifactId: string, config: CropConfig): Promise<Artifact>;
  composite(baseArtifactId: string, overlayArtifactId: string, config: CompositeConfig): Promise<Artifact>;

  // Provider-delegated operations
  upscale(config: UpscaleConfig): Promise<Artifact>;
  removeBackground(config: RemoveBackgroundConfig): Promise<Artifact>;
  inpaint(config: InpaintConfig): Promise<Artifact>;
  describe(config: DescribeConfig): Promise<Artifact>;
}
```

### Operation Configs

#### Local Operations

##### `ResizeConfig`

```typescript
interface ResizeConfig {
  width?: number;                       // Target width in pixels
  height?: number;                      // Target height in pixels
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";  // Fit mode (default: "cover")
  position?: number[] | string;         // Position for fit (e.g., "center", [x, y])
  background?: string;                  // Background color for padding (e.g., "#000000")
}
```

If only one dimension is provided, the other is auto-calculated preserving aspect ratio.

##### `CropConfig`

```typescript
interface CropConfig {
  x: number;                            // Left coordinate in pixels
  y: number;                            // Top coordinate in pixels
  width: number;                        // Crop width in pixels
  height: number;                       // Crop height in pixels
}
```

##### `CompositeConfig`

```typescript
interface CompositeConfig {
  top?: number;                         // Top offset in pixels (overrides gravity)
  left?: number;                        // Left offset in pixels (overrides gravity)
  blend?: Sharp.Blend;                  // Blend mode ("over", "multiply", "screen", etc.)
  gravity?: Sharp.Gravity;              // Position ("north", "southeast", "center", etc.)
  opacity?: number;                     // Overlay opacity 0–1
}
```

#### Provider-Delegated Operations

##### `UpscaleConfig`

```typescript
interface UpscaleConfig {
  artifactId: string;                   // ID of the image to upscale
  scale?: 2 | 4;                        // Scale factor (default: 4)
  model?: string;                       // Model override (default: "real-esrgan")
  provider?: string;                    // Force specific provider
}
```

##### `RemoveBackgroundConfig`

```typescript
interface RemoveBackgroundConfig {
  artifactId: string;                   // ID of the image
  provider?: string;                    // Force specific provider
}
```

##### `InpaintConfig`

```typescript
interface InpaintConfig {
  artifactId: string;                   // ID of the image to inpaint
  maskArtifactId?: string;              // Optional mask artifact (white = inpaint area)
  prompt: string;                       // Description of what to generate in the masked area
  provider?: string;                    // Force specific provider
}
```

##### `DescribeConfig`

```typescript
interface DescribeConfig {
  artifactId: string;                   // ID of the image to describe
  detail?: "brief" | "detailed" | "structured";  // Level of detail (default: "detailed")
  provider?: string;                    // Force specific provider
}
```

## Usage Patterns

### Resize with Proportional Scaling

```typescript
// Fix width, auto-height (preserves aspect ratio)
await ops.resize("img-123", { width: 800, fit: "inside" });

// Fix height, auto-width (preserves aspect ratio)
await ops.resize("img-123", { height: 600, fit: "inside" });

// Exact dimensions with fit mode
await ops.resize("img-123", {
  width: 800,
  height: 600,
  fit: "cover",     // crops to fill
});

await ops.resize("img-123", {
  width: 800,
  height: 600,
  fit: "contain",   // letterboxes to fit
});

await ops.resize("img-123", {
  width: 800,
  height: 600,
  fit: "fill",      // stretches to fill
});
```

### Crop with Exact Coordinates

```typescript
const cropped = await ops.crop("img-123", {
  x: 100,
  y: 50,
  width: 400,
  height: 300,
});

console.log(cropped.metadata.width);   // 400
console.log(cropped.metadata.height);  // 300
console.log(cropped.metadata.cropX);   // 100
console.log(cropped.metadata.cropY);   // 50
```

### Composite with Gravity Positioning

```typescript
// Position watermark at bottom-right
await ops.composite("photo-123", "logo-456", {
  gravity: "southeast",
  blend: "over",
  opacity: 0.3,
});

// Center overlay with custom blend mode
await ops.composite("photo-123", "texture-789", {
  gravity: "center",
  blend: "multiply",
  opacity: 1.0,
});

// Exact pixel positioning (overrides gravity)
await ops.composite("photo-123", "overlay-456", {
  top: 50,
  left: 100,
  blend: "over",
});
```

### Provider Delegation with Fallback

```typescript
import { StabilityProvider } from "@reaatech/media-pipeline-mcp-stability";
import { ReplicateProvider } from "@reaatech/media-pipeline-mcp-replicate";

const ops = createImageEditOperations(artifactRegistry, storage);

// Register multiple providers — operations auto-route to first capable provider
ops.registerProvider("replicate", new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY! }));
ops.registerProvider("stability", new StabilityProvider({ apiKey: process.env.STABILITY_API_KEY! }));

// Upscale — routes to first provider supporting "image.upscale"
const upscaled = await ops.upscale({
  artifactId: "img-123",
  scale: 4,
});
console.log(upscaled.metadata.provider);  // "replicate" (first registered)
console.log(upscaled.metadata.scale);     // 4
console.log(upscaled.metadata.costUsd);   // 0.02

// Force a specific provider
const withStability = await ops.upscale({
  artifactId: "img-123",
  scale: 4,
  provider: "stability",  // explicitly use Stability
});
```

### Image Description

```typescript
// Brief description
const brief = await ops.describe({
  artifactId: "img-123",
  detail: "brief",
});

// Detailed description (default)
const detailed = await ops.describe({
  artifactId: "img-123",
  detail: "detailed",
});

// Structured description
const structured = await ops.describe({
  artifactId: "img-123",
  detail: "structured",
});
```

### Inpainting with Mask

```typescript
// Inpaint using a separate mask artifact
const inpainted = await ops.inpaint({
  artifactId: "img-123",
  maskArtifactId: "mask-456",  // white areas in mask = to be inpainted
  prompt: "Replace with a brick wall texture",
});

// Inpaint without a mask (full image transformation)
const transformed = await ops.inpaint({
  artifactId: "img-123",
  prompt: "Add snow mountains in the background",
});
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types and interfaces
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider interface
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact storage
- [`@reaatech/media-pipeline-mcp-replicate`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-replicate) — Upscale/background removal provider
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Inpainting provider
- [`@reaatech/media-pipeline-mcp-fal`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-fal) — Upscale/background removal provider

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
