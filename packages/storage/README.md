# @reaatech/media-pipeline-mcp-storage

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-storage.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Storage abstraction layer for persisting and retrieving media artifacts across multiple backends — local filesystem, AWS S3, and Google Cloud Storage — behind a unified `ArtifactStore` interface. Includes a factory function, tenant-scoped access control, path-traversal protection, and MIME-to-extension mapping.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-storage
# or
pnpm add @reaatech/media-pipeline-mcp-storage
```

## Feature Overview

- **Unified `ArtifactStore` interface** — `put`, `get`, `getSignedUrl`, `delete`, `list`, `healthCheck` for all backends
- **Local filesystem backend** — TTL auto-cleanup with hourly sweep, path-traversal protection, MIME-to-extension mapping, metadata sidecar files (`.meta.json`), optional HTTP serving
- **AWS S3 backend** — lazy-initialized SDK client, presigned URL generation, custom endpoint support (MinIO, LocalStack), credential passthrough, metadata in object headers
- **Google Cloud Storage backend** — lazy-initialized client, signed URLs, custom metadata persistence, bucket existence check on `healthCheck`
- **`createStorage` factory** — type-safe discriminated union selects backend from config
- **Path-traversal protection** — rejects artifact IDs containing `..`, `/`, `\` across all backends
- **Tenant-scoped store** — wraps any `ArtifactStore` with tenant ID prefix enforcement for multi-tenant deployments
- **Stream-to-buffer conversion** — automatic chunked conversion for backends requiring buffers

## Quick Start

```typescript
import { createStorage } from "@reaatech/media-pipeline-mcp-storage";

// Local filesystem
const local = createStorage({
  type: "local",
  config: {
    basePath: "./artifacts",
    ttl: 86400000,          // 24h in ms
    serveHttp: true,
    httpPort: 3001,
  },
});

// S3
const s3 = createStorage({
  type: "s3",
  config: {
    bucket: "my-media-artifacts",
    region: "us-east-1",
    prefix: "pipelines/",
  },
});

// GCS
const gcs = createStorage({
  type: "gcs",
  config: {
    bucket: "my-media-artifacts",
    prefix: "pipelines/",
  },
});

// Store an artifact
const uri = await local.put("artifact-123", buffer, {
  id: "artifact-123",
  type: "image",
  mimeType: "image/png",
  metadata: { width: 1024, height: 1024 },
});
console.log(uri); // "file:///absolute/path/to/artifacts/artifact-123.png"

// Retrieve an artifact
const retrieved = await local.get("artifact-123");
console.log(retrieved.meta.mimeType); // "image/png"
// retrieved.data is a ReadableStream

// Generate a signed URL
const signedUrl = await s3.getSignedUrl("artifact-123", 3600);
// Direct client access for one hour
```

## API Reference

### `ArtifactStore` Interface

```typescript
interface ArtifactStore {
  put(id: string, data: Buffer | NodeJS.ReadableStream | unknown, meta: ArtifactMeta): Promise<string>;
  get(id: string): Promise<StorageResult>;
  getSignedUrl(id: string, expiresIn?: number): Promise<string>;
  delete(id: string): Promise<void>;
  list(prefix?: string): Promise<ArtifactMeta[]>;
  healthCheck(): Promise<boolean>;
}
```

### `createStorage(config)`

Type-safe factory function.

```typescript
function createStorage(config: StorageConfig): ArtifactStore;

type StorageConfig =
  | { type: "local"; config: LocalStorageConfig }
  | { type: "s3";   config: S3StorageConfig }
  | { type: "gcs";  config: GCSStorageConfig };
```

### `LocalStorage`

Filesystem-based artifact storage with TTL cleanup and optional HTTP serving.

```typescript
class LocalStorage implements ArtifactStore {
  constructor(config: LocalStorageConfig);
  destroy(): void;
}
```

#### `LocalStorageConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `basePath` | `string` | **required** | Directory for artifact storage |
| `ttl` | `number` | — | Auto-cleanup TTL in milliseconds |
| `serveHttp` | `boolean` | `false` | Enable HTTP artifact serving |
| `httpPort` | `number` | — | HTTP server port |
| `httpHost` | `string` | — | HTTP server host |

Behaviors:
- **Automatic directory creation** — base path created with `mkdir -p` on construction
- **Hourly TTL sweep** — `setInterval` every 3600s cleans files older than TTL
- **Metadata sidecar** — each artifact file gets a `.meta.json` companion
- **MIME-to-extension mapping** — `.png`, `.jpg`, `.webp`, `.gif`, `.mp3`, `.wav`, `.ogg`, `.mp4`, `.webm`, `.txt`, `.json`, `.pdf`, fallback `.bin`
- **Stream support** — pipe `ReadableStream` into file via `createWriteStream`

### `S3Storage`

AWS S3 artifact storage with optional custom endpoint support.

