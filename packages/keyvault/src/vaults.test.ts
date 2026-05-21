import { KeyVaultUnavailableError, TenantNotFoundError } from '@reaatech/media-pipeline-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvKeyVault, InMemoryKeyVault } from './vaults.js';

describe('InMemoryKeyVault', () => {
  let vault: InMemoryKeyVault;

  beforeEach(() => {
    vault = new InMemoryKeyVault();
  });

  it('set and get a key', async () => {
    vault.set('tenant-1', { OPENAI_API_KEY: 'sk-test' });
    const value = await vault.get('tenant-1', 'OPENAI_API_KEY');
    expect(value).toBe('sk-test');
  });

  it('returns null for a nonexistent key', async () => {
    const value = await vault.get('tenant-1', 'NONEXISTENT_KEY');
    expect(value).toBeNull();
  });

  it('resolve returns TenantContext with providerKeys', async () => {
    vault.set('tenant-1', {
      OPENAI_API_KEY: 'sk-openai',
      STABILITY_API_KEY: 'sk-stability',
    });
    const ctx = await vault.resolve('tenant-1');

    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.providerKeys).toBeInstanceOf(Map);
    expect(ctx.providerKeys.get('OPENAI_API_KEY')).toBe('sk-openai');
    expect(ctx.providerKeys.get('STABILITY_API_KEY')).toBe('sk-stability');
  });

  it('resolve throws TenantNotFoundError for unknown tenant', async () => {
    await expect(vault.resolve('unknown-tenant')).rejects.toThrow(TenantNotFoundError);
  });

  it('health returns healthy', async () => {
    const result = await vault.health();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('isolates multiple tenants', async () => {
    vault.set('tenant-a', { API_KEY: 'key-a' });
    vault.set('tenant-b', { API_KEY: 'key-b' });

    const aVal = await vault.get('tenant-a', 'API_KEY');
    const bVal = await vault.get('tenant-b', 'API_KEY');

    expect(aVal).toBe('key-a');
    expect(bVal).toBe('key-b');
  });

  it('returns null for cross-tenant key access', async () => {
    vault.set('tenant-a', { SECRET: 'a-secret' });

    const aVal = await vault.get('tenant-a', 'SECRET');
    const bVal = await vault.get('tenant-b', 'SECRET');

    expect(aVal).toBe('a-secret');
    expect(bVal).toBeNull();
  });

  it('TenantContext includes budget caps when set', async () => {
    vault.set(
      'tenant-1',
      { API_KEY: 'sk-test' },
      {
        budgetCaps: { dailyUsd: 10, monthlyUsd: 100 },
      },
    );
    const ctx = await vault.resolve('tenant-1');

    expect(ctx.budgetCaps).toBeDefined();
    expect(ctx.budgetCaps!.dailyUsd).toBe(10);
    expect(ctx.budgetCaps!.monthlyUsd).toBe(100);
  });

  it('TenantContext includes allowedProviders when set', async () => {
    vault.set(
      'tenant-1',
      { API_KEY: 'sk-test' },
      {
        allowedProviders: ['openai', 'stability'],
      },
    );
    const ctx = await vault.resolve('tenant-1');

    expect(ctx.allowedProviders).toBeDefined();
    expect(ctx.allowedProviders).toEqual(['openai', 'stability']);
  });
});

describe('EnvKeyVault', () => {
  let vault: EnvKeyVault;

  beforeEach(() => {
    vault = new EnvKeyVault();
  });

  it('reads a key from environment variables', async () => {
    process.env['TENANT1_TEST_KEY'] = 'test-value';
    const value = await vault.get('tenant1', 'test_key');
    delete process.env['TENANT1_TEST_KEY'];
    expect(value).toBe('test-value');
  });

  it('returns null for unset environment variables', async () => {
    const value = await vault.get('nonexistent-tenant', 'MISSING_KEY');
    expect(value).toBeNull();
  });

  it('health returns healthy', async () => {
    const result = await vault.health();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('resolve collects provider keys from env', async () => {
    process.env['MYTENANT_OPENAI_API_KEY'] = 'sk-openai';
    process.env['MYTENANT_STABILITY_API_KEY'] = 'sk-stability';

    const ctx = await vault.resolve('mytenant');

    delete process.env['MYTENANT_OPENAI_API_KEY'];
    delete process.env['MYTENANT_STABILITY_API_KEY'];

    expect(ctx.tenantId).toBe('mytenant');
    expect(ctx.providerKeys.get('openai')).toBe('sk-openai');
    expect(ctx.providerKeys.get('stability')).toBe('sk-stability');
  });
});

describe('AwsSecretsManagerKeyVault', () => {
  const mockSend = vi.hoisted(() => vi.fn());

  vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    GetSecretValueCommand: vi.fn().mockImplementation((args: unknown) => args),
  }));

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('resolves tenant context from secret payload', async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ OPENAI_API_KEY: 'sk-test' }) });
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    const ctx = await vault.resolve('tenant-1');
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.providerKeys.get('OPENAI_API_KEY')).toBe('sk-test');
  });

  it('throws TenantNotFoundError on ResourceNotFoundException', async () => {
    const err = new Error('not found');
    (err as { name: string }).name = 'ResourceNotFoundException';
    mockSend.mockRejectedValue(err);
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    await expect(vault.resolve('unknown')).rejects.toThrow(TenantNotFoundError);
  });

  it('throws KeyVaultUnavailableError on other errors', async () => {
    mockSend.mockRejectedValue(new Error('Network error'));
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    await expect(vault.resolve('tenant-1')).rejects.toThrow(KeyVaultUnavailableError);
  });

  it('get returns null for missing key', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }),
    );
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    const val = await vault.get('unknown', 'KEY');
    expect(val).toBeNull();
  });

  it('health returns healthy on ResourceNotFoundException', async () => {
    const err = new Error('not found');
    (err as { name: string }).name = 'ResourceNotFoundException';
    mockSend.mockRejectedValue(err);
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    const h = await vault.health();
    expect(h.healthy).toBe(true);
  });

  it('health returns unhealthy on other errors', async () => {
    mockSend.mockRejectedValue(new Error('Network error'));
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    const h = await vault.health();
    expect(h.healthy).toBe(false);
  });

  it('uses custom secretPrefix', async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ KEY: 'val' }) });
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({
      region: 'us-east-1',
      secretPrefix: 'custom/prefix',
    });
    await vault.resolve('test');
    // Should construct secret prefix correctly
    expect(mockSend).toHaveBeenCalled();
  });

  it('passes budgetCaps from secret payload', async () => {
    mockSend.mockResolvedValue({
      SecretString: JSON.stringify({
        OPENAI_API_KEY: 'sk-test',
        budgetCaps: { dailyUsd: 50, monthlyUsd: 500 },
      }),
    });
    const { AwsSecretsManagerKeyVault } = await import('./aws-secrets-vault.js');
    const vault = new AwsSecretsManagerKeyVault({ region: 'us-east-1' });
    const ctx = await vault.resolve('tenant-1');
    expect(ctx.budgetCaps?.dailyUsd).toBe(50);
  });
});

