import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaProvider, defineProvider } from './base-provider.js';
import type {
  CacheConfig,
  CostEstimate,
  ProviderCacheConfig,
  ProviderHealth,
  ProviderInput,
  ProviderOutput,
} from './types.js';

type PrivateProvider = {
  canonicalJson: (obj: unknown) => string;
  canonicalNumber: (n: number) => string;
  computeCacheKey: (input: ProviderInput, cacheConfig?: CacheConfig) => string;
  isNonRetryableError: (error: unknown) => boolean;
  generateArtifactId: () => string;
  storeArtifact: (
    data: Buffer,
    type: string,
    mimeType: string,
    metadata: Record<string, unknown>,
    sourceStep?: string,
  ) => Promise<string>;
  storage: Record<string, unknown> | undefined;
  filterDeterministic: (
    params: Record<string, unknown> | undefined,
    pcc: ProviderCacheConfig,
  ) => Record<string, unknown>;
};

class TestProvider extends MediaProvider {
  readonly name = 'test-provider';
  readonly supportedOperations = ['test.operation'];

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async execute(_input: ProviderInput): Promise<ProviderOutput> {
    return { data: Buffer.from('test'), mimeType: 'text/plain', metadata: {} };
  }

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: 0.01, currency: 'USD' };
  }
}

class CacheTrackingProvider extends MediaProvider {
  readonly name = 'cache-tracker';
  readonly supportedOperations = ['test.op'];
  executeCount = 0;

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async execute(_input: ProviderInput): Promise<ProviderOutput> {
    this.executeCount++;
    return { data: Buffer.from(`exec-${this.executeCount}`), mimeType: 'text/plain', metadata: {} };
  }

  async estimateCost(_input: ProviderInput): Promise<CostEstimate> {
    return { costUsd: 0.01, currency: 'USD' };
  }
}

