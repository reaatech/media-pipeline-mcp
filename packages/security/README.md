# @reaatech/media-pipeline-mcp-security

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-security.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-security)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Enterprise security features for media pipeline deployments. Provides multi-method authentication (API keys with constant-time comparison, JWT/OAuth2 with HS256), role-based access control (admin, operator, viewer with 10 granular permissions), token bucket rate limiting (per-client and per-operation), operation-to-permission mapping for 30+ media operations, and an immutable audit trail with SIEM export to Splunk, Datadog, and Sumo Logic.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-security
# or
pnpm add @reaatech/media-pipeline-mcp-security
```

## Feature Overview

- **API key authentication** — constant-time string comparison to prevent timing attacks, per-key permission and tenant mapping
- **JWT/OAuth2 authentication** — HS256 token verification with Zod-validated payloads, configurable expiry, role and permission extraction
- **Role-based access control** — three roles (`admin`, `operator`, `viewer`) with 10 granular permissions; `canPerformOperation` maps 30+ media operations to required permissions
- **Token bucket rate limiting** — per-client buckets with per-operation sub-buckets, global rate cap, auto-cleanup of stale buckets after 1 hour
- **Standard rate limit headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **Audit logging** — 13 event types (authentication, pipeline execution, artifact access, etc.) buffered to disk as JSONL with periodic flush
- **SIEM integration** — native exporters for Splunk (HEC), Datadog (Logs API v2), and Sumo Logic (HTTP collector) with re-queue on failure
- **Token generation** — JWT token issuance for service accounts with roles and custom permissions
- **Tenant-aware** — API key and JWT payload carry `tenantId` for multi-tenant deployments
- **Secret validation** — JWT secrets must be ≥32 characters; missing authentication sources cause construction-time errors when `requireAuth` is set

## Quick Start

```typescript
import {
  createRBACMiddleware,
  createRateLimiter,
  createAuditLogger,
} from "@reaatech/media-pipeline-mcp-security";

// API key authentication
const auth = createRBACMiddleware({
  apiKeys: new Map([
    ["sk-abc123", { userId: "service-1", permissions: ["pipeline:run", "artifact:read"], tenantId: "tenant-a" }],
  ]),
  requireAuth: true,
});

const ctx = await auth.authenticate({ "x-api-key": "sk-abc123" });
console.log(ctx.authenticated);  // true
console.log(ctx.tenantId);       // "tenant-a"

// Check permission for an operation
const allowed = auth.canPerformOperation(ctx, "image.generate");
console.log(allowed); // true

// Rate limiting
const limiter = createRateLimiter({
  clientRequestsPerMinute: 60,
  clientBurstSize: 10,
  operationLimits: new Map([
    ["image.generate", { requestsPerMinute: 5, burstSize: 2 }],
  ]),
});

const result = limiter.checkLimit("client-123", "image.generate");
console.log(result.allowed, result.remaining);  // true, 4

// Audit logging
const logger = createAuditLogger({
  bufferSize: 100,
  flushInterval: 5000,
  retentionDays: 30,
});

logger.logAuthentication("user-1", "user@example.com", true, "192.168.1.1");
```

## API Reference

### `AuthMiddleware`

Multi-method authentication and RBAC middleware.

```typescript
class AuthMiddleware {
  constructor(config: AuthConfig);

  authenticate(headers: Record<string, string | undefined>): Promise<AuthContext>;
  hasPermission(context: AuthContext, permission: string): boolean;
  canPerformOperation(context: AuthContext, operation: string): boolean;
  generateToken(user: { id: string; email: string; role: Role; permissions: string[]; tenantId?: string }, expiresIn?: string): string;
}
```

#### `AuthConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `jwtSecret` | `string` | — | HS256 signing secret (min 32 chars) |
| `apiKeyHeader` | `string` | `"X-API-Key"` | Header name for API key |
| `apiKeys` | `Map<string, { userId: string; permissions: string[]; tenantId?: string }>` | — | Valid API keys with metadata |
| `requireAuth` | `boolean` | `false` | Reject unauthenticated requests when true |

#### `AuthContext`

```typescript
interface AuthContext {
  user?: User;
  authenticated: boolean;
  permissions: string[];
  tenantId?: string;
}

interface User {
  id: string;
  email: string;
  role: Role;
  permissions: string[];
  tenantId?: string;
}
```

#### Roles and Permissions

| Role | Permissions |
|------|-------------|
| `admin` | All permissions |
| `operator` | `pipeline:run`, `pipeline:define`, `pipeline:resume`, `artifact:read`, `artifact:write`, `cost:read` |
| `viewer` | `pipeline:run`, `artifact:read`, `cost:read` |

#### Permission Constants