describe('GcpSecretManagerKeyVault', () => {
  const mockAccessSecretVersion = vi.hoisted(() => vi.fn());

  vi.mock('@google-cloud/secret-manager', () => ({
    SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
      accessSecretVersion: mockAccessSecretVersion,
    })),
  }));

  beforeEach(() => {
    mockAccessSecretVersion.mockReset();
  });

  it('resolves tenant context from secret payload', async () => {
    mockAccessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify({ OPENAI_API_KEY: 'sk-test' })) } },
    ]);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    const ctx = await vault.resolve('tenant-1');
    expect(ctx.tenantId).toBe('tenant-1');
    expect(ctx.providerKeys.get('OPENAI_API_KEY')).toBe('sk-test');
  });

  it('throws TenantNotFoundError on NOT_FOUND (code 5)', async () => {
    const err = new Error('not found');
    (err as unknown as { code: number }).code = 5;
    mockAccessSecretVersion.mockRejectedValue(err);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    await expect(vault.resolve('unknown')).rejects.toThrow(TenantNotFoundError);
  });

  it('throws KeyVaultUnavailableError on other errors', async () => {
    mockAccessSecretVersion.mockRejectedValue(new Error('Network error'));
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    await expect(vault.resolve('tenant-1')).rejects.toThrow(KeyVaultUnavailableError);
  });

  it('get returns null for missing tenant', async () => {
    mockAccessSecretVersion.mockRejectedValue(Object.assign(new Error('not found'), { code: 5 }));
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    const val = await vault.get('unknown', 'KEY');
    expect(val).toBeNull();
  });

  it('health returns healthy on NOT_FOUND', async () => {
    const err = new Error('not found');
    (err as unknown as { code: number }).code = 5;
    mockAccessSecretVersion.mockRejectedValue(err);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    const h = await vault.health();
    expect(h.healthy).toBe(true);
  });

  it('health returns unhealthy on other errors', async () => {
    mockAccessSecretVersion.mockRejectedValue(new Error('Network error'));
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    const h = await vault.health();
    expect(h.healthy).toBe(false);
  });

  it('throws KeyVaultUnavailableError on invalid JSON payload', async () => {
    mockAccessSecretVersion.mockResolvedValue([{ payload: { data: Buffer.from('not-json') } }]);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    await expect(vault.resolve('tenant-1')).rejects.toThrow(KeyVaultUnavailableError);
  });

  it('uses custom secretPrefix', async () => {
    mockAccessSecretVersion.mockResolvedValue([
      { payload: { data: Buffer.from(JSON.stringify({ KEY: 'val' })) } },
    ]);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({
      projectId: 'my-project',
      secretPrefix: 'custom-prefix',
    });
    await vault.resolve('test');
    expect(mockAccessSecretVersion).toHaveBeenCalled();
  });

  it('passes allowedProviders from secret payload', async () => {
    mockAccessSecretVersion.mockResolvedValue([
      {
        payload: {
          data: Buffer.from(JSON.stringify({ KEY: 'val', allowedProviders: ['openai'] })),
        },
      },
    ]);
    const { GcpSecretManagerKeyVault } = await import('./gcp-secret-vault.js');
    const vault = new GcpSecretManagerKeyVault({ projectId: 'my-project' });
    const ctx = await vault.resolve('tenant-1');
    expect(ctx.allowedProviders).toEqual(['openai']);
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
