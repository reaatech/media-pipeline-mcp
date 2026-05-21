# @reaatech/media-pipeline-mcp-luma

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-luma.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-luma)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Luma AI provider for the media pipeline framework. Supports 3D model generation via Luma Genie using the Dream Machine API. Text-to-3D with GLB and USDZ output formats.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-luma
# or
pnpm add @reaatech/media-pipeline-mcp-luma
```

## Feature Overview

- **Text-to-3D** — generate 3D meshes from text descriptions via Luma Genie
- **GLB and USDZ output** — native support for both standard mesh formats
- **Poll-based completion** — automatic polling with configurable interval and timeout
- **Webhook support** — provider declares webhook capability for async completion
- **Cost estimation** — fixed per-generation cost reporting

## Quick Start

```typescript
import { LumaProvider } from "@reaatech/media-pipeline-mcp-luma";

const provider = new LumaProvider({
  apiKey: process.env.LUMA_API_KEY!,
});

const result = await provider.execute({
  operation: "mesh.generate",
  params: {
    prompt: "A low-poly cartoon dragon with wings spread",
    format: "glb",
  },
  config: {},
});

console.log(result.metadata.format); // "glb"
console.log(result.metadata.taskId); // "gen_abc123..."
console.log(result.costUsd); // 0.30
```

Requesting USDZ format:

```typescript
const result = await provider.execute({
  operation: "mesh.generate",
  params: {
    prompt: "A modern chair with wooden legs and fabric cushion",
    format: "usdz",
  },
  config: {},
});
```

## Supported Operations

| Operation | API Endpoint | Description |
|-----------|-------------|-------------|
| `mesh.generate` | `/dream-machine/v1/generations` | Text-to-3D mesh generation via Luma Genie |

## Configuration

```typescript
interface LumaConfig {
  apiKey: string;           // Required — Luma API key (or set LUMA_API_KEY env var)
  baseUrl?: string;          // Default: "https://api.lumalabs.ai"
  pollIntervalMs?: number;   // Default: 5000
  maxWaitMs?: number;        // Default: 900000 (15 min)
}
```

## API Reference

### `LumaProvider`

Main provider class extending `MediaProvider`.

| Member | Type | Description |
|--------|------|-------------|
| `supportedOperations` | `string[]` | `['mesh.generate']` |
| `supportsStreaming` | `Set<string>` | `{'mesh.generate'}` |
| `supportsWebhooks` | `boolean` | `true` — webhook delivery supported by Luma API |
| `healthCheck()` | `Promise<ProviderHealth>` | Checks `/dream-machine/v1/generations` endpoint |
| `estimateCost(input)` | `Promise<CostEstimate>` | Returns `{ costUsd: 0.30 }` |
| `execute(input)` | `Promise<ProviderOutput>` | Submits generation, polls for completion, downloads mesh |

### `LumaConfig`

Configuration interface (see Configuration section above).

## Mesh Generation Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | — | Text description of the 3D model to generate |
| `format` | `string` | `"glb"` | Output format: `"glb"` or `"usdz"` |
| `sourceArtifactId` | `string` | — | Optional reference image URL for image-to-3D |

## Output Metadata

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | `"luma"` |
| `taskId` | `string` | Luma generation ID |
| `format` | `string` | Actual output format (glb or usdz) |
| `requestedFormat` | `string` | Format requested by caller |
| `hasTextures` | `boolean` | `true` — Luma Genie includes textures |
| `hasAnimation` | `boolean` | `false` — static mesh |
| `prompt` | `string` | Original generation prompt |

## Cost Estimation

| Operation | Model | Estimated Cost |
|-----------|-------|---------------|
| `mesh.generate` | Genie | $0.30 / generation |

## Related Packages

- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Base provider class
- [`@reaatech/media-pipeline-mcp-meshy`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-meshy) — Meshy 3D provider (PBR textures, image-to-3D)
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
