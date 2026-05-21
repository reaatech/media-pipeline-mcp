# @reaatech/media-pipeline-mcp-keyvault

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-keyvault)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-keyvault)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Multi-tenant API key vault with AWS Secrets Manager, GCP Secret Manager, environment-variable, and in-memory backends. Provides tenant-scoped provider credential resolution with caching and health checks.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-keyvault
```

```bash
pnpm add @reaatech/media-pipeline-mcp-keyvault
```

Cloud backends require optional peer dependencies:

```bash
# AWS Secrets Manager
pnpm add @aws-sdk/client-secrets-manager

# GCP Secret Manager
pnpm add @google-cloud/secret-manager
```

## Feature Overview

- Four vault backends: in-memory (dev/testing), environment variables, AWS Secrets Manager, GCP Secret Manager
- Per-tenant provider credential resolution with budget caps, allowed provider/model lists, and metadata
- LRU-style TTL caching to avoid secret manager round-trips on every call
- Health check probes per backend
- Tenant resolution strategies for multi-protocol tenant identification (header, JWT, OAuth scope, mTLS CN, static)

## Quick Start

```typescript
import { InMemoryKeyVault, EnvKeyVault } from '@reaatech/media-pipeline-mcp-keyvault';

// Development / testing: seed keys programmatically
const vault = new InMemoryKeyVault();
vault.set('acme', {
  openai: 'sk-...',
  stability: 'sk-...',
});

// Production-style: read from environment
// Expects ACME_OPENAI_API_KEY, ACME_STABILITY_API_KEY env vars
const envVault = new EnvKeyVault();

// Resolve all credentials for a tenant
const ctx = await vault.resolve('acme');
console.log(ctx.tenantId);
// → 'acme'
console.log(ctx.providerKeys.get('openai'));
// → 'sk-...'

// Get a single key
const key = await vault.get('acme', 'openai');

// Check backend health
const { healthy, latencyMs } = await vault.health();
```

### AWS Secrets Manager

```typescript
import { AwsSecretsManagerKeyVault } from '@reaatech/media-pipeline-mcp-keyvault';

const vault = new AwsSecretsManagerKeyVault({
  region: 'us-east-1',
  secretPrefix: 'mp/tenants', // defaults to 'mp/tenants'
  cacheTtlMs: 300_000,         // 5 min — default
});

// Secret stored at mp/tenants/acme:
// {
//   "openai": "sk-...",
//   "stability": "sk-...",
//   "budgetCaps": { "dailyUsd": 50 },
//   "allowedProviders": ["openai", "stability"],
//   "metadata": { "tier": "enterprise" }
// }

const ctx = await vault.resolve('acme');
console.log(ctx.budgetCaps?.dailyUsd); // 50
console.log(ctx.allowedProviders);      // ['openai', 'stability']
```

### GCP Secret Manager

```typescript
import { GcpSecretManagerKeyVault } from '@reaatech/media-pipeline-mcp-keyvault';

const vault = new GcpSecretManagerKeyVault({
  projectId: 'my-gcp-project',
  secretPrefix: 'mp-tenants', // defaults to 'mp-tenants'
  cacheTtlMs: 300_000,
});

// Secret stored at projects/my-gcp-project/secrets/mp-tenants-acme/versions/latest
// Same JSON shape as AWS above.
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `TenantContext` | Resolved tenant: `tenantId`, `providerKeys` (ReadonlyMap), optional `budgetCaps`, `allowedProviders`, `allowedModels`, `metadata` |
| `KeyVault` | Interface: `resolve(tenantId)`, `get(tenantId, key)`, `health()` |
| `TenantResolutionStrategy` | Discriminated union of tenant identification strategies: `header`, `jwt`, `oauth-scope`, `mtls-cn`, `static`, `custom` |

### Classes

| Class | Description |
|-------|-------------|
| `InMemoryKeyVault` | Programmatic seed for development and testing. Call `set(tenantId, keys, overrides?)` to register tenants. |
| `EnvKeyVault` | Reads keys from env vars matching `${TENANT_ID}_${PROVIDER}_API_KEY` (case-insensitive). Provider list is discovered dynamically. |
| `AwsSecretsManagerKeyVault` | AWS Secrets Manager backend. One secret per tenant at `${prefix}/${tenantId}`, JSON payload. Supports configurable region, credentials, and cache TTL. |
| `GcpSecretManagerKeyVault` | GCP Secret Manager backend. One secret per tenant at `projects/${projectId}/secrets/${prefix}-${tenantId}`, latest version. Supports service-account key file and cache TTL. |

**`AwsSecretsManagerKeyVaultConfig`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `region` | `string` | _(required)_ | AWS region |
| `secretPrefix` | `string` | `'mp/tenants'` | Path prefix for tenant secrets |
| `cacheTtlMs` | `number` | `300_000` | Cache lifetime in ms |
| `credentials` | `object` | _(none)_ | Explicit AWS credentials (accessKeyId, secretAccessKey, sessionToken) |

**`GcpSecretManagerKeyVaultConfig`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `projectId` | `string` | _(required)_ | GCP project ID |
| `secretPrefix` | `string` | `'mp-tenants'` | Prefix segment before `-${tenantId}` |
| `cacheTtlMs` | `number` | `300_000` | Cache lifetime in ms |
| `keyFilename` | `string` | _(none)_ | Service account key file path |

### Secret Payload Format

All cloud backends expect the same JSON shape per tenant secret:

```json
{
  "openai": "sk-...",
  "stability": "sk-...",
  "replicate": "r8_...",
  "budgetCaps": { "dailyUsd": 100, "monthlyUsd": 3000 },
  "allowedProviders": ["openai", "stability"],
  "allowedModels": ["gpt-4o-mini", "sd3"],
  "metadata": { "tier": "premium" }
}
```

Top-level string values are treated as provider API keys. The reserved keys `budgetCaps`, `allowedProviders`, `allowedModels`, and `metadata` populate the corresponding `TenantContext` fields.

## Usage Patterns

### Multi-Provider Tenant Setup

```typescript
const vault = new InMemoryKeyVault();
vault.set('enterprise', {
  openai: process.env.OPENAI_KEY,
  anthropic: process.env.ANTHROPIC_KEY,
  google: process.env.GOOGLE_KEY,
}, {
  budgetCaps: { dailyUsd: 500, monthlyUsd: 10000 },
  allowedProviders: ['openai', 'anthropic', 'google'],
  allowedModels: ['gpt-4o', 'claude-3-opus', 'gemini-1.5-pro'],
  metadata: { tier: 'enterprise' },
});
```

### Health Check

The `health()` method returns `{ healthy, latencyMs }`. Cloud backends issue a synthetic secret lookup and treat `NOT_FOUND` / `ResourceNotFoundException` as healthy (the service responded); other errors indicate unavailability.

## Related Packages

- [@reaatech/media-pipeline-mcp-core](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-core) — `TenantNotFoundError` and `KeyVaultUnavailableError` types
- [@reaatech/media-pipeline-mcp-cost](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-cost) — Budget caps resolved from this vault feed into cost preflight checks
- [@reaatech/media-pipeline-mcp](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Full MCP server consuming tenant credentials from this vault

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
