import { TenantPolicyViolationError } from '@reaatech/media-pipeline-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import {
  enforceTenantPolicy,
  getTenantId,
  resolveTenantId,
  tenantStorage,
} from '../tenant-context.js';

/**
 * Tests for F18 tenant context — focused on the new allow-list enforcement and
 * the existing resolver strategies surfaced in §F18.
 */
describe('tenant-context', () => {
  describe('enforceTenantPolicy (F18 allow-list)', () => {
    it('is a no-op when no tenant context is active (single-tenant mode)', () => {
      expect(() => enforceTenantPolicy('openai', 'gpt-4o')).not.toThrow();
    });

    it('allows any provider when allowedProviders is absent', () => {
      tenantStorage.run({ tenantId: 't1', providerKeys: new Map() }, () => {
        expect(() => enforceTenantPolicy('openai', 'gpt-4o')).not.toThrow();
      });
    });

    it('throws TenantPolicyViolationError when provider is not in allowedProviders', () => {
      tenantStorage.run(
        { tenantId: 't1', providerKeys: new Map(), allowedProviders: ['anthropic'] },
        () => {
          expect(() => enforceTenantPolicy('openai', 'gpt-4o')).toThrow(TenantPolicyViolationError);
        },
      );
    });

    it('throws TenantPolicyViolationError when model is not in allowedModels', () => {
      tenantStorage.run(
        { tenantId: 't1', providerKeys: new Map(), allowedModels: ['claude-3-haiku'] },
        () => {
          expect(() => enforceTenantPolicy('anthropic', 'claude-sonnet-4-6')).toThrow(
            TenantPolicyViolationError,
          );
        },
      );
    });

    it('treats an empty allowedProviders array as deny-all', () => {
      tenantStorage.run({ tenantId: 't1', providerKeys: new Map(), allowedProviders: [] }, () => {
        expect(() => enforceTenantPolicy('openai', undefined)).toThrow(TenantPolicyViolationError);
      });
    });

    it('allows a permitted provider+model pair', () => {
      tenantStorage.run(
        {
          tenantId: 't1',
          providerKeys: new Map(),
          allowedProviders: ['anthropic'],
          allowedModels: ['claude-sonnet-4-6'],
        },
        () => {
          expect(() => enforceTenantPolicy('anthropic', 'claude-sonnet-4-6')).not.toThrow();
        },
      );
    });
  });

  describe('getTenantId', () => {
    it('returns undefined when no tenant context is active', () => {
      expect(getTenantId()).toBeUndefined();
    });

    it('returns tenantId when context is active', () => {
      tenantStorage.run({ tenantId: 'acme', providerKeys: new Map() }, () => {
        expect(getTenantId()).toBe('acme');
      });
    });
  });

  describe('resolveTenantId (existing strategies; smoke coverage)', () => {
    it('resolves a static tenantId regardless of headers', async () => {
      const out = await resolveTenantId({ kind: 'static', tenantId: 'acme' }, { headers: {} });
      expect(out).toBe('acme');
    });

    it('reads a header strategy case-insensitively', async () => {
      const out = await resolveTenantId(
        { kind: 'header', headerName: 'X-Tenant-Id' },
        { headers: { 'x-tenant-id': 'acme' } },
      );
      expect(out).toBe('acme');
    });

    it('returns null when header is missing', async () => {
      const out = await resolveTenantId(
        { kind: 'header', headerName: 'X-Tenant-Id' },
        { headers: {} },
      );
      expect(out).toBeNull();
    });

    it('returns null when header value is empty string', async () => {
      const out = await resolveTenantId(
        { kind: 'header', headerName: 'X-Tenant-Id' },
        { headers: { 'x-tenant-id': '  ' } },
      );
      // Should be falsy after trim check
      expect(out).toBeNull();
    });

    it('mtls-cn falls back to clientCertCN', async () => {
      const out = await resolveTenantId(
        { kind: 'mtls-cn' },
        { headers: {}, clientCertCN: 'acme.example.com' },
      );
      expect(out).toBe('acme.example.com');
    });

    it('mtls-cn returns null when clientCertCN is absent', async () => {
      const out = await resolveTenantId({ kind: 'mtls-cn' }, { headers: {} });
      expect(out).toBeNull();
    });

    it('jwt strategy extracts claim from unverified token', async () => {
      // JWT with { "org": "acme-corp" } payload
      const payload = Buffer.from(JSON.stringify({ org: 'acme-corp' })).toString('base64url');
      const token = `header.${payload}.signature`;
      const out = await resolveTenantId(
        { kind: 'jwt', claim: 'org' },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(out).toBe('acme-corp');
    });

    it('jwt strategy returns null when authorization header is missing', async () => {
      const out = await resolveTenantId({ kind: 'jwt', claim: 'org' }, { headers: {} });
      expect(out).toBeNull();
    });

    it('jwt strategy returns null for malformed token', async () => {
      const out = await resolveTenantId(
        { kind: 'jwt', claim: 'org' },
        { headers: { authorization: 'Bearer not-a-jwt' } },
      );
      expect(out).toBeNull();
    });

    it('jwt strategy returns null when claim is missing', async () => {
      const payload = Buffer.from(JSON.stringify({})).toString('base64url');
      const token = `header.${payload}.signature`;
      const out = await resolveTenantId(
        { kind: 'jwt', claim: 'org' },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(out).toBeNull();
    });

    it('jwt strategy with verifyToken uses custom verifier', async () => {
      const verifyToken = vi.fn().mockResolvedValue({ org: 'verified-tenant' });
      const payload = Buffer.from(JSON.stringify({ org: 'untrusted' })).toString('base64url');
      const token = `header.${payload}.signature`;
      const out = await resolveTenantId(
        { kind: 'jwt', claim: 'org', verifyToken },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(out).toBe('verified-tenant');
      expect(verifyToken).toHaveBeenCalledWith(token);
    });

    it('jwt strategy with verifyToken returns null on failure', async () => {
      const verifyToken = vi.fn().mockRejectedValue(new Error('verify failed'));
      const token = 'header.payload.signature';
      const out = await resolveTenantId(
        { kind: 'jwt', claim: 'org', verifyToken },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(out).toBeNull();
    });

    it('oauth-scope matches tenant scope from header', async () => {
      const out = await resolveTenantId(
        { kind: 'oauth-scope', scope: 'tenant:acme-corp' },
        { headers: { scope: 'openid email tenant:acme-corp profile' } },
      );
      expect(out).toBe('acme-corp');
    });

    it('oauth-scope returns null when scope is not in header', async () => {
      const out = await resolveTenantId(
        { kind: 'oauth-scope', scope: 'tenant:other' },
        { headers: { scope: 'openid email' } },
      );
      expect(out).toBeNull();
    });

    it('oauth-scope returns null when scope does not have tenant: prefix', async () => {
      const out = await resolveTenantId(
        { kind: 'oauth-scope', scope: 'read-only' },
        { headers: { scope: 'read-only' } },
      );
      expect(out).toBeNull();
    });

    it('custom resolver receives request data', async () => {
      const out = await resolveTenantId(
        { kind: 'custom', resolver: async ({ headers }) => headers['x-test'] ?? null },
        { headers: { 'x-test': 'derived-tenant' } },
      );
      expect(out).toBe('derived-tenant');
    });
  });
});
