# @reaatech/media-pipeline-mcp-storage

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-storage.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Storage abstraction layer for persisting and retrieving media artifacts across multiple backends — local filesystem, AWS S3, and Google Cloud Storage — behind a unified interface.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-storage
# or
pnpm add @reaatech/media-pipeline-mcp-storage
```

## Feature Overview

- **Unified interface** — single `ArtifactStore` contract with `put()`, `get()`, `getSignedUrl()`, `delete()`, `list()`, `healthCheck()`
- **Local filesystem** — TTL auto-cleanup with hourly sweep, path-traversal protection, metadata sidecar files
- **AWS S3** — lazy-initialized client, presigned URL generation, optional custom endpoint (MinIO)
- **Google Cloud Storage** — lazy-initialized client, signed URLs, metadata persistence in object metadata
- **Path-traversal protection** — rejects artifact IDs containing `..`, `/`, or `\`
- **Factory function** — `createStorage(config)` selects backend from typed config

## Quick Start

```typescript
import { createStorage } from "@reaatech/media-pipeline-mcp-storage";

// Local filesystem
const local = createStorage({
  type: "local",
  basePath: "./artifacts",
  ttl: "24h",
  serveHttp: true,
  httpPort: 3001,
});

// AWS S3
const s3 = createStorage({
  type: "s3",
  bucket: "my-media-artifacts",
  region: "us-east-1",
  prefix: "pipelines/",
});

// Google Cloud Storage
const gcs = createStorage({
  type: "gcs",
  bucket: "my-media-artifacts",
  prefix: "pipelines/",
});

const result = await local.put("artifact-123", buffer, {
  mimeType: "image/png",
  width: 1024,
  height: 1024,
});

console.log(result.uri); // "file://./artifacts/artifact-123.png"
```

## API Reference

### `ArtifactStore` Interface

```typescript
interface ArtifactStore {
  put(id: string, data: Buffer, metadata: ArtifactMeta): Promise<StorageResult>;
  get(id: string): Promise<{ data: Buffer; metadata: ArtifactMeta }>;
  getSignedUrl(id: string, expiresInSeconds?: number): Promise<string>;
  delete(id: string): Promise<void>;
  list(prefix?: string, limit?: number): Promise<{ ids: string[]; nextToken?: string }>;
  healthCheck(): Promise<boolean>;
}
```

### `createStorage(config: StorageConfig): ArtifactStore`

Factory that returns the appropriate storage implementation based on config type.

#### `StorageConfig` (discriminated union)

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"local" \| "s3" \| "gcs"` | Backend discriminator |
| `basePath` | `string` | Local filesystem path (local only) |
| `ttl` | `string` | Auto-cleanup TTL e.g. `"24h"` (local only) |
| `serveHttp` | `boolean` | Serve artifacts via HTTP (local only) |
| `httpPort` | `number` | HTTP server port (local only) |
| `bucket` | `string` | Bucket name (s3/gcs) |
| `region` | `string` | AWS region (s3 only) |
| `prefix` | `string` | Key prefix (s3/gcs) |
| `endpoint` | `string` | Custom S3 endpoint (s3 only) |

### `LocalStorage`

```typescript
class LocalStorage implements ArtifactStore {
  constructor(config: LocalStorageConfig);
  // Full ArtifactStore implementation
  // Hourly TTL sweep for expired artifacts
  // MIME-to-extension mapping for file naming
  // Metadata stored as artifact-123.png.meta.json sidecar
}
```

### `S3Storage`

```typescript
class S3Storage implements ArtifactStore {
  constructor(config: S3StorageConfig);
  // Lazy-initialized S3 client
  // Presigned URL generation via @aws-sdk/s3-request-presigner
  // Streaming to buffer conversion for get()
}
```

### `GCSStorage`

```typescript
class GCSStorage implements ArtifactStore {
  constructor(config: GCSStorageConfig);
  // Lazy-initialized GCS client via @google-cloud/storage
  // Signed URL generation with configurable expiry
  // Metadata persisted in GCS object custom metadata
}
```

### `ArtifactMeta`

```typescript
interface ArtifactMeta {
  mimeType: string;
  width?: number;
  height?: number;
  fileSize?: number;
  [key: string]: unknown;
}
```

## Usage Patterns

### Local Storage with HTTP Serving

```typescript
const storage = createStorage({
  type: "local",
  basePath: "./artifacts",
  serveHttp: true,
  httpPort: 3001,
  ttl: "48h",
});

// Artifact served at http://localhost:3001/artifacts/artifact-123.png
```

### S3 with MinIO (Development)

```typescript
const storage = createStorage({
  type: "s3",
  bucket: "media-artifacts",
  region: "us-east-1",
  prefix: "dev/",
  endpoint: "http://localhost:9000",
});
```

### Signed URLs for Direct Access

```typescript
const signedUrl = await storage.getSignedUrl("artifact-123", 3600);
// Direct client access without going through the server
```

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline types used by storage
- [`@reaatech/media-pipeline-mcp-server`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-server) — MCP server that consumes storage

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
