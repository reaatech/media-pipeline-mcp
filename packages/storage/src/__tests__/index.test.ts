import { describe, expect, it } from 'vitest';

describe('createStorage', () => {
  it('should create a LocalStorage instance', async () => {
    const mod = await import('../index.js');
    const storage = mod.createStorage({ type: 'local', config: { basePath: '/tmp/test-storage' } });
    expect(storage.constructor.name).toBe('LocalStorage');
  });

  it('should create an S3Storage instance', async () => {
    const mod = await import('../index.js');
    const storage = mod.createStorage({
      type: 's3',
      config: { bucket: 'test-bucket', region: 'us-east-1' },
    });
    expect(storage.constructor.name).toBe('S3Storage');
  });

  it('should create a GCSStorage instance', async () => {
    const mod = await import('../index.js');
    const storage = mod.createStorage({ type: 'gcs', config: { bucket: 'test-bucket' } });
    expect(storage.constructor.name).toBe('GCSStorage');
  });

  it('should throw for unknown storage type', async () => {
    const mod = await import('../index.js');
    expect(() =>
      mod.createStorage({ type: 'unknown', config: {} } as unknown as Parameters<
        typeof mod.createStorage
      >[0]),
    ).toThrow('Unknown storage type');
  });
});
