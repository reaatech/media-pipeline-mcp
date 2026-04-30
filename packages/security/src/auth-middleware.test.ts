import { describe, expect, it } from 'vitest';
import { AuthMiddleware } from './auth-middleware';

describe('AuthMiddleware', () => {
  it('should be instantiated with config', () => {
    const auth = new AuthMiddleware({
      jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
      requireAuth: false,
    });
    expect(auth).toBeDefined();
  });

  it('should authenticate with valid API key', async () => {
    const apiKeys = new Map([
      ['test-key', { userId: 'user1', permissions: ['pipeline:run'], tenantId: 'tenant1' }],
    ]);

    const auth = new AuthMiddleware({
      jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
      requireAuth: true,
      apiKeys,
    });

    const context = await auth.authenticate({ 'x-api-key': 'test-key' });
    expect(context.authenticated).toBe(true);
    expect(context.user?.id).toBe('user1');
    expect(context.permissions).toContain('pipeline:run');
  });

  it('should reject invalid API key', async () => {
    const auth = new AuthMiddleware({
      jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
      requireAuth: true,
      apiKeys: new Map(),
    });

    const context = await auth.authenticate({ 'x-api-key': 'wrong-key' });
    expect(context.authenticated).toBe(false);
  });
});