```typescript
class S3Storage implements ArtifactStore {
  constructor(config: S3StorageConfig);
}
```

#### `S3StorageConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `bucket` | `string` | **required** | S3 bucket name |
| `region` | `string` | **required** | AWS region |
| `prefix` | `string` | `""` | Key prefix for all objects |
| `accessKeyId` | `string` | — | AWS access key (or use env/IMDS) |
| `secretAccessKey` | `string` | — | AWS secret key (or use env/IMDS) |
| `endpoint` | `string` | — | Custom S3 endpoint (MinIO: `http://localhost:9000`) |

Behaviors:
- **Lazy initialization** — S3 client created on first operation
- **Presigned URLs** — generated via `@aws-sdk/s3-request-presigner` with configurable expiry
- **Metadata in headers** — artifact type, MIME type, source step, custom metadata stored as S3 object metadata
- **Custom endpoint** — sets `forcePathStyle: true` for S3-compatible services
- **Health check** — sends `HeadBucketCommand` to verify bucket accessibility

### `GCSStorage`

Google Cloud Storage artifact storage.

```typescript
class GCSStorage implements ArtifactStore {
  constructor(config: GCSStorageConfig);
}
```

#### `GCSStorageConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `bucket` | `string` | **required** | GCS bucket name |
| `prefix` | `string` | `""` | Object name prefix |
| `projectId` | `string` | — | GCP project ID (or use env) |
| `keyFilename` | `string` | — | Service account JSON key path |

Behaviors:
- **Lazy initialization** — GCS client created on first operation
- **Signed URLs** — generated via `file.getSignedUrl()` with configurable expiry
- **Metadata in GCS metadata** — artifact type, mime type, source step, custom metadata in object custom metadata
- **Health check** — verifies bucket exists and is accessible
- **CreateReadStream** — `get()` returns a readable stream for efficient transfer

### `ArtifactMeta`

```typescript
interface ArtifactMeta {
  id?: string;
  type: ArtifactType;      // "image" | "video" | "audio" | "text" | "document"
  mimeType: string;
  size?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  sourceStep?: string;
}
```

### `StorageResult`

```typescript
interface StorageResult {
  data: Buffer | NodeJS.ReadableStream | unknown;
  meta: ArtifactMeta;
}
```

### `TenantScopedArtifactStore`

Wraps any `ArtifactStore` to enforce tenant-based ID prefixing. Every artifact ID is automatically prefixed with `tenant/<tenantId>/` for multi-tenant isolation.

```typescript
class TenantScopedArtifactStore implements ArtifactStore {
  constructor(private store: ArtifactStore, private tenantId: string);
  // All ArtifactStore methods proxied with tenantId prefix
}
```

## Usage Patterns

### Local Storage with HTTP Serving

```typescript
const storage = createStorage({
  type: "local",
  config: {
    basePath: "./artifacts",
    serveHttp: true,
    httpPort: 3001,
    ttl: 172800000, // 48h
  },
});

const uri = await storage.put("photo-001", buffer, {
  id: "photo-001",
  type: "image",
  mimeType: "image/png",
  metadata: { width: 1024, height: 1024 },
});
// Artifact served at http://localhost:3001/artifacts/photo-001.png
```

### S3 with MinIO (Development)

```typescript
const storage = createStorage({
  type: "s3",
  config: {
    bucket: "media-artifacts",
    region: "us-east-1",
    prefix: "dev/",
    endpoint: "http://localhost:9000",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
});
```

### Signed URLs for Direct Client Access

```typescript
const signedUrl = await storage.getSignedUrl("artifact-123", 3600);
// S3:  public presigned URL, expires in 1 hour
// GCS: public signed URL, expires in 1 hour
// Local: file:// URI with expires query param

// Download directly from the client
const response = await fetch(signedUrl);
const blob = await response.blob();
```

### Tenant-Scoped Access

```typescript
import { TenantScopedArtifactStore } from "@reaatech/media-pipeline-mcp-storage";

const baseStore = createStorage({ type: "s3", config: { bucket: "artifacts", region: "us-east-1" } });
const tenantStore = new TenantScopedArtifactStore(baseStore, "tenant-abc");

// All IDs prefixed with "tenant-abc/"
await tenantStore.put("photo-001", buffer, { id: "photo-001", type: "image", mimeType: "image/png" });
// Stored as s3://artifacts/tenant-abc/photo-001
```

### Health Check Monitoring

```typescript
const backends = [
  createStorage({ type: "local", config: { basePath: "./artifacts" } }),
  createStorage({ type: "s3", config: { bucket: "prod-artifacts", region: "us-east-1" } }),
];

for (const backend of backends) {
  const healthy = await backend.healthCheck();
  if (!healthy) {
    console.error(`Backend health check failed`);
  }
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types (ArtifactType consumed by storage)
- [`@reaatech/media-pipeline-mcp-provider-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-provider-core) — Provider base class uses `setStorage` / `storeArtifact`

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
