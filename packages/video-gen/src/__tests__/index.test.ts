import { describe, expect, it } from 'vitest';
import * as videoGen from '../index.js';

describe('package exports', () => {
  it('should export VideoGenOperations class', () => {
    expect(videoGen.VideoGenOperations).toBeDefined();
    expect(typeof videoGen.VideoGenOperations).toBe('function');
  });

  it('should export createVideoGenOperations factory', () => {
    expect(videoGen.createVideoGenOperations).toBeDefined();
    expect(typeof videoGen.createVideoGenOperations).toBe('function');
  });

  it('should export FfmpegWrapper class', () => {
    expect(videoGen.FfmpegWrapper).toBeDefined();
    expect(typeof videoGen.FfmpegWrapper).toBe('function');
  });

  it('should export SubtitlePipeline class', () => {
    expect(videoGen.SubtitlePipeline).toBeDefined();
    expect(typeof videoGen.SubtitlePipeline).toBe('function');
  });

  it('should export createSubtitlePipeline factory', () => {
    expect(videoGen.createSubtitlePipeline).toBeDefined();
    expect(typeof videoGen.createSubtitlePipeline).toBe('function');
  });

  it('should export types as values', () => {
    // BurnInOptions is a type-only export, so it's intentionally not present at
    // runtime. Reading the property must not exist on the namespace.
    expect((videoGen as Record<string, unknown>).BurnInOptions).toBeUndefined();
  });
});