describe('MediaProvider', () => {
  let provider: TestProvider;

  beforeEach(() => {
    provider = new TestProvider();
  });

  describe('basic properties', () => {
    it('should have default static cacheConfig', () => {
      expect(MediaProvider.cacheConfig).toBeDefined();
      expect(MediaProvider.cacheConfig.deterministicParams).toEqual([]);
      expect(MediaProvider.cacheConfig.nonDeterministicParams).toEqual([]);
    });

    it('should normalize strings in default cacheConfig', () => {
      const result = MediaProvider.cacheConfig.normalize({ prompt: '  hello   world ' });
      expect(result.prompt).toBe('hello world');
    });

    it('should preserve non-string values in default cacheConfig', () => {
      const result = MediaProvider.cacheConfig.normalize({ num: 42, flag: true });
      expect(result.num).toBe(42);
      expect(result.flag).toBe(true);
    });
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt', async () => {
      const result = await provider.executeWithRetry({
        operation: 'test.operation',
        params: {},
        config: {},
      });
      expect(result.data).toEqual(Buffer.from('test'));
    });

    it('should retry on transient errors', async () => {
      let attempts = 0;
      const flaky = new (class extends MediaProvider {
        readonly name = 'flaky';
        readonly supportedOperations = ['test.o'];
        async healthCheck(): Promise<ProviderHealth> {
          return { healthy: true };
        }
        async execute(): Promise<ProviderOutput> {
          attempts++;
          if (attempts < 3) throw new Error('Network error');
          return { data: Buffer.from('success'), mimeType: 'text/plain', metadata: {} };
        }
        async estimateCost(): Promise<CostEstimate> {
          return { costUsd: 0.01, currency: 'USD' };
        }
      })();

      const result = await flaky.executeWithRetry({ operation: 'test.o', params: {}, config: {} });
      expect(result.data).toEqual(Buffer.from('success'));
      expect(attempts).toBe(3);
    });

    it('should not retry on authentication errors', async () => {
      let attempts = 0;
      const authErr = new (class extends MediaProvider {
        readonly name = 'auth';
        readonly supportedOperations = ['test.o'];
        async healthCheck(): Promise<ProviderHealth> {
          return { healthy: true };
        }
        async execute(): Promise<ProviderOutput> {
          attempts++;
          throw new Error('Invalid API key - authentication failed');
        }
        async estimateCost(): Promise<CostEstimate> {
          return { costUsd: 0.01, currency: 'USD' };
        }
      })();

      await expect(
        authErr.executeWithRetry({ operation: 'test.o', params: {}, config: {} }),
      ).rejects.toThrow('authentication');
      expect(attempts).toBe(1);
    });
  });

  describe('executeWithCache', () => {
    it('should bypass cache when mode is skip', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: {}, config: {} };

      const first = await cacheTracker.executeWithCache(input, { mode: 'skip' });
      expect(cacheTracker.executeCount).toBe(1);
      expect(first.data).toEqual(Buffer.from('exec-1'));

      await cacheTracker.executeWithCache(input, { mode: 'skip' });
      expect(cacheTracker.executeCount).toBe(2);
    });

    it('should return cached result on second call in use mode', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: { x: 1 }, config: {} };

      await cacheTracker.executeWithCache(input, { mode: 'use', ttlSeconds: 60 });
      expect(cacheTracker.executeCount).toBe(1);

      const second = await cacheTracker.executeWithCache(input, { mode: 'use', ttlSeconds: 60 });
      expect(cacheTracker.executeCount).toBe(1);
      expect(second.data).toEqual(Buffer.from('exec-1'));
    });

    it('should refresh cache and not store when mode is refresh', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: {}, config: {} };

      await cacheTracker.executeWithCache(input, { mode: 'refresh' });
      expect(cacheTracker.executeCount).toBe(1);

      await cacheTracker.executeWithCache(input, { mode: 'refresh' });
      expect(cacheTracker.executeCount).toBe(2);
    });

    it('should expire cached entries', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: { x: 1 }, config: {} };

      await cacheTracker.executeWithCache(input, { mode: 'use', ttlSeconds: -1 });
      await cacheTracker.executeWithCache(input, { mode: 'use', ttlSeconds: 60 });
      expect(cacheTracker.executeCount).toBe(2);
    });

    it('should use default ttl when not provided', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: {}, config: {} };

      const cacheConfig = { mode: 'use' as const, ttlSeconds: undefined };
      await cacheTracker.executeWithCache(input, cacheConfig);
      expect(cacheTracker.executeCount).toBe(1);

      await cacheTracker.executeWithCache(input, cacheConfig);
      expect(cacheTracker.executeCount).toBe(1);
    });

    it('should not cache when no cacheConfig provided', async () => {
      const cacheTracker = new CacheTrackingProvider();
      const input: ProviderInput = { operation: 'test.op', params: {}, config: {} };

      await cacheTracker.executeWithCache(input, undefined as unknown as CacheConfig);
      expect(cacheTracker.executeCount).toBe(1);

      await cacheTracker.executeWithCache(input, undefined as unknown as CacheConfig);
      expect(cacheTracker.executeCount).toBe(2);
    });
  });

  describe('canonicalJson', () => {
    it('should produce sorted key output', () => {
      expect(
        (provider as unknown as PrivateProvider).canonicalJson({ b: 2, a: 1, c: { z: 9, y: 8 } }),
      ).toBe('{"a":1,"b":2,"c":{"y":8,"z":9}}');
    });

    it('should handle null and undefined', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson(null)).toBe('null');
      expect((provider as unknown as PrivateProvider).canonicalJson(undefined)).toBe('null');
    });

    it('should handle primitives', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson('hello')).toBe('"hello"');
      expect((provider as unknown as PrivateProvider).canonicalJson(true)).toBe('true');
      expect((provider as unknown as PrivateProvider).canonicalJson(false)).toBe('false');
    });

    it('should handle arrays', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });

    it('should handle empty arrays', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson([])).toBe('[]');
    });

    it('should handle deeply nested objects', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson({ a: { b: { c: 1 } } })).toBe(
        '{"a":{"b":{"c":1}}}',
      );
    });

    it('should format numbers without trailing zeros', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson(1.5)).toBe('1.5');
      expect((provider as unknown as PrivateProvider).canonicalJson(10)).toBe('10');
      expect((provider as unknown as PrivateProvider).canonicalJson(0.1)).toBe('0.1');
    });
  });

  describe('canonicalNumber', () => {
    it('should strip trailing zeros', () => {
      expect((provider as unknown as PrivateProvider).canonicalNumber(1.5)).toBe('1.5');
      expect((provider as unknown as PrivateProvider).canonicalNumber(100)).toBe('100');
      expect((provider as unknown as PrivateProvider).canonicalNumber(0.001)).toBe('0.001');
    });
  });

  describe('computeCacheKey', () => {
    // The new key formula incorporates the provider name (this.name), modelId and
    // modelVersion (from params), and a scope tag — not the loose (provider, op, params)
    // triple the old signature took. All assertions go through real `input` shapes.

    it('should produce deterministic key for the same input regardless of key order', () => {
      const input1: ProviderInput = {
        operation: 'op',
        params: { a: 1, b: 2, model: 'm', model_version: 'v1' },
        config: {},
      };
      const input2: ProviderInput = {
        operation: 'op',
        params: { b: 2, a: 1, model: 'm', model_version: 'v1' },
        config: {},
      };
      const key1 = (provider as unknown as PrivateProvider).computeCacheKey(input1);
      const key2 = (provider as unknown as PrivateProvider).computeCacheKey(input2);
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different inputs', () => {
      const key1 = (provider as unknown as PrivateProvider).computeCacheKey({
        operation: 'op',
        params: { a: 1 },
        config: {},
      });
      const key2 = (provider as unknown as PrivateProvider).computeCacheKey({
        operation: 'op',
        params: { a: 2 },
        config: {},
      });
      expect(key1).not.toBe(key2);
    });

    it('should produce different keys when the model version changes', () => {
      const k1 = (provider as unknown as PrivateProvider).computeCacheKey({
        operation: 'op',
        params: { prompt: 'x', model: 'm', model_version: 'v1' },
        config: {},
      });
      const k2 = (provider as unknown as PrivateProvider).computeCacheKey({
        operation: 'op',
        params: { prompt: 'x', model: 'm', model_version: 'v2' },
        config: {},
      });
      expect(k1).not.toBe(k2);
    });

    it('should produce different keys for tenant vs global scope', () => {
      const input: ProviderInput = {
        operation: 'op',
        params: { prompt: 'x' },
        config: { tenantId: 'acme' },
      };
      const global = (provider as unknown as PrivateProvider).computeCacheKey(input, {
        mode: 'use',
        scope: 'global',
      });
      const tenant = (provider as unknown as PrivateProvider).computeCacheKey(input, {
        mode: 'use',
        scope: 'tenant',
      });
      expect(global).not.toBe(tenant);
    });
  });

  describe('isNonRetryableError', () => {
    it('should identify authentication errors', () => {
      expect(
        (provider as unknown as PrivateProvider).isNonRetryableError(
          new Error('Authentication failed'),
        ),
      ).toBe(true);
    });

    it('should identify unauthorized errors', () => {
      expect(
        (provider as unknown as PrivateProvider).isNonRetryableError(new Error('401 Unauthorized')),
      ).toBe(true);
    });

    it('should identify validation errors', () => {
      expect(
        (provider as unknown as PrivateProvider).isNonRetryableError(
          new Error('Validation failed'),
        ),
      ).toBe(true);
    });

    it('should identify invalid api key errors', () => {
      expect(
        (provider as unknown as PrivateProvider).isNonRetryableError(new Error('invalid api key')),
      ).toBe(true);
    });

    it('should allow retry for network errors', () => {
      expect(
        (provider as unknown as PrivateProvider).isNonRetryableError(new Error('Network timeout')),
      ).toBe(false);
    });
  });

  describe('generateArtifactId', () => {
    it('should generate unique artifact IDs', () => {
      const id1 = (provider as unknown as PrivateProvider).generateArtifactId();
      const id2 = (provider as unknown as PrivateProvider).generateArtifactId();
      expect(id1).toMatch(/^artifact-\d+-[a-z0-9]{7}$/);
      expect(id2).toMatch(/^artifact-\d+-[a-z0-9]{7}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('estimateCost', () => {
    it('should return cost estimate', async () => {
      const estimate = await provider.estimateCost({
        operation: 'test.operation',
        params: { prompt: 'test' },
        config: {},
      });
      expect(estimate.costUsd).toBe(0.01);
      expect(estimate.currency).toBe('USD');
    });
  });

  describe('storeArtifact', () => {
    it('should throw when storage is not configured', async () => {
      await expect(
        (provider as unknown as PrivateProvider).storeArtifact(
          Buffer.from('test'),
          'image',
          'image/png',
          {},
        ),
      ).rejects.toThrow('Storage not configured');
    });

    it('should succeed when storage is configured', async () => {
      const mockStore = {
        put: vi.fn().mockResolvedValue('file://test-artifact'),
      };
      provider.setStorage(mockStore as unknown as Parameters<typeof provider.setStorage>[0]);
      const uri = await (provider as unknown as PrivateProvider).storeArtifact(
        Buffer.from('test-data'),
        'image',
        'image/png',
        { width: 100, height: 200 },
        'step-1',
      );
      expect(uri).toBe('file://test-artifact');
      expect(mockStore.put).toHaveBeenCalledOnce();
      const callArg = mockStore.put.mock.calls[0][2];
      expect(callArg.type).toBe('image');
      expect(callArg.mimeType).toBe('image/png');
    });

    it('should generate unique IDs for consecutive calls', async () => {
      const mockStore = {
        put: vi.fn().mockResolvedValue('file://a'),
      };
      provider.setStorage(mockStore as unknown as Parameters<typeof provider.setStorage>[0]);
      await (provider as unknown as PrivateProvider).storeArtifact(
        Buffer.from('a'),
        'image',
        'image/png',
        {},
      );
      await (provider as unknown as PrivateProvider).storeArtifact(
        Buffer.from('b'),
        'audio',
        'audio/mp3',
        {},
      );
      expect(mockStore.put).toHaveBeenCalledTimes(2);
    });
  });

  describe('setStorage', () => {
    it('should set storage instance', () => {
      const mockStore = { put: vi.fn() };
      provider.setStorage(mockStore as unknown as Parameters<typeof provider.setStorage>[0]);
      expect((provider as unknown as PrivateProvider).storage).toBe(mockStore);
    });
  });

  describe('filterDeterministic', () => {
    it('should filter by deterministicParams', () => {
      const result = (provider as unknown as PrivateProvider).filterDeterministic(
        { prompt: 'hello', seed: 42, model: 'm1' },
        {
          deterministicParams: ['prompt', 'model'],
          nonDeterministicParams: [],
          normalize: (x: Record<string, unknown>) => x,
        },
      );
      expect(result).toEqual({ prompt: 'hello', model: 'm1' });
      expect(result.seed).toBeUndefined();
    });

    it('should exclude nonDeterministicParams', () => {
      const result = (provider as unknown as PrivateProvider).filterDeterministic(
        { prompt: 'hello', seed: 42, model: 'm1' },
        {
          deterministicParams: [],
          nonDeterministicParams: ['seed'],
          normalize: (x: Record<string, unknown>) => x,
        },
      );
      expect(result).toEqual({ prompt: 'hello', model: 'm1' });
      expect(result.seed).toBeUndefined();
    });

    it('should handle undefined params', () => {
      const result = (provider as unknown as PrivateProvider).filterDeterministic(undefined, {
        deterministicParams: [],
        nonDeterministicParams: [],
        normalize: (x: Record<string, unknown>) => x,
      });
      expect(result).toEqual({});
    });
  });

  describe('canonicalJson with non-standard types', () => {
    it('should handle function values', () => {
      const fn = () => 42;
      expect((provider as unknown as PrivateProvider).canonicalJson(fn)).toEqual(
        expect.stringContaining('=>'),
      );
    });

    it('should handle symbol values', () => {
      expect((provider as unknown as PrivateProvider).canonicalJson(Symbol('test'))).toBe(
        'Symbol(test)',
      );
    });
  });
});

describe('defineProvider', () => {
  it('should return the same class', () => {
    const defined = defineProvider(TestProvider);
    expect(defined).toBe(TestProvider);
  });
});

describe('static cacheConfig normalize function (coverage)', () => {
  it('should handle all primitive types', () => {
    const fn = MediaProvider.cacheConfig.normalize;
    expect(fn({}).prompt).toBeUndefined();
    expect(fn({ a: 1 }).a).toBe(1);
    expect(fn({ b: '  hello ' }).b).toBe('hello');
    expect(fn({ c: null }).c).toBeNull();
    expect(fn({ d: true }).d).toBe(true);
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    expect(mod.MediaProvider).toBeDefined();
    expect(mod.defineProvider).toBeDefined();
  });
});
