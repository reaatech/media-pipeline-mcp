import { beforeEach, describe, expect, it } from 'vitest';
import { TenantScopedArtifactStore } from '../tenant-scoped-store.js';
import type { ArtifactMeta, ArtifactStore, StorageResult } from '../types.js';

/**
 * In-memory fake of ArtifactStore for unit-testing the tenant prefix decorator
 * without booting a real S3/GCS/local backend.
 */
class FakeStore implements ArtifactStore {
  store = new Map<string, { data: unknown; meta: ArtifactMeta }>();
  listCalls: Array<string | undefined> = [];

  async put(id: string, data: unknown, meta: ArtifactMeta): Promise<string> {
    this.store.set(id, { data, meta });
    return `fake://${id}`;
  }
  async get(id: string): Promise<StorageResult> {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`not found: ${id}`);
    return { data: entry.data, meta: entry.meta };
  }
  async getSignedUrl(id: string, _expiresIn?: number): Promise<string> {
    return `https://signed.example/${id}`;
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
  async list(prefix?: string): Promise<ArtifactMeta[]> {
    this.listCalls.push(prefix);
    const entries: ArtifactMeta[] = [];
    for (const [id, entry] of this.store) {
      if (!prefix || id.startsWith(prefix)) entries.push({ ...entry.meta, id });
    }
    return entries;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe('TenantScopedArtifactStore (F18 per-tenant artifact prefix)', () => {
  let inner: FakeStore;

  beforeEach(() => {
    inner = new FakeStore();
  });

  it('prefixes put() ids with tenants/<tenantId>/', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => 'acme');
    await scoped.put('art-1', Buffer.from('x'), { type: 'image', mimeType: 'image/png' });
    expect(inner.store.has('tenants/acme/art-1')).toBe(true);
    expect(inner.store.has('art-1')).toBe(false);
  });

  it('isolates two tenants — acme cannot see beta artifacts via the same id', async () => {
    let activeTenant: string | undefined = 'acme';
    const scoped = new TenantScopedArtifactStore(inner, () => activeTenant);
    await scoped.put('art-1', Buffer.from('a'), { type: 'image', mimeType: 'image/png' });

    activeTenant = 'beta';
    await scoped.put('art-1', Buffer.from('b'), { type: 'image', mimeType: 'image/png' });

    expect(inner.store.size).toBe(2);
    expect(inner.store.has('tenants/acme/art-1')).toBe(true);
    expect(inner.store.has('tenants/beta/art-1')).toBe(true);

    // Active tenant beta retrieving art-1 gets beta's bytes, not acme's.
    activeTenant = 'beta';
    const result = await scoped.get('art-1');
    expect((result.data as Buffer).toString()).toBe('b');
  });

  it('does not double-prefix an already-scoped id', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => 'acme');
    await scoped.put('tenants/acme/art-2', Buffer.from('x'), {
      type: 'image',
      mimeType: 'image/png',
    });
    expect(inner.store.has('tenants/acme/art-2')).toBe(true);
    expect(inner.store.has('tenants/acme/tenants/acme/art-2')).toBe(false);
  });

  it('passes ids through unchanged when no tenant is active (single-tenant mode)', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => undefined);
    await scoped.put('legacy-art', Buffer.from('x'), { type: 'image', mimeType: 'image/png' });
    expect(inner.store.has('legacy-art')).toBe(true);
  });

  it('scopes list() to the tenant namespace', async () => {
    let activeTenant: string | undefined = 'acme';
    const scoped = new TenantScopedArtifactStore(inner, () => activeTenant);
    await scoped.put('a', Buffer.from('1'), { type: 'image', mimeType: 'image/png' });
    activeTenant = 'beta';
    await scoped.put('b', Buffer.from('2'), { type: 'image', mimeType: 'image/png' });

    activeTenant = 'acme';
    const acmeList = await scoped.list();
    expect(acmeList.map((m) => m.id)).toEqual(['tenants/acme/a']);

    activeTenant = 'beta';
    const betaList = await scoped.list();
    expect(betaList.map((m) => m.id)).toEqual(['tenants/beta/b']);
  });

  it('passes a caller prefix through inside the tenant namespace, not across it', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => 'acme');
    await scoped.list('campaign-1/');
    expect(inner.listCalls).toEqual(['tenants/acme/campaign-1/']);
  });

  it('delegates healthCheck() to inner store unchanged', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => 'acme');
    expect(await scoped.healthCheck()).toBe(true);
  });

  it('forwards signed-URL requests with the tenant-scoped id', async () => {
    const scoped = new TenantScopedArtifactStore(inner, () => 'acme');
    const url = await scoped.getSignedUrl('art-1');
    expect(url).toBe('https://signed.example/tenants/acme/art-1');
  });
});
