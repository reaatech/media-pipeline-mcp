import { TenantNotFoundError } from '@reaatech/media-pipeline-mcp-core';
import type { KeyVault, TenantContext } from './types.js';

export class InMemoryKeyVault implements KeyVault {
  private tenants = new Map<
    string,
    { keys: Record<string, string>; overrides?: Partial<TenantContext> }
  >();

  set(tenantId: string, keys: Record<string, string>, overrides?: Partial<TenantContext>): void {
    this.tenants.set(tenantId, { keys, overrides });
  }

  async resolve(tenantId: string): Promise<TenantContext> {
    const entry = this.tenants.get(tenantId);
    // Missing tenant → TenantNotFoundError (non-retryable, caller error). The earlier
    // KeyVaultUnavailableError was wrong: that signals infra outage and is retryable.
    if (!entry) throw new TenantNotFoundError();
    return {
      tenantId,
      providerKeys: new Map(Object.entries(entry.keys)),
      ...entry.overrides,
    };
  }

  async get(tenantId: string, key: string): Promise<string | null> {
    const entry = this.tenants.get(tenantId);
    return entry?.keys[key] ?? null;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: true, latencyMs: 0 };
  }
}

/**
 * Reads per-tenant provider keys from environment variables matching
 * `${TENANT_ID}_${PROVIDER}_API_KEY` (e.g. `ACME_OPENAI_API_KEY`). Provider list is
 * discovered dynamically from env vars matching the pattern — adding a new provider
 * just means setting `${TENANT_ID}_${NEWPROVIDER}_API_KEY` without code changes.
 */
export class EnvKeyVault implements KeyVault {
  async resolve(tenantId: string): Promise<TenantContext> {
    const keys: Record<string, string> = {};
    const prefix = `${tenantId.toUpperCase()}_`;
    const suffix = '_API_KEY';
    for (const [envKey, val] of Object.entries(process.env)) {
      if (envKey.startsWith(prefix) && envKey.endsWith(suffix) && typeof val === 'string') {
        const provider = envKey.slice(prefix.length, envKey.length - suffix.length).toLowerCase();
        if (provider.length > 0) keys[provider] = val;
      }
    }
    if (Object.keys(keys).length === 0) {
      throw new TenantNotFoundError();
    }
    return {
      tenantId,
      providerKeys: new Map(Object.entries(keys)),
    };
  }

  async get(tenantId: string, key: string): Promise<string | null> {
    const envKey = `${tenantId.toUpperCase()}_${key.toUpperCase()}`;
    return process.env[envKey] ?? null;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: true, latencyMs: 0 };
  }
}
