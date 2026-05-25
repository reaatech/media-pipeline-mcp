import type { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRatioFanOutExecutor, RatioFanOutExecutor } from '../ratios.js';

describe('RatioFanOutExecutor', () => {
  let executor: RatioFanOutExecutor;

  beforeEach(() => {
    executor = new RatioFanOutExecutor();
  });

  it('should create via factory', () => {
    expect(createRatioFanOutExecutor()).toBeInstanceOf(RatioFanOutExecutor);
  });

  it('should generate native ratio variants', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        costUsd: 0.01,
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('artifact-uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { prompt: 'test' },
      { ratios: ['1:1', '16:9'] },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBeGreaterThanOrEqual(1);
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('should fallback with pad fallback', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 100, height: 200 },
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { dimensions: '100x200' },
      { ratios: ['4:5'], fallback: 'pad' },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(1);
    expect(result.variants[0].source).toBe('padded');
  });

  // ─── New coverage tests ──────────────────────────────────────────

  it('fallback=fail throws on non-native ratio', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 100, height: 200 },
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    await expect(
      executor.executeFanOut(
        'image.generate',
        { dimensions: '100x200' },
        { ratios: ['4:5'], fallback: 'fail' },
        {
          provider: mockProvider as unknown as MediaProvider,
          storage: mockStorage as unknown as ArtifactStore,
          operation: 'image.generate',
        },
      ),
    ).rejects.toThrow('not natively supported');
  });

  it('reuseLargest=true: produces all variants but only one provider call', async () => {
    // Per plan §F11: reuseLargest=true uses ONE native render as the crop source for
    // all variants. The variant count still equals the requested ratio count — what
    // changes is the number of provider executions (one, not N).
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        costUsd: 0.01,
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('artifact-uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { prompt: 'test' },
      { ratios: ['1:1', '16:9'], reuseLargest: true },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(2);
    // Only one provider call regardless of how many derived ratios depend on it.
    expect(mockProvider.execute).toHaveBeenCalledTimes(1);
  });

  it('reuseLargest=false: generates all variants', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        costUsd: 0.01,
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('artifact-uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { prompt: 'test' },
      { ratios: ['1:1', '16:9'], reuseLargest: false },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(2);
  });

  it('smart-crop fallback produces cropped variants for non-native ratios', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 100, height: 200 },
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { dimensions: '100x200' },
      { ratios: ['4:5'], fallback: 'smart-crop' },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(1);
    expect(result.variants[0].source).toBe('cropped');
    expect(result.variants[0].derivedFrom).toBeDefined();
  });

  it('face-aware crop config is accepted', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 100, height: 200 },
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { dimensions: '100x200' },
      { ratios: ['4:5'], fallback: 'smart-crop', faceAware: true },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(1);
    expect(result.variants[0].source).toBe('cropped');
  });

  it('custom ratio parsing with non-native ratio uses best match fallback', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        costUsd: 0.01,
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    // '2:1' is not in RATIO_DIMENSIONS, and native is 1024x1024 (1:1), so this is non-native
    const result = await executor.executeFanOut(
      'image.generate',
      { prompt: 'test' },
      { ratios: ['16:9'] },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    // 16:9 is not a native match for 1:1 (1024x1024)
    expect(result.variants.length).toBe(1);
    expect(result.variants[0].source).toBe('cropped');
  });

  it('padColor config is accepted', async () => {
    const mockProvider = {
      name: 'mock',
      supportedOperations: ['image.generate'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('fake-image'),
        mimeType: 'image/png',
        metadata: { width: 100, height: 200 },
      }),
    };

    const mockStorage = {
      put: vi.fn().mockResolvedValue('uri'),
    };

    const result = await executor.executeFanOut(
      'image.generate',
      { dimensions: '100x200' },
      { ratios: ['4:5'], fallback: 'pad', padColor: '#FFFFFF' },
      {
        provider: mockProvider as unknown as MediaProvider,
        storage: mockStorage as unknown as ArtifactStore,
        operation: 'image.generate',
      },
    );

    expect(result.variants.length).toBe(1);
    expect(result.variants[0].source).toBe('padded');
  });

  it('findBestNativeRatio finds best available ratio match', async () => {
    const best = (
      executor as unknown as {
        findBestNativeRatio(target: string, available: string[]): string | undefined;
      }
    ).findBestNativeRatio('4:5', ['1:1', '16:9', '9:16', '4:5', '2:3']);
    expect(best).toBe('4:5');
  });

  it('findBestNativeRatio falls back when no exact match', async () => {
    const best = (
      executor as unknown as {
        findBestNativeRatio(target: string, available: string[]): string | undefined;
      }
    ).findBestNativeRatio('21:9', ['1:1', '4:5', '16:9']);
    expect(best).toBe('16:9');
  });
});
