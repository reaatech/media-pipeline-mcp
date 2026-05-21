# @reaatech/media-pipeline-mcp-provider-core

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-provider-core.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Abstract base class and shared interfaces for all media provider implementations. Defines the provider contract, deterministic caching (F2), retry with exponential backoff, cost estimation, and a multi-strategy router for provider selection across health, budget, and latency constraints.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-provider-core
# or
pnpm add @reaatech/media-pipeline-mcp-provider-core
```

## Feature Overview

- **Abstract `MediaProvider` class** — standardizes the interface for all media backends with required `name`, `supportedOperations`, `execute`, `estimateCost`, and optional `healthCheck`
- **Deterministic caching (F2)** — SHA-256 cache keys from provider::model::version::scopeTag::deterministic inputs; supports `use`, `refresh`, and `skip` modes with 30-day default TTL
- **Execute-with-retry** — exponential backoff with configurable `maxRetries`, `baseDelay`, `maxDelay`, and automatic non-retryable error detection
- **Cost estimation (F4/F5)** — `estimateCost` contract returning `{ costUsd, currency, breakdown, estimatedDurationMs }` per operation
- **Multi-strategy router (F8)** — `first-success` (sequential failover), `cheapest-acceptable` (cost-ordered with health/budget/queue gate), and `fastest` (race-to-first-complete with <5s duration cap)
- **Storage integration** — `setStorage` / `storeArtifact` helpers for persisting provider outputs
- **Webhook support (F7)** — `supportsWebhooks`, `webhookSignatureKey`, and `parseWebhookPayload` contracts for async provider callbacks
- **3D mesh generation types (F21)** — `MeshGenInput`, `MeshOutput`, `TextureConfig`, `MeshFormat` for 3D asset generation workflows
- **Canonical JSON normalization** — sorted-key, no-whitespace, no-trailing-zero serialization for deterministic cache keys

## Quick Start

```typescript
import { MediaProvider, defineProvider, type ProviderInput, type ProviderOutput } from "@reaatech/media-pipeline-mcp-provider-core";

class MyCustomProvider extends MediaProvider {
  readonly name = "my-custom-provider";
  readonly supportedOperations = ["image.generate", "image.upscale"];

  constructor(private apiKey: string) {
    super();
  }

  async healthCheck() {
    try {
      const response = await fetch("https://api.example.com/health");
      return { healthy: response.ok, latency: 120 };
    } catch {
      return { healthy: false, error: "Connection refused" };
    }
  }

  async estimateCost(input: ProviderInput) {
    return { costUsd: 0.007, currency: "USD", estimatedDurationMs: 2000 };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    const response = await fetch("https://api.example.com/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: input.params.prompt, width: 1024, height: 1024 }),
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      data: buffer,
      mimeType: "image/png",
      metadata: { width: 1024, height: 1024, model: "v2" },
      costUsd: 0.007,
      durationMs: 1500,
    };
  }
}
```

## API Reference

### `MediaProvider` (abstract class)

Base class that all provider implementations must extend. Provides caching, retry, and storage utilities.

```typescript
abstract class MediaProvider {
  abstract readonly name: string;
  abstract readonly supportedOperations: string[];

  abstract estimateCost(input: ProviderInput): Promise<CostEstimate>;
  abstract execute(input: ProviderInput): Promise<ProviderOutput>;

  // Optional lifecycle
  healthCheck?(): Promise<ProviderHealth>;

  // Built-in helpers
  setStorage(storage: ArtifactStore): void;
  executeWithRetry(input: ProviderInput): Promise<ProviderOutput>;
  executeWithCache(input: ProviderInput, cacheConfig?: CacheConfig): Promise<ProviderOutput>;
  generateArtifactId(): string;
  storeArtifact(data: Buffer | ReadableStream, type: ArtifactType, mimeType: string, metadata: Record<string, unknown>, sourceStep?: string): Promise<string>;

  // Caching internals
  protected computeCacheKey(input: ProviderInput, cacheConfig?: CacheConfig): string;
  protected defaultCacheConfigForOperation(input: ProviderInput): CacheConfig;
  protected canonicalJson(obj: unknown): string;
  protected isNonRetryableError(error: unknown): boolean;

  // Caching configuration
  static cacheConfig: ProviderCacheConfig;
}
```

### `defineProvider`

Identity helper that passes through a provider class for registration.

```typescript
function defineProvider<T extends MediaProvider>(
  providerClass: new (...args: unknown[]) => T,
): new (...args: unknown[]) => T;
```

### `ProviderInput`

```typescript
interface ProviderInput {
  operation: string;
  params: Record<string, unknown>;
  config: Record<string, unknown>;
}
```

### `ProviderOutput`

```typescript
interface ProviderOutput {
  data: Buffer | ReadableStream;
  mimeType: string;
  metadata: Record<string, unknown>;
  costUsd?: number;
  durationMs?: number;
}
```

### `ProviderHealth`

```typescript
interface ProviderHealth {
  healthy: boolean;
  latency?: number;
  error?: string;
}
```

### Cost Estimation Types

```typescript
interface CostEstimate {
  costUsd: number;
  currency: string;
  breakdown?: Array<{ component: string; costUsd: number }>;
  estimatedDurationMs?: number;
}
```

### Caching (F2)

#### `CacheConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `mode` | `"use" \| "refresh" \| "skip"` | — | Cache mode: read-first, always-write, or bypass |
| `ttlSeconds` | `number` | `2592000` | Cache entry lifespan (30 days) |
| `scope` | `"global" \| "tenant"` | `"global"` | Key scoping: global or per-tenant |

