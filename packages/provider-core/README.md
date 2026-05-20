# @reaatech/media-pipeline-mcp-provider-core

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-provider-core.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Abstract base class and shared interfaces for all media providers. Defines the provider contract that every provider implementation (OpenAI, Stability, Replicate, etc.) must fulfill.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-provider-core
# or
pnpm add @reaatech/media-pipeline-mcp-provider-core
```

## Feature Overview

- **Abstract `MediaProvider` class** — standardizes the interface for all media backends
- **Built-in retry** — `executeWithRetry` with exponential backoff and non-retryable error detection
- **Storage integration** — `storeArtifact` helper for persisting provider outputs via the storage layer
- **Shared type system** — `ProviderInput`, `ProviderOutput`, `ProviderHealth` types for consistency
- **Non-retryable error detection** — auto-detects auth/validation/unauthorized errors that should not be retried

## Quick Start

```typescript
import { MediaProvider, type ProviderInput, type ProviderOutput } from "@reaatech/media-pipeline-mcp-provider-core";

class MyCustomProvider extends MediaProvider {
  readonly name = "my-custom-provider";
  readonly supportedOperations = ["image.generate", "image.upscale"];

  constructor(private apiKey: string) {
    super();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch("https://api.example.com/health");
      return response.ok;
    } catch {
      return false;
    }
  }

  async execute(operation: string, input: ProviderInput): Promise<ProviderOutput> {
    switch (operation) {
      case "image.generate":
        return this.generateImage(input);
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  private async generateImage(input: ProviderInput): Promise<ProviderOutput> {
    const response = await fetch("https://api.example.com/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: input.params.prompt,
        width: 1024,
        height: 1024,
      }),
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      data: buffer,
      mimeType: "image/png",
      metadata: { width: 1024, height: 1024, model: "v1" },
      costUsd: 0.007,
      durationMs: 1500,
    };
  }
}
```

## API Reference

### `MediaProvider` (abstract class)

```typescript
abstract class MediaProvider {
  abstract readonly name: string;
  abstract readonly supportedOperations: string[];

  abstract healthCheck(): Promise<boolean>;
  abstract execute(operation: string, input: ProviderInput): Promise<ProviderOutput>;

  // Built-in helpers
  setStorage(storage: ArtifactStore): void;
  executeWithRetry(
    operation: string,
    input: ProviderInput,
    maxRetries?: number,
    baseDelayMs?: number
  ): Promise<ProviderOutput>;
  storeArtifact(data: Buffer, metadata: Record<string, unknown>): Promise<string>;
  generateArtifactId(): string;
  isNonRetryableError(error: Error): boolean;
}
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

### `defineProvider(config: ProviderConfig)` 

Factory helper for simple provider definitions:

```typescript
import { defineProvider } from "@reaatech/media-pipeline-mcp-provider-core";

const myProvider = defineProvider({
  name: "simple-provider",
  operations: ["image.generate"],
  healthCheck: async () => true,
  execute: async (operation, input) => ({
    data: Buffer.from("mock"),
    mimeType: "image/png",
    metadata: {},
  }),
});
```

### `executeWithRetry`

Automatically retries failed operations with exponential backoff:

```typescript
class MyProvider extends MediaProvider {
  async safeExecute(operation: string, input: ProviderInput) {
    return this.executeWithRetry(operation, input, {
      maxRetries: 3,
      baseDelayMs: 1000,
    });
  }
}
```

Non-retryable errors (auth, validation, unauthorized) are detected and thrown immediately.

### `isNonRetryableError`

```typescript
// Detects these error patterns as non-retryable:
// - "Unauthorized", "Authentication failed"
// - "Invalid API key", "Invalid parameter"
// - "Forbidden", "Permission denied"
// - "Not found", "Unsupported operation"
```

### `storeArtifact` / `generateArtifactId`

```typescript
class MyProvider extends MediaProvider {
  async generateAndStore(input: ProviderInput) {
    const output = await this.execute("image.generate", input);
    const artifactId = this.generateArtifactId();
    await this.storeArtifact(output.data, {
      mimeType: output.mimeType,
      ...output.metadata,
    });
    return { artifactId, ...output };
  }
}
```

## Implementing a New Provider

Every provider must:

1. **Extend `MediaProvider`** and implement `name`, `supportedOperations`, `healthCheck`, `execute`
2. **Handle operations** in the `execute` method via switch/if-else dispatch
3. **Return `ProviderOutput`** with `data` (Buffer), `mimeType`, `metadata`, optional `costUsd` and `durationMs`
4. **Report cost** via `costUsd` for accurate budget tracking
5. **Detect non-retryable errors** to avoid useless retries

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence used by providers
- [`@reaatech/media-pipeline-mcp-openai`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-openai) — Reference provider implementation
- [`@reaatech/media-pipeline-mcp-stability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-stability) — Reference provider implementation

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
