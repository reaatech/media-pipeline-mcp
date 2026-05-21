# @reaatech/media-pipeline-mcp-meshy

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-meshy.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-meshy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Meshy provider for the media pipeline framework. Supports 3D model generation with PBR texture support via Meshy-4. Text-to-3D and image-to-3D with GLB, FBX, OBJ, and USDZ output formats.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-meshy
# or
pnpm add @reaatech/media-pipeline-mcp-meshy
```

## Feature Overview

- **Text-to-3D and image-to-3D** — generate meshes from text prompts or reference images
- **PBR textures** — optional physically-based rendering textures with configurable resolution
- **Multiple output formats** — GLB, FBX, OBJ, and USDZ
- **Preview and refine modes** — choose between fast preview or texture-rich refined output
- **Polygon budget control** — specify target polygon count for generated meshes
- **Poll-based completion** — automatic polling with configurable interval and timeout
- **Webhook support** — provider declares webhook capability for async job completion

## Quick Start

```typescript
import { MeshyProvider } from "@reaatech/media-pipeline-mcp-meshy";

const provider = new MeshyProvider({
  apiKey: process.env.MESHY_API_KEY!,
});

// Text-to-3D preview
const result = await provider.execute({
  operation: "mesh.generate",
  params: {
    prompt: "A medieval wooden treasure chest with iron bands",
    format: "glb",
  },
  config: {},
});

console.log(result.metadata.format); // "glb"
console.log(result.metadata.taskId);  // "abc123..."
console.log(result.costUsd);          // 0.20
```

With PBR textures and polygon budget:

```typescript
const result = await provider.execute({
  operation: "mesh.generate",
  params: {
    prompt: "A sci-fi plasma rifle with glowing accents",
    format: "fbx",
    polyBudget: 50000,
    texture: {
      enabled: true,
      pbr: true,
      resolution: 2048,
    },
  },
  config: {},
});

console.log(result.metadata.hasTextures); // true
console.log(result.costUsd);              // 0.40
```

Image-to-3D from a reference:

```typescript
const result = await provider.execute({
  operation: "mesh.generate",
  params: {
    prompt: "A vintage rotary phone",
    sourceArtifactId: "https://example.com/reference-phone.jpg",
    format: "usdz",
    texture: { enabled: true, pbr: true },
  },
  config: {},
});
```

## Supported Operations

| Operation | API Endpoint | Description |
|-----------|-------------|-------------|
| `mesh.generate` | `/openapi/v2/text-to-3d` or `/openapi/v2/image-to-3d` | Text-to-3D or image-to-3D mesh generation via Meshy-4 |

## Configuration

```typescript
interface MeshyConfig {
  apiKey: string;            // Required — Meshy API key (or set MESHY_API_KEY env var)
  baseUrl?: string;           // Default: "https://api.meshy.ai"
  pollIntervalMs?: number;    // Default: 5000
  maxWaitMs?: number;         // Default: 600000 (10 min)
}
```

## API Reference

### `MeshyProvider`

Main provider class extending `MediaProvider`.

| Member | Type | Description |
|--------|------|-------------|
| `supportedOperations` | `string[]` | `['mesh.generate']` |
| `supportsStreaming` | `Set<string>` | `{'mesh.generate'}` |
| `supportsWebhooks` | `boolean` | `true` — webhook delivery supported by Meshy API |
| `healthCheck()` | `Promise<ProviderHealth>` | Checks `/openapi/v2/users/me` endpoint |
| `estimateCost(input)` | `Promise<CostEstimate>` | Returns cost based on mode (preview/refine) |
| `execute(input)` | `Promise<ProviderOutput>` | Creates task, polls for completion, downloads mesh file |

### `MeshyConfig`

Configuration interface (see Configuration section above).

## Mesh Generation Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | — | Text description of the 3D model to generate |
| `sourceArtifactId` | `string` | — | Reference image URL — triggers image-to-3D path when present |
| `format` | `string` | `"glb"` | Output format: `"glb"`, `"fbx"`, `"obj"`, or `"usdz"` |
| `polyBudget` | `number` | — | Target polygon count for the generated mesh |
| `texture` | `object` | — | Texture configuration object |
| `texture.enabled` | `boolean` | — | Enable texture generation (switches to refine mode) |
| `texture.pbr` | `boolean` | `false` | Enable PBR (physically-based rendering) textures |
| `texture.resolution` | `number` | — | Texture resolution in pixels (e.g. 1024, 2048) |

## Output Metadata

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | `"meshy"` |
| `taskId` | `string` | Meshy task ID |
| `format` | `string` | Actual output format |
| `requestedFormat` | `string` | Format requested by caller |
| `hasTextures` | `boolean` | Whether textures were generated |
| `hasAnimation` | `boolean` | `false` — static mesh |
| `prompt` | `string` | Original generation prompt |
| `sourceArtifactId` | `string` | Reference image URL if image-to-3D |

## MIME Types by Format

| Format | MIME Type |
|--------|-----------|
| `glb` | `model/gltf-binary` |
| `fbx` | `application/octet-stream` |
| `obj` | `text/plain` |
| `usdz` | `model/vnd.usdz+zip` |

## Cost Estimation

| Operation | Mode | Estimated Cost |
|-----------|------|---------------|
| `mesh.generate` | Preview | $0.20 / generation |
| `mesh.generate` | Refine (with textures) | $0.40 / generation |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-luma`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-luma) — Luma AI 3D provider
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
