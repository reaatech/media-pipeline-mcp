import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { AuthMiddleware, Permissions } from './auth-middleware.js';

const VALID_SECRET = 'valid-jwt-secret-at-least-32-characters!!';

describe('AuthMiddleware', () => {
  describe('constructor', () => {
    it('should throw for short jwtSecret', () => {
      expect(() => new AuthMiddleware({ jwtSecret: 'short', requireAuth: true })).toThrow(
        'at least 32 characters',
      );
    });

    it('should throw when no auth config provided with requireAuth', () => {
      expect(() => new AuthMiddleware({ requireAuth: true })).toThrow(
        'requires either jwtSecret or apiKeys',
      );
    });

    it('should not throw when requireAuth is false', () => {
      expect(() => new AuthMiddleware({ requireAuth: false })).not.toThrow();
    });
  });

  describe('authenticate', () => {
    it('should reject missing auth header', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const ctx = await auth.authenticate({});
      expect(ctx.authenticated).toBe(false);
      expect(ctx.user).toBeUndefined();
      expect(ctx.permissions).toEqual([]);
    });

    it('should accept valid JWT', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'user1',
        email: 'user@test.com',
        role: 'operator',
        permissions: ['pipeline:run'],
      });

      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });
      expect(ctx.authenticated).toBe(true);
      expect(ctx.user?.id).toBe('user1');
      expect(ctx.user?.email).toBe('user@test.com');
      expect(ctx.user?.role).toBe('operator');
      expect(ctx.permissions).toContain('pipeline:run');
    });

    it('should reject expired JWT', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const expiredToken = jwt.sign(
        { sub: 'user1', email: 'user@test.com', exp: Math.floor(Date.now() / 1000) - 3600 },
        VALID_SECRET,
      );

      const ctx = await auth.authenticate({ authorization: `Bearer ${expiredToken}` });
      expect(ctx.authenticated).toBe(false);
    });

    it('should reject JWT with invalid signature', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const tamperedToken = jwt.sign(
        { sub: 'user1', email: 'user@test.com' },
        'different-secret-that-is-also-long-enough-12345',
        { expiresIn: '1h' },
      );

      const ctx = await auth.authenticate({ authorization: `Bearer ${tamperedToken}` });
      expect(ctx.authenticated).toBe(false);
    });

    it('should accept valid API key', async () => {
      const apiKeys = new Map([
        ['valid-key', { userId: 'user1', permissions: ['pipeline:run'], tenantId: 'tenant1' }],
      ]);
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true, apiKeys });

      const ctx = await auth.authenticate({ 'x-api-key': 'valid-key' });
      expect(ctx.authenticated).toBe(true);
      expect(ctx.user?.id).toBe('user1');
      expect(ctx.permissions).toEqual(['pipeline:run']);
      expect(ctx.tenantId).toBe('tenant1');
    });

    it('should reject invalid API key', async () => {
      const apiKeys = new Map([['valid-key', { userId: 'user1', permissions: ['pipeline:run'] }]]);
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true, apiKeys });

      const ctx = await auth.authenticate({ 'x-api-key': 'wrong-key' });
      expect(ctx.authenticated).toBe(false);
    });

    it('should reject API key when apiKeys map is empty', async () => {
      const auth = new AuthMiddleware({
        jwtSecret: VALID_SECRET,
        requireAuth: true,
        apiKeys: new Map(),
      });

      const ctx = await auth.authenticate({ 'x-api-key': 'any-key' });
      expect(ctx.authenticated).toBe(false);
    });

    it('should bypass auth when disabled', async () => {
      const auth = new AuthMiddleware({ requireAuth: false });

      const ctx = await auth.authenticate({});
      expect(ctx.authenticated).toBe(true);
      expect(ctx.user).toBeUndefined();
      expect(ctx.permissions).toEqual([]);
    });

    it('should try JWT when API key is not in the map', async () => {
      const apiKeys = new Map([['key1', { userId: 'u1', permissions: [] }]]);
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true, apiKeys });
      const token = auth.generateToken({
        id: 'jwt-user',
        email: 'j@t.com',
        role: 'viewer',
        permissions: [],
      });

      const ctx = await auth.authenticate({
        'x-api-key': 'wrong-key',
        authorization: `Bearer ${token}`,
      });
      expect(ctx.authenticated).toBe(true);
      expect(ctx.user?.id).toBe('jwt-user');
    });

    it('should fail auth when jwtSecret not set', async () => {
      const auth = new AuthMiddleware({ requireAuth: false });
      const ctx = await auth.authenticate({ authorization: 'Bearer some-token' });
      expect(ctx.authenticated).toBe(false);
    });

    it('should use custom API key header name', async () => {
      const apiKeys = new Map([['my-key', { userId: 'u1', permissions: ['pipeline:run'] }]]);
      const auth = new AuthMiddleware({
        jwtSecret: VALID_SECRET,
        requireAuth: true,
        apiKeys,
        apiKeyHeader: 'X-Custom-Header',
      });

      const ctx = await auth.authenticate({ 'x-custom-header': 'my-key' });
      expect(ctx.authenticated).toBe(true);
    });
  });

  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'u1',
        email: 'u@t.com',
        role: 'admin',
        permissions: [],
      });

      const decoded = jwt.verify(token, VALID_SECRET);
      expect(decoded).toHaveProperty('sub', 'u1');
      expect(decoded).toHaveProperty('email', 'u@t.com');
      expect(decoded).toHaveProperty('role', 'admin');
    });

    it('should generate token with custom expiresIn', () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken(
        { id: 'u1', email: 'u@t.com', role: 'viewer', permissions: [] },
        '1h',
      );

      const decoded = jwt.decode(token) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(3600);
    });

    it('should include tenantId in token payload', () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'u1',
        email: 'u@t.com',
        role: 'admin',
        permissions: [],
        tenantId: 'tenant-1',
      });

      const decoded = jwt.decode(token) as { tenant_id: string };
      expect(decoded.tenant_id).toBe('tenant-1');
    });

    it('should throw when jwtSecret is not set', () => {
      const auth = new AuthMiddleware({ requireAuth: false });
      expect(() =>
        auth.generateToken({ id: 'u1', email: 'u@t.com', role: 'admin', permissions: [] }),
      ).toThrow('jwtSecret is required');
    });
  });

  describe('RBAC permissions', () => {
    it('should enforce RBAC permissions for valid contexts', async () => {
      const apiKeys = new Map([
        ['key', { userId: 'usr', permissions: [Permissions.ARTIFACT_READ] }],
      ]);
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true, apiKeys });
      const ctx = await auth.authenticate({ 'x-api-key': 'key' });

      expect(auth.hasPermission(ctx, Permissions.PIPELINE_RUN)).toBe(false);
      expect(auth.hasPermission(ctx, Permissions.ARTIFACT_READ)).toBe(true);
      expect(auth.hasPermission(ctx, Permissions.ARTIFACT_DELETE)).toBe(false);
    });

    it('should allow admin override with all permissions', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'admin1',
        email: 'admin@test.com',
        role: 'admin',
        permissions: Object.values(Permissions),
      });

      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });
      expect(auth.hasPermission(ctx, Permissions.ADMIN_USERS)).toBe(true);
      expect(auth.hasPermission(ctx, Permissions.ADMIN_CONFIG)).toBe(true);
      expect(auth.hasPermission(ctx, Permissions.PIPELINE_RUN)).toBe(true);
    });

    it('should assign viewer role by default for JWT without role', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = jwt.sign({ sub: 'viewer1', email: 'viewer@test.com' }, VALID_SECRET, {
        expiresIn: '1h',
      });

      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });
      expect(ctx.user?.role).toBe('viewer');
      expect(ctx.permissions).toContain(Permissions.PIPELINE_RUN);
      expect(ctx.permissions).toContain(Permissions.ARTIFACT_READ);
      expect(ctx.permissions).not.toContain(Permissions.ARTIFACT_WRITE);
    });

    it('should filter token permissions to only those allowed by role', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'op1',
        email: 'op@test.com',
        role: 'operator',
        permissions: [Permissions.PIPELINE_RUN, Permissions.ADMIN_CONFIG],
      });

      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });
      expect(ctx.permissions).toContain(Permissions.PIPELINE_RUN);
      expect(ctx.permissions).not.toContain(Permissions.ADMIN_CONFIG);
    });
  });

  describe('canPerformOperation', () => {
    it('should map operations to permissions correctly', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'usr',
        email: 'usr@test.com',
        role: 'operator',
        permissions: [Permissions.PIPELINE_RUN, Permissions.ARTIFACT_READ, Permissions.COST_READ],
      });
      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });

      expect(auth.canPerformOperation(ctx, 'image.generate')).toBe(true);
      expect(auth.canPerformOperation(ctx, 'media.pipeline.run')).toBe(true);
      expect(auth.canPerformOperation(ctx, 'media.artifact.get')).toBe(true);
      expect(auth.canPerformOperation(ctx, 'media.artifact.delete')).toBe(false);
      expect(auth.canPerformOperation(ctx, 'media.costs.summary')).toBe(true);
    });

    it('should return false for unknown operations', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'usr',
        email: 'usr@test.com',
        role: 'admin',
        permissions: Object.values(Permissions),
      });
      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });

      expect(auth.canPerformOperation(ctx, 'unknown.op')).toBe(false);
    });

    it('should deny pipeline:define for viewer role', async () => {
      const auth = new AuthMiddleware({ jwtSecret: VALID_SECRET, requireAuth: true });
      const token = auth.generateToken({
        id: 'viewer1',
        email: 'v@test.com',
        role: 'viewer',
        permissions: [Permissions.PIPELINE_RUN, Permissions.ARTIFACT_READ],
      });
      const ctx = await auth.authenticate({ authorization: `Bearer ${token}` });

      expect(auth.canPerformOperation(ctx, 'media.pipeline.define')).toBe(false);
    });
  });
});
