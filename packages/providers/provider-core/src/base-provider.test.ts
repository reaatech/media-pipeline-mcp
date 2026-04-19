import { describe, it, expect, beforeEach } from 'vitest';
import { MediaProvider } from './base-provider.js';
import type { ProviderInput, ProviderOutput, ProviderHealth } from './base-provider.js';

// Create a concrete implementation for testing
class TestProvider extends MediaProvider {
  readonly name = 'test-provider';
  readonly supportedOperations = ['test.operation'];

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true };
  }

  async execute(_input: ProviderInput): Promise<ProviderOutput> {
    return {
      data: Buffer.from('test'),
      mimeType: 'text/plain',
      metadata: {},
    };
  }
}

describe('MediaProvider', () => {
  let provider: TestProvider;

  beforeEach(() => {
    provider = new TestProvider();
  });

  describe('executeWithRetry', () => {
    it('should succeed on first attempt', async () => {
      const input: ProviderInput = {
        operation: 'test.operation',
        params: {},
        config: {},
      };

      const result = await provider.executeWithRetry(input);
      expect(result.data).toEqual(Buffer.from('test'));
      expect(result.mimeType).toBe('text/plain');
    });

    it('should retry on transient errors', async () => {
      let attempts = 0;
      const providerWithFailures = new (class extends MediaProvider {
        readonly name = 'flaky-provider';
        readonly supportedOperations = ['test.operation'];

        async healthCheck(): Promise<ProviderHealth> {
          return { healthy: true };
        }

        async execute(_input: ProviderInput): Promise<ProviderOutput> {
          attempts++;
          if (attempts < 3) {
            throw new Error('Network error');
          }
          return {
            data: Buffer.from('success'),
            mimeType: 'text/plain',
            metadata: {},
          };
        }
      })();

      const result = await providerWithFailures.executeWithRetry({
        operation: 'test.operation',
        params: {},
        config: {},
      });

      expect(result.data).toEqual(Buffer.from('success'));
      expect(attempts).toBe(3);
    });

    it('should not retry on authentication errors', async () => {
      let attempts = 0;
      const providerWithAuthError = new (class extends MediaProvider {
        readonly name = 'auth-error-provider';
        readonly supportedOperations = ['test.operation'];

        async healthCheck(): Promise<ProviderHealth> {
          return { healthy: true };
        }

        async execute(_input: ProviderInput): Promise<ProviderOutput> {
          attempts++;
          throw new Error('Invalid API key - authentication failed');
        }
      })();

      await expect(
        providerWithAuthError.executeWithRetry({
          operation: 'test.operation',
          params: {},
          config: {},
        })
      ).rejects.toThrow('authentication');

      expect(attempts).toBe(1);
    });
  });

  describe('isNonRetryableError', () => {
    it('should identify authentication errors as non-retryable', () => {
      const error = new Error('Authentication failed');
      expect((provider as any).isNonRetryableError(error)).toBe(true);
    });

    it('should identify unauthorized errors as non-retryable', () => {
      const error = new Error('401 Unauthorized');
      expect((provider as any).isNonRetryableError(error)).toBe(true);
    });

    it('should identify validation errors as non-retryable', () => {
      const error = new Error('Validation failed');
      expect((provider as any).isNonRetryableError(error)).toBe(true);
    });

    it('should allow retry for network errors', () => {
      const error = new Error('Network timeout');
      expect((provider as any).isNonRetryableError(error)).toBe(false);
    });
  });

  describe('generateArtifactId', () => {
    it('should generate unique artifact IDs', () => {
      const id1 = (provider as any).generateArtifactId();
      const id2 = (provider as any).generateArtifactId();

      expect(id1).toMatch(/^artifact-\d+-[a-z0-9]{7}$/);
      expect(id2).toMatch(/^artifact-\d+-[a-z0-9]{7}$/);
      expect(id1).not.toBe(id2);
    });
  });
});
