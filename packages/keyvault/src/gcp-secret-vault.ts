import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { KeyVaultUnavailableError, TenantNotFoundError } from '@reaatech/media-pipeline-mcp-core';
import type { KeyVault, TenantContext } from './types.js';

export interface GcpSecretManagerKeyVaultConfig {
  projectId: string;
  /** Secret name pattern (the trailing segment under `projects/<id>/secrets/`). Default `mp-tenants`. */
  secretPrefix?: string;
  /** Cache resolved TenantContext for this many ms. Default 300_000 (5 min). */
  cacheTtlMs?: number;
  /** Optional service-account key file path. Falls back to default credentials. */
  keyFilename?: string;
}

interface CacheEntry {
  context: TenantContext;
  expiresAtMs: number;
}

/**
 * Resolves per-tenant provider keys from GCP Secret Manager.
 *
 * Storage convention: one secret per tenant at `projects/${projectId}/secrets/${secretPrefix}-${tenantId}`,
 * latest version's payload is JSON `{ "openai": "sk-...", ... }` plus optional reserved
 * keys (budgetCaps, allowedProviders, allowedModels, metadata).
 */
export class GcpSecretManagerKeyVault implements KeyVault {
  private client: SecretManagerServiceClient;
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private projectId: string;
  private secretPrefix: string;

  constructor(config: GcpSecretManagerKeyVaultConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
    this.projectId = config.projectId;
    this.secretPrefix = config.secretPrefix ?? 'mp-tenants';
    this.client = new SecretManagerServiceClient(
      config.keyFilename ? { keyFilename: config.keyFilename } : undefined,
    );
  }

  private secretVersionName(tenantId: string): string {
    return `projects/${this.projectId}/secrets/${this.secretPrefix}-${tenantId}/versions/latest`;
  }

  async resolve(tenantId: string): Promise<TenantContext> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAtMs > now) {
      return cached.context;
    }

    let payload: string | undefined;
    try {
      const [response] = await this.client.accessSecretVersion({
        name: this.secretVersionName(tenantId),
      });
      const data = response?.payload?.data;
      if (data) {
        payload = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      }
    } catch (err) {
      const code = (err as Error & { code?: number | string })?.code;
      // gRPC code 5 = NOT_FOUND. Treat as tenant-not-found; anything else as infra-down.
      if (code === 5 || code === 'NOT_FOUND') {
        throw new TenantNotFoundError();
      }
      throw new KeyVaultUnavailableError();
    }

    if (!payload) {
      throw new TenantNotFoundError();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new KeyVaultUnavailableError();
    }

    const { providerKeys, extras } = splitTenantPayload(parsed);
    const context: TenantContext = {
      tenantId,
      providerKeys,
      ...(extras.budgetCaps
        ? { budgetCaps: extras.budgetCaps as TenantContext['budgetCaps'] }
        : {}),
      ...(extras.allowedProviders ? { allowedProviders: extras.allowedProviders as string[] } : {}),
      ...(extras.allowedModels ? { allowedModels: extras.allowedModels as string[] } : {}),
      ...(extras.metadata ? { metadata: extras.metadata as Record<string, unknown> } : {}),
    };

    this.cache.set(tenantId, { context, expiresAtMs: now + this.cacheTtlMs });
    return context;
  }

  async get(tenantId: string, key: string): Promise<string | null> {
    try {
      const context = await this.resolve(tenantId);
      return context.providerKeys.get(key) ?? null;
    } catch (err) {
      if (err instanceof TenantNotFoundError) return null;
      throw err;
    }
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      // Probe with a synthetic tenantId. NOT_FOUND means the service is reachable.
      await this.client.accessSecretVersion({
        name: this.secretVersionName('__health_probe__'),
      });
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      const code = (err as Error & { code?: number | string })?.code;
      if (code === 5 || code === 'NOT_FOUND') {
        return { healthy: true, latencyMs: Date.now() - start };
      }
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}

function splitTenantPayload(parsed: Record<string, unknown>): {
  providerKeys: Map<string, string>;
  extras: Record<string, unknown>;
} {
  const reserved = new Set(['budgetCaps', 'allowedProviders', 'allowedModels', 'metadata']);
  const providerKeys = new Map<string, string>();
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (reserved.has(k)) {
      extras[k] = v;
    } else if (typeof v === 'string') {
      providerKeys.set(k, v);
    }
  }
  return { providerKeys, extras };
}
