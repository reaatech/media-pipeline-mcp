import { describe, expect, it, vi } from 'vitest';
import { ProviderAdapter } from './provider-adapter.js';

describe('ProviderAdapter', () => {
  it('should infer text artifacts from JSON responses', async () => {
    const adapter = new ProviderAdapter({
      name: 'test',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('{}'),
        mimeType: 'application/json',
        metadata: {},
      }),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    });

    const result = await adapter.execute('audio.stt', {}, {});

    expect(result.artifact.type).toBe('text');
  });

  it('should infer document artifacts from document operations', async () => {
    const adapter = new ProviderAdapter({
      name: 'test',
      supportedOperations: ['document.ocr'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('hello'),
        mimeType: 'text/plain',
        metadata: {},
      }),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    });

    const result = await adapter.execute('document.ocr', {}, {});

    expect(result.artifact.type).toBe('document');
  });
});
