import type { ArtifactMeta, ArtifactStore, StorageResult } from './types.js';

/**
 * F18 per-tenant artifact prefix.
 *
 * Plan §F18 says: "Storage backends prefix object keys with `tenants/<tenantId>/...`
 * when multi-tenant is enabled." This wrapper is a transparent decorator that does
 * exactly that — every id passed through `put/get/getSignedUrl/delete` is rewritten
 * to `tenants/<tenantId>/<id>` based on the live tenant resolved from `getTenantId`.
 *
 * When `getTenantId()` returns undefined (single-tenant context, or admin override),
 * the wrapper passes ids through unchanged so legacy non-tenant artifacts remain
 * reachable. This matches the plan's "off ⇒ existing single-tenant behavior preserved
 * exactly" backwards-compat clause.
 *
 * Cross-tenant access is prevented by the wrapper: tenant A asking for an id with no
 * prefix gets `tenants/A/<id>`. Bare cross-tenant URIs like `tenants/B/...` passed
 * by clients also collapse to `tenants/A/tenants/B/...` which can't exist, so the
 * read returns the usual not-found.
 */
export class TenantScopedArtifactStore implements ArtifactStore {
  constructor(
    private readonly inner: ArtifactStore,
    private readonly getTenantId: () => string | undefined,
  ) {}

  private scope(id: string): string {
    const tid = this.getTenantId();
    if (!tid) return id;
    // Already prefixed for the current tenant — leave alone, don't double-prefix.
    const prefix = `tenants/${tid}/`;
    if (id.startsWith(prefix)) return id;
    return `${prefix}${id}`;
  }

  async put(
    id: string,
    data: Buffer | NodeJS.ReadableStream | unknown,
    meta: ArtifactMeta,
  ): Promise<string> {
    return this.inner.put(this.scope(id), data, meta);
  }

  async get(id: string): Promise<StorageResult> {
    return this.inner.get(this.scope(id));
  }

  async getSignedUrl(id: string, expiresIn?: number): Promise<string> {
    return this.inner.getSignedUrl(this.scope(id), expiresIn);
  }

  async delete(id: string): Promise<void> {
    return this.inner.delete(this.scope(id));
  }

  async list(prefix?: string): Promise<ArtifactMeta[]> {
    const tid = this.getTenantId();
    if (tid) {
      // Restrict list to the tenant's namespace. Caller-supplied prefix is appended
      // inside the tenant namespace, never crossing tenant boundaries.
      const tenantPrefix = `tenants/${tid}/`;
      const combined = prefix ? `${tenantPrefix}${prefix}` : tenantPrefix;
      return this.inner.list(combined);
    }
    return this.inner.list(prefix);
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }
}