```typescript
import { Permissions } from "@reaatech/media-pipeline-mcp-security";

Permissions.PIPELINE_RUN;       // "pipeline:run"
Permissions.PIPELINE_DEFINE;    // "pipeline:define"
Permissions.PIPELINE_RESUME;    // "pipeline:resume"
Permissions.ARTIFACT_READ;      // "artifact:read"
Permissions.ARTIFACT_WRITE;     // "artifact:write"
Permissions.ARTIFACT_DELETE;    // "artifact:delete"
Permissions.PROVIDER_MANAGE;    // "provider:manage"
Permissions.COST_READ;          // "cost:read"
Permissions.ADMIN_USERS;        // "admin:users"
Permissions.ADMIN_CONFIG;       // "admin:config"
```

#### Operation-to-Permission Mapping

`canPerformOperation` maps 30+ media operations to required permissions:

| Operation | Required Permission |
|-----------|--------------------|
| `image.generate`, `image.upscale`, `audio.tts`, `video.generate`, `document.ocr`, ... | `pipeline:run` |
| `media.pipeline.run` | `pipeline:run` |
| `media.pipeline.define` | `pipeline:define` |
| `media.pipeline.resume` | `pipeline:resume` |
| `media.artifact.get`, `media.artifact.list` | `artifact:read` |
| `media.artifact.delete` | `artifact:delete` |
| `media.providers.list` | `provider:manage` |
| `media.costs.summary` | `cost:read` |

### `RateLimiter`

Token bucket rate limiter with per-client and per-operation limits.

```typescript
class RateLimiter {
  constructor(config: RateLimitConfig);

  checkLimit(clientId: string, operation?: string): RateLimitResult;
  getHeaders(result: RateLimitResult): Record<string, string>;
  cleanup(maxAge?: number): void;
}
```

#### `RateLimitConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `clientRequestsPerMinute` | `number` | **required** | RPM per client |
| `clientBurstSize` | `number` | **required** | Burst capacity per client |
| `operationLimits` | `Map<string, { requestsPerMinute: number; burstSize: number }>` | — | Per-operation RPM/burst overrides |
| `globalRequestsPerSecond` | `number` | — | Global rate cap across all clients |

#### `RateLimitResult`

```typescript
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;       // Unix ms
  retryAfter?: number;   // Ms to wait before retry
}
```

#### Response Headers

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1714512000
Retry-After: 15
```

### `AuditLogger`

Immutable audit trail with SIEM export and local backup.

```typescript
class AuditLogger {
  constructor(config: AuditExportConfig);

  log(event: Omit<AuditEvent, "id" | "timestamp">): void;

  // Convenience methods
  logAuthentication(userId: string, email: string, success: boolean, ipAddress?: string): void;
  logAuthorizationFailure(userId: string, operation: string, permission: string): void;
  logPipelineExecution(userId: string, pipelineId: string, success: boolean, duration_ms: number, cost_usd: number, tenantId?: string): void;
  logArtifactAccess(userId: string, artifactId: string, action: "read" | "create" | "delete", success: boolean): void;
  logRateLimitExceeded(clientId: string, operation?: string): void;

  destroy(): void;
}
```

#### `AuditExportConfig`

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `bufferSize` | `number` | **required** | Events buffered before flush |
| `flushInterval` | `number` | **required** | Max ms between flushes |
| `retentionDays` | `number` | **required** | Config retention (used by cleanup) |
| `splunkEndpoint` | `string` | — | Splunk HEC collector URL |
| `splunkToken` | `string` | — | Splunk HEC token |
| `datadogEndpoint` | `string` | — | Datadog Logs API endpoint |
| `datadogApiKey` | `string` | — | Datadog API key |
| `sumoLogicEndpoint` | `string` | — | Sumo Logic HTTP collector URL |
| `sumoLogicSourceName` | `string` | — | Sumo Logic source name |

#### Audit Event Types

| Event Type | Description |
|------------|-------------|
| `authentication` | User login attempt (success or failure) |
| `authorization` | Permission check failure |
| `pipeline.execute` | Pipeline execution |
| `pipeline.define` | Pipeline definition creation |
| `pipeline.resume` | Pipeline resume operation |
| `artifact.create` | Artifact stored |
| `artifact.read` | Artifact retrieved |
| `artifact.delete` | Artifact removed |
| `provider.health` | Provider health check result |
| `config.change` | Configuration modification |
| `user.create` | User account created |
| `user.delete` | User account deleted |
| `rate_limit.exceeded` | Rate limit hit |

#### `AuditEvent` Structure

```typescript
interface AuditEvent {
  id: string;
  timestamp: string;          // ISO 8601
  eventType: AuditEventType;
  actor: {
    userId: string;
    email: string;
    role: string;
    ipAddress?: string;
    userAgent?: string;
  };
  action: {
    operation: string;
    resourceType: string;
    resourceId?: string;
    parameters?: Record<string, unknown>;
  };
  outcome: {
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    duration_ms: number;
  };
  context: {
    pipelineId?: string;
    artifactId?: string;
    cost_usd?: number;
    tenantId?: string;
    sessionId?: string;
  };
  metadata: Record<string, unknown>;
}
```

### Factory Functions

```typescript
function createRBACMiddleware(config: AuthConfig): AuthMiddleware;
function createRateLimiter(config: RateLimitConfig): RateLimiter;
function createAuditLogger(config: AuditExportConfig): AuditLogger;
```

## Usage Patterns

### JWT Authentication with Role-Based Access

```typescript
const auth = createRBACMiddleware({
  jwtSecret: process.env.JWT_SECRET!,   // Must be ≥32 characters
  requireAuth: true,
});

