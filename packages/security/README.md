# @reaatech/media-pipeline-mcp-security

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-security.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Enterprise security features for media pipeline deployments including authentication (API keys, JWT), authorization (RBAC), rate limiting (token bucket), and audit logging (SIEM export).

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-security
# or
pnpm add @reaatech/media-pipeline-mcp-security
```

## Feature Overview

- **API key authentication** — constant-time comparison for pre-shared key validation
- **JWT/OAuth2 authentication** — HS256 token verification with configurable secret and expiry
- **Role-based access control** — three roles (admin/operator/viewer) with 10 granular permissions
- **Token bucket rate limiting** — per-client and per-operation limits with auto-response headers
- **Audit logging** — immutable event trail with 11 event types buffered to disk or exported to SIEM
- **SIEM integration** — native exporters for Splunk (HEC), Datadog (Logs API), and Sumo Logic (HTTP collector)

## Quick Start

```typescript
import {
  createRBACMiddleware,
  createRateLimiter,
  createAuditLogger,
} from "@reaatech/media-pipeline-mcp-security";

// API key authentication
const auth = createRBACMiddleware({
  type: "api-key",
  apiKeys: new Set(["sk-abc123", "sk-def456"]),
});

const ctx = await auth.authenticate({ headers: { "x-api-key": "sk-abc123" } });
console.log(ctx.authenticated); // true
console.log(ctx.user?.role); // "admin"

// Rate limiting
const limiter = createRateLimiter({
  rpm: 60,
  burst: 10,
  expensiveOpsRpm: 10,
});

const result = await limiter.check("client-123", "image.generate");
console.log(result.allowed, result.remaining); // true, 59

// Audit logging
const logger = createAuditLogger({
  bufferSize: 100,
  flushIntervalMs: 5000,
});

await logger.logAuthentication("client-123", true, "api-key");
```

## API Reference

### `AuthMiddleware`

```typescript
class AuthMiddleware {
  constructor(config: AuthConfig);
  authenticate(context: AuthContext): Promise<AuthResult>;
  generateToken(payload: Record<string, unknown>): string;
}
```

#### `AuthConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `type` | `"api-key" \| "jwt" \| "none"` | `"none"` | Authentication method |
| `apiKeys` | `Set<string>` | — | Valid API keys (api-key mode) |
| `apiKeyHeader` | `string` | `"x-api-key"` | Header to check for API key |
| `jwtSecret` | `string` | — | HS256 secret (jwt mode) |
| `jwtExpiry` | `string` | `"24h"` | Token expiry duration |

#### Roles and Permissions

| Role | Permissions |
|------|-------------|
| `admin` | Full access (all permissions) |
| `operator` | `pipeline:run`, `pipeline:define`, `artifact:read`, `artifact:write`, `provider:read`, `cost:read` |
| `viewer` | `artifact:read`, `provider:read`, `cost:read` |

```typescript
import { Permissions } from "@reaatech/media-pipeline-mcp-security";

// Permission constants
Permissions.PIPELINE_RUN; // "pipeline:run"
Permissions.ARTIFACT_DELETE; // "artifact:delete"
Permissions.ADMIN; // "admin"
```

### `RateLimiter`

```typescript
class RateLimiter {
  constructor(config: RateLimitConfig);
  check(clientId: string, operation: string): Promise<RateLimitResult>;
  getStats(): Map<string, ClientStats>;
  cleanup(): void;
}
```

#### `RateLimitConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable rate limiting |
| `rpm` | `number` | `60` | Requests per minute per client |
| `burst` | `number` | `10` | Burst size per client |
| `expensiveOpsRpm` | `number` | `10` | Rpm limit for expensive operations |
| `expensiveOps` | `string[]` | `["image.generate", "video.generate", "audio.tts"]` | Operations with reduced limits |

#### Auto-Response Headers

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1714512000
Retry-After: 15000
```

### `AuditLogger`

```typescript
class AuditLogger {
  constructor(config: AuditExportConfig);
  log(event: AuditEvent): Promise<void>;
  logAuthentication(clientId: string, success: boolean, method: string): Promise<void>;
  logAuthorizationFailure(clientId: string, permission: string): Promise<void>;
  logPipelineExecution(pipelineId: string, clientId: string): Promise<void>;
  logArtifactAccess(artifactId: string, clientId: string, accessType: string): Promise<void>;
  logRateLimitExceeded(clientId: string, operation: string): Promise<void>;
  flush(): Promise<void>;
}
```

#### Audit Event Types

| Event | Description |
|-------|-------------|
| `auth.success` | Successful authentication |
| `auth.failure` | Failed authentication attempt |
| `auth.forbidden` | Authorization denied |
| `pipeline.start` | Pipeline execution started |
| `pipeline.complete` | Pipeline execution completed |
| `artifact.created` | Artifact stored |
| `artifact.accessed` | Artifact retrieved |
| `artifact.deleted` | Artifact removed |
| `rate_limit.exceeded` | Rate limit hit |
| `config.changed` | Configuration modified |
| `provider.health` | Provider health check result |

#### `AuditExportConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `bufferSize` | `number` | `100` | Events buffered before flush |
| `flushIntervalMs` | `number` | `5000` | Max time between flushes |
| `splunk` | `{ endpoint, token }` | — | Splunk HEC export config |
| `datadog` | `{ apiKey, site }` | — | Datadog Logs export config |
| `sumo` | `{ endpoint }` | — | Sumo Logic HTTP collector config |
| `localPath` | `string` | — | JSONL file backup path |

## Usage Patterns

### JWT Authentication with RBAC

```typescript
const auth = createRBACMiddleware({
  type: "jwt",
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiry: "12h",
});

// Generate a token for a user
const token = auth.generateToken({
  sub: "user-123",
  role: "operator",
});

// Authenticate a request
const ctx = await auth.authenticate({
  headers: { authorization: `Bearer ${token}` },
});

if (ctx.authenticated && ctx.user) {
  console.log(ctx.user.role); // "operator"
  console.log(ctx.user.permissions); // ["pipeline:run", "pipeline:define", ...]
}
```

### Per-Operation Rate Limiting

```typescript
const limiter = createRateLimiter({
  rpm: 100,
  burst: 20,
  expensiveOps: ["image.generate", "video.generate", "audio.tts"],
  expensiveOpsRpm: 5,
});

// Regular operations get 100 rpm
await limiter.check("client-1", "image.describe");

// Expensive operations get 5 rpm
await limiter.check("client-1", "image.generate");
```

### SIEM Export with Local Backup

```typescript
const logger = createAuditLogger({
  bufferSize: 50,
  flushIntervalMs: 10000,
  datadog: {
    apiKey: process.env.DD_API_KEY!,
    site: "datadoghq.com",
  },
  localPath: "./audit-logs/",
});

await logger.logPipelineExecution("pipeline-123", "client-456");
// Flushed to Datadog every 10s, also writes to ./audit-logs/pipeline-{date}.jsonl
```

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