#### `ProviderCacheConfig`

Per-provider static caching configuration controlling which params participate in cache keys.

```typescript
interface ProviderCacheConfig {
  deterministicParams: string[];       // Only these params drive the cache key
  nonDeterministicParams: string[];   // These params are excluded from the key
  normalize: (inputs: Record<string, unknown>) => Record<string, unknown>;
}
```

#### Cache Key Formula

```
sha256(provider :: modelId :: modelVersion :: scopeTag :: operation :: canonicalInputs)
```

- `modelId`: from `input.params.model` or `input.config.model`
- `modelVersion`: from `input.params.model_version` or `input.params.modelVersion`
- `scopeTag`: `"global"` or `"tenant:<tenantId>"`
- `canonicalInputs`: sorted-key JSON of deterministic params only

### Execute with Cache

```typescript
class MyProvider extends MediaProvider {
  async safeExecute(operation: string, input: ProviderInput) {
    return this.executeWithCache(input, {
      mode: "use",
      ttlSeconds: 3600,
    });
  }
}
```

Cache modes:
- **`skip`** — bypass cache entirely, no read or write
- **`use`** — read from cache first; on miss, execute and store; cache hit rebates `costUsd` to 0
- **`refresh`** — always execute and overwrite the cache entry

### Execute with Retry

```typescript
class MyProvider extends MediaProvider {
  async robustExecute(input: ProviderInput) {
    return this.executeWithRetry(input);
  }
}
```

Built-in retry behavior:
- Up to 3 retries (configurable via `retryConfig`)
- Exponential backoff: `baseDelay × 2^(attempt-1)` capped at `maxDelay`
- Non-retryable errors detected by message patterns: `"authentication"`, `"unauthorized"`, `"validation"`, `"invalid api key"`

### Router (F8)

Multi-strategy provider routing for selecting among multiple provider/model candidates.

```typescript
class Router {
  constructor(ctx: RouterContext);
  route(config: RouteConfig, inputs: ProviderInput): Promise<{ decision: RouteDecision; output: ProviderOutput }>;
}
```

#### `RouterContext`

Injection interface the router uses to interact with the host.

```typescript
interface RouterContext {
  estimateCost(candidate: RouteCandidate, inputs: ProviderInput): Promise<CostEstimate>;
  health(candidate: RouteCandidate): Promise<{ healthy: boolean; latencyMs?: number; queueDepth?: number }>;
  execute(candidate: RouteCandidate, inputs: ProviderInput, signal: AbortSignal): Promise<ProviderOutput>;
  expectedDurationMs?(candidate: RouteCandidate, inputs: ProviderInput): number | undefined;
  queueMs?(candidate: RouteCandidate): Promise<number | undefined>;
}
```

#### `RouteConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `strategy` | `"first-success" \| "cheapest-acceptable" \| "fastest"` | — | Routing strategy |
| `candidates` | `RouteCandidate[]` | — | Provider/model candidates to route across |
| `timeoutMs` | `number` | — | Global timeout for the route attempt |
| `healthTtlMs` | `number` | `30000` | Health probe cache TTL |

#### `RouteCandidate`

| Property | Type | Description |
|----------|------|-------------|
| `provider` | `string` | Provider name |
| `model` | `string` | Model identifier |
| `maxQueueMs` | `number` | Maximum acceptable queue depth in ms |
| `maxUsd` | `number` | Maximum acceptable cost per call |
| `inputOverrides` | `Record<string, unknown>` | Per-candidate parameter overrides |
| `weight` | `number` | Tiebreaker weight for equal-cost candidates (default: 1) |

#### Routing Strategies

| Strategy | Behavior |
|----------|----------|
| `first-success` | Try candidates in order; return first successful result |
| `cheapest-acceptable` | Parallel health/estimate/queue probes; pick the cheapest healthy candidate under budget |
| `fastest` | Race all candidates simultaneously; return first to complete (all must be <5s expected duration) |

#### Router Errors

```typescript
class RouterNoCandidatesError extends Error {
  readonly code = "ROUTER_NO_CANDIDATES";
}

class RouterAllCandidatesFailedError extends Error {
  readonly code = "ROUTER_ALL_CANDIDATES_FAILED";
  readonly rejections: RouteRejection[];
}

class RouterFastestIneligibleError extends Error {
  readonly code = "ROUTER_FASTEST_INELIGIBLE";
  readonly ineligibleCandidates: RouteCandidate[];
}
```