// Generate a token for an operator
const token = auth.generateToken({
  id: "user-123",
  email: "ops@example.com",
  role: "operator",
  permissions: [...],  // auto-populated from role
  tenantId: "tenant-a",
}, "12h");

// Authenticate an incoming request
const ctx = await auth.authenticate({
  authorization: `Bearer ${token}`,
});

// Check operation access
if (!auth.canPerformOperation(ctx, "media.pipeline.run")) {
  throw new Error("Forbidden");
}
```

### API Key Authentication with Time-Safe Comparison

```typescript
const auth = createRBACMiddleware({
  apiKeys: new Map([
    ["sk-prod-abc", { userId: "production-worker", permissions: Object.values(Permissions) }],
    ["sk-staging-xyz", { userId: "staging-worker", permissions: ["pipeline:run", "artifact:read"] }],
  ]),
  apiKeyHeader: "x-api-key",
  requireAuth: true,
});

// Constant-time comparison prevents timing attacks
const ctx = await auth.authenticate({ "x-api-key": "sk-prod-abc" });
```

### Per-Operation Rate Limiting

```typescript
const limiter = createRateLimiter({
  clientRequestsPerMinute: 100,
  clientBurstSize: 20,
  operationLimits: new Map([
    ["image.generate", { requestsPerMinute: 10, burstSize: 3 }],
    ["video.generate", { requestsPerMinute: 5, burstSize: 1 }],
  ]),
  globalRequestsPerSecond: 50,
});

// In request handler:
const result = limiter.checkLimit(clientId, operation);
if (!result.allowed) {
  const headers = limiter.getHeaders(result);
  return { status: 429, headers, body: { error: "Rate limited" } };
}

// Periodic cleanup (e.g., every hour)
setInterval(() => limiter.cleanup(3600000), 3600000);
```

### SIEM Export with Local Backup

```typescript
const logger = createAuditLogger({
  bufferSize: 50,
  flushInterval: 10000,
  retentionDays: 90,
  splunkEndpoint: "https://splunk.example.com:8088",
  splunkToken: process.env.SPLUNK_HEC_TOKEN!,
  datadogEndpoint: "https://http-intake.logs.datadoghq.com",
  datadogApiKey: process.env.DD_API_KEY!,
});

// Log pipeline execution
logger.logPipelineExecution("user-1", "pipeline-abc", true, 4500, 0.035, "tenant-a");

// Log artifact access
logger.logArtifactAccess("user-1", "artifact-456", "read", true);

// Log rate limit hit
logger.logRateLimitExceeded("client-789", "image.generate");

// On shutdown: flush and clean up
process.on("SIGTERM", () => {
  logger.destroy();  // Flush remaining events, clear timers
});
```

### Full Security Middleware Stack

```typescript
// Combine all three for a complete request pipeline
const auth = createRBACMiddleware({ jwtSecret: "...", requireAuth: true });
const limiter = createRateLimiter({ clientRequestsPerMinute: 60, clientBurstSize: 10 });
const audit = createAuditLogger({ bufferSize: 100, flushInterval: 5000, retentionDays: 30 });

async function handleRequest(req: Request, operation: string) {
  const clientId = req.headers["x-client-id"] ?? "anonymous";

  // 1. Rate limit check
  const limitResult = limiter.checkLimit(clientId, operation);
  if (!limitResult.allowed) {
    audit.logRateLimitExceeded(clientId, operation);
    return { status: 429, headers: limiter.getHeaders(limitResult) };
  }

  // 2. Authenticate
  const ctx = await auth.authenticate(req.headers);
  if (!ctx.authenticated) {
    audit.logAuthentication(clientId, "unknown", false);
    return { status: 401 };
  }

  // 3. Authorize
  if (!auth.canPerformOperation(ctx, operation)) {
    audit.logAuthorizationFailure(ctx.user!.id, operation, "pipeline:run");
    return { status: 403 };
  }

  // 4. Execute with audit
  const start = Date.now();
  try {
    const result = await executeOperation(operation);
    audit.logPipelineExecution(ctx.user!.id, "run-123", true, Date.now() - start, 0.007);
    return { status: 200, body: result };
  } catch (err) {
    audit.logPipelineExecution(ctx.user!.id, "run-123", false, Date.now() - start, 0);
    return { status: 500 };
  }
}
```

## Related Packages

- [`@reaatech/media-pipeline-mcp-core`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — Core pipeline types (operation names used by `canPerformOperation`)
- [`@reaatech/media-pipeline-mcp-observability`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-observability) — Telemetry and metrics (complements audit logging)

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
