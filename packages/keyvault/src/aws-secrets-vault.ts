import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { KeyVaultUnavailableError, TenantNotFoundError } from '@reaatech/media-pipeline-mcp-core';
import type { KeyVault, TenantContext } from './types.js';

export interface AwsSecretsManagerKeyVaultConfig {
  region: string;
  /** Secret name pattern with `${tenantId}` placeholder. Default: `mp/tenants/${tenantId}`. */
  secretPrefix?: string;
  /** Cache resolved TenantContext for this many ms. Default 300_000 (5 min). */
  cacheTtlMs?: number;
  /** Optional AWS credentials override. Falls back to default credential chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

interface CacheEntry {
  context: TenantContext;
  expiresAtMs: number;
}

/**
 * Resolves per-tenant provider keys from AWS Secrets Manager.
 *
 * Storage convention: one secret per tenant at `${secretPrefix}/${tenantId}` (default
 * `mp/tenants/${tenantId}`), value is JSON `{ "openai": "sk-...", "anthropic": "sk-..." }`.
 * Extended fields are passed through to `TenantContext.metadata`.
 */
export class AwsSecretsManagerKeyVault implements KeyVault {
  private client: SecretsManagerClient;
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private secretPrefix: string;

  constructor(config: AwsSecretsManagerKeyVaultConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
    this.secretPrefix = config.secretPrefix ?? 'mp/tenants';
    this.client = new SecretsManagerClient({
      region: config.region,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
  }

  private secretName(tenantId: string): string {
    return `${this.secretPrefix}/${tenantId}`;
  }

  async resolve(tenantId: string): Promise<TenantContext> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAtMs > now) {
      return cached.context;
    }

    let payload: string | undefined;
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.secretName(tenantId) }),
      );
      payload = response.SecretString;
    } catch (err) {
      const name = (err as Error & { name?: string })?.name;
      // The AWS SDK throws ResourceNotFoundException for unknown secrets — that's a
      // tenant-not-found signal, not infra unavailability.
      if (name === 'ResourceNotFoundException') {
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
      // No cheap "list" API in Secrets Manager — issue a dummy GetSecretValue and treat
      // ResourceNotFoundException as healthy (the service responded). Anything else
      // (auth failure, network) is unhealthy.
      await this.client.send(
        new GetSecretValueCommand({ SecretId: `${this.secretPrefix}/__health_probe__` }),
      );
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      const name = (err as Error & { name?: string })?.name;
      if (name === 'ResourceNotFoundException') {
        return { healthy: true, latencyMs: Date.now() - start };
      }
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }
}

/**
 * Split the parsed secret payload into the `providerKeys` map and the optional
 * TenantContext extras. The convention is: top-level string values are provider keys;
 * the reserved keys `budgetCaps`, `allowedProviders`, `allowedModels`, `metadata` are
 * passed through to the TenantContext.
 */
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