#### Rejection Reasons

| Reason | Trigger |
|--------|---------|
| `over-budget` | Candidate cost estimate exceeds `maxUsd` |
| `unhealthy` | Health check returned unhealthy |
| `queue-full` | Queue depth exceeds `maxQueueMs` |
| `error` | Execution error |
| `cancelled` | AbortSignal triggered (timeout or cancellation) |
| `fastest-ineligible` | Candidate exceeds 5s expected duration cap |

### Webhook Types (F7)

```typescript
interface WebhookPayload {
  jobId: string;
  status: "completed" | "failed" | "progress";
  output?: unknown;
  pct?: number;
  error?: { code: string; message: string };
}
```

### Mesh Generation Types (F21)

```typescript
type MeshFormat = "glb" | "fbx" | "obj" | "usdz" | "ply";

interface MeshGenInput {
  prompt?: string;
  sourceArtifactId?: string;
  format: MeshFormat;
  polyBudget?: number;
  topology?: "quads" | "tris";
  texture?: TextureConfig;
  animated?: boolean;
}

interface TextureConfig {
  enabled: boolean;
  pbr?: boolean;
  resolution?: 512 | 1024 | 2048 | 4096;
  unwrap?: "auto" | "preserve-source";
}

interface MeshOutput {
  artifactId: string;
  format: MeshFormat;
  polyCount: number;
  hasTextures: boolean;
  hasAnimation: boolean;
  bboxMeters?: { x: number; y: number; z: number };
}
```

### `MediaProviderLike`

Lightweight interface for provider shape checking and tooling.

```typescript
interface MediaProviderLike {
  readonly name: string;
  readonly supportedOperations: string[];
  estimateCost(input: ProviderInput): Promise<CostEstimate>;
  execute(input: ProviderInput): Promise<ProviderOutput>;
  healthCheck?(): Promise<ProviderHealth>;
  supportsStreaming?: ReadonlySet<string>;
  supportsWebhooks?: boolean;
  webhookSignatureKey?(): Promise<string>;
  parseWebhookPayload?(headers: Record<string, string>, body: string): Promise<WebhookPayload>;
}
```

## Usage Patterns

### Implementing a Full Provider

Every provider must extend `MediaProvider` and implement:

1. `name` — unique provider identifier
2. `supportedOperations` — list of operations (e.g. `["image.generate", "image.upscale"]`)
3. `estimateCost(input)` → `CostEstimate` — per-operation cost from public pricing
4. `execute(input)` → `ProviderOutput` — main execution path with data, mimeType, metadata
5. `healthCheck()` → `ProviderHealth` — optional, used by router for health gating

### Customizing Cache Behavior

```typescript
class OpenAIImageProvider extends MediaProvider {
  readonly name = "openai-image";
  readonly supportedOperations = ["image.generate"];

  static cacheConfig: ProviderCacheConfig = {
    deterministicParams: ["prompt", "size", "n"],
    nonDeterministicParams: ["seed"],
    normalize: (inputs) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        out[k] = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v;
      }
      return out;
    },
  };

  async estimateCost(input: ProviderInput) {
    return { costUsd: 0.04, currency: "USD" };
  }

  async execute(input: ProviderInput): Promise<ProviderOutput> {
    // ... implementation
  }
}
```

### Router with Cheapest-Acceptable Strategy

```typescript
const router = new Router({
  estimateCost: async (candidate, inputs) => {
    return { costUsd: candidate.provider === "stability" ? 0.007 : 0.04, currency: "USD" };
  },
  health: async (candidate) => ({
    healthy: true,
    latencyMs: candidate.model === "sd3" ? 1200 : 2000,
  }),
  execute: async (candidate, inputs, signal) => {
    const provider = getProvider(candidate.provider);
    return provider.execute(inputs);
  },
});

const { decision, output } = await router.route(
  {
    strategy: "cheapest-acceptable",
    candidates: [
      { provider: "stability", model: "sd3", maxUsd: 0.05 },
      { provider: "openai", model: "dall-e-3", maxUsd: 0.08 },
    ],
    timeoutMs: 30000,
  },
  { operation: "image.generate", params: { prompt: "sunset" }, config: {} },
);

console.log(decision.selected.provider); // "stability"
console.log(decision.reason); // "cheapest-acceptable: lowest cost among healthy candidates"
```

### Router with Fastest Strategy

```typescript
const { decision, output } = await router.route(
  {
    strategy: "fastest",
    candidates: [
      { provider: "fal", model: "flux-pro-1.1" },
      { provider: "replicate", model: "sdxl" },
    ],
  },
  { operation: "image.generate", params: { prompt: "cat" }, config: {} },
);
// Both candidates are raced; the first to complete wins
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types consumed by providers
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence used by `storeArtifact`
- [`@reaatech/media-pipeline-mcp-pipeline`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline) — Pipeline templates and operations

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
