import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantPolicyViolationError } from '@reaatech/media-pipeline-mcp-core';
import type { KeyVault, TenantContext } from '@reaatech/media-pipeline-mcp-keyvault';

/**
 * Per-request tenant context (F18).
 *
 * We use AsyncLocalStorage so any code in the call tree (provider factory, cache key
 * computation, cost ledger writes, resource scope checks) can read the active tenant
 * without threading it through every function signature. Each MCP request runs inside
 * `tenantStorage.run(ctx, () => ...)`.
 *
 * When multiTenant is disabled, `getTenantContext()` returns undefined and call sites
 * fall back to single-tenant defaults.
 */
export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function getTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

/** Spec §F18 tenant resolution strategies. */
export type TenantResolutionStrategy =
  | { kind: 'header'; headerName: string }
  | {
      kind: 'jwt';
      jwksUri?: string;
      claim: string;
      verifyToken?: (token: string) => Promise<Record<string, unknown>>;
    }
  | { kind: 'oauth-scope'; scope: string }
  | { kind: 'mtls-cn' }
  | { kind: 'static'; tenantId: string }
  | {
      kind: 'custom';
      resolver: (request: {
        headers: Record<string, string>;
        body?: unknown;
      }) => Promise<string | null>;
    };

export interface MultiTenantConfig {
  enabled: boolean;
  keyVault: KeyVault;
  resolver: TenantResolutionStrategy;
  /** Per-tenant defaults applied when KeyVault.resolve doesn't return budgetCaps. */
  defaultBudgetCaps?: { dailyUsd?: number; monthlyUsd?: number };
  /** Cross-tenant artifact access. When true, an admin token + audit reason is required. */
  allowAdminOverride?: boolean;
}

/**
 * Extract the tenantId from inbound request data per the configured strategy.
 * Returns null when the strategy can't identify a tenant (e.g. missing header) — the
 * caller then decides whether to throw TenantNotFoundError or fall back to a default.
 */
export async function resolveTenantId(
  strategy: TenantResolutionStrategy,
  context: { headers: Record<string, string>; body?: unknown; clientCertCN?: string },
): Promise<string | null> {
  switch (strategy.kind) {
    case 'static':
      return strategy.tenantId;

    case 'header': {
      const value = context.headers[strategy.headerName.toLowerCase()];
      return value && value.trim().length > 0 ? value.trim() : null;
    }

    case 'mtls-cn':
      return context.clientCertCN ?? null;

    case 'jwt': {
      const authz = context.headers.authorization ?? '';
      const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
      if (!token) return null;
      if (strategy.verifyToken) {
        try {
          const claims = await strategy.verifyToken(token);
          const value = claims[strategy.claim];
          return typeof value === 'string' ? value : null;
        } catch {
          return null;
        }
      }
      // Without verifyToken, fall back to unverified payload decode. Production deployments
      // MUST supply verifyToken — otherwise any well-formed JWT yields a tenant claim.
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const value = payload[strategy.claim];
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    }

    case 'oauth-scope': {
      // Expects 'scope' header or Authorization token's `scope` claim. Match on substring
      // since OAuth scopes are space-separated lists.
      const scopeHeader = context.headers.scope ?? '';
      if (scopeHeader.split(/\s+/).includes(strategy.scope)) {
        // Tenant id is the part after `tenant:` in the scope, conventionally.
        const match = strategy.scope.match(/^tenant:(.+)$/);
        return match ? match[1] : null;
      }
      return null;
    }

    case 'custom':
      return strategy.resolver({ headers: context.headers, body: context.body });
  }
}

/**
 * Plan §F18 allow-list enforcement.
 *
 * Per-step guard called before provider dispatch. If the active TenantContext has
 * an `allowedProviders` list and the step's provider isn't in it, throws
 * `TenantPolicyViolationError`. Same for `allowedModels`. An empty array means
 * "deny all"; an absent field means "allow all".
 *
 * No-op when there's no active tenant context (single-tenant deployments).
 */
export function enforceTenantPolicy(provider: string | undefined, model: string | undefined): void {
  const ctx = getTenantContext();
  if (!ctx) return;
  if (provider && Array.isArray(ctx.allowedProviders)) {
    if (!ctx.allowedProviders.includes(provider)) {
      throw new TenantPolicyViolationError(
        `Tenant '${ctx.tenantId}' is not permitted to use provider '${provider}'`,
      );
    }
  }
  if (model && Array.isArray(ctx.allowedModels)) {
    if (!ctx.allowedModels.includes(model)) {
      throw new TenantPolicyViolationError(
        `Tenant '${ctx.tenantId}' is not permitted to use model '${model}'`,
      );
    }
  }
}
