export interface TenantContext {
  tenantId: string;
  providerKeys: ReadonlyMap<string, string>;
  budgetCaps?: { dailyUsd?: number; monthlyUsd?: number };
  allowedProviders?: string[];
  allowedModels?: string[];
  metadata?: Record<string, unknown>;
}

export interface KeyVault {
  resolve(tenantId: string): Promise<TenantContext>;
  get(tenantId: string, key: string): Promise<string | null>;
  health(): Promise<{ healthy: boolean; latencyMs: number }>;
}

export type TenantResolutionStrategy =
  | { kind: 'header'; headerName: string }
  | { kind: 'jwt'; jwksUri: string; claim: string }
  | { kind: 'oauth-scope'; scope: string }
  | { kind: 'mtls-cn' }
  | { kind: 'static'; tenantId: string }
  | { kind: 'custom'; resolver: { resolve(request: unknown): Promise<TenantContext | null> } };
