import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOUDNESS_PRESETS,
  LoudnessGateEvaluator,
  createLoudnessGateEvaluator,
} from '../gates/loudness.js';
import type { LoudnessPreset } from '../gates/loudness.js';

describe('LoudnessGateEvaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockLoudness(measurement: { iLufs: number; lra: number; tpDb: number }) {
    vi.spyOn(
      LoudnessGateEvaluator.prototype as unknown as {
        measureLoudness: (...args: unknown[]) => Promise<unknown>;
      },
      'measureLoudness',
    ).mockResolvedValue(measurement);
    vi.spyOn(
      LoudnessGateEvaluator.prototype as unknown as {
        normalizeLoudness: (...args: unknown[]) => Promise<unknown>;
      },
      'normalizeLoudness',
    ).mockResolvedValue(undefined);
  }

  it('should have valid presets', () => {
    expect(LOUDNESS_PRESETS.youtube.iLufs).toBe(-14);
    expect(LOUDNESS_PRESETS.spotify.iLufs).toBe(-14);
    expect(LOUDNESS_PRESETS.podcast.iLufs).toBe(-16);
    expect(LOUDNESS_PRESETS['broadcast-ebu'].iLufs).toBe(-23);
    expect(LOUDNESS_PRESETS['broadcast-atsc'].iLufs).toBe(-24);
  });

  it('should create via factory function', () => {
    expect(createLoudnessGateEvaluator()).toBeInstanceOf(LoudnessGateEvaluator);
  });

  it('should exist as a class', () => {
    expect(new LoudnessGateEvaluator()).toBeDefined();
    expect(typeof new LoudnessGateEvaluator().evaluate).toBe('function');
  });

  it('out of tolerance with action=normalize — normalization triggered', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const normalizeSpy = vi.spyOn(
      LoudnessGateEvaluator.prototype as unknown as {
        normalizeLoudness: (...args: unknown[]) => Promise<unknown>;
      },
      'normalizeLoudness',
    );
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      toleranceLu: 1.0,
      action: 'normalize',
    });
    expect(result.status).toBe('out-of-tolerance');
    expect(result.action).toBe('normalize');
    expect(result.resultArtifactId).toContain('_normalized');
    expect(normalizeSpy).toHaveBeenCalled();
    expect(result.delta!.iLufs).toBeCloseTo(-6, 0);
  });

  it('action=warn, out of tolerance — warn result', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      toleranceLu: 1.0,
      action: 'warn',
    });
    expect(result.status).toBe('out-of-tolerance');
    expect(result.action).toBe('warn');
    expect(result.resultArtifactId).toBeUndefined();
  });

  it('within tolerance — status=within-tolerance', async () => {
    mockLoudness({ iLufs: -15, lra: 10, tpDb: -1.5 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      toleranceLu: 2.0,
      action: 'warn',
    });
    expect(result.status).toBe('within-tolerance');
    expect(result.action).toBe('warn');
  });

  it('preset used when target not provided', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      preset: 'youtube',
      action: 'warn',
    });
    expect(result.target.iLufs).toBe(-14);
  });

  it('target takes precedence when both preset and target', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      preset: 'broadcast-ebu',
      target: { iLufs: -12, lra: 8, tpDb: -2 },
      action: 'warn',
    });
    expect(result.target.iLufs).toBe(-12);
  });

  it('defaults to youtube preset when neither preset nor target', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      action: 'warn',
    });
    expect(result.target.iLufs).toBe(-14);
  });

  it('custom target only', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -18, lra: 7, tpDb: -2.5 },
      action: 'warn',
    });
    expect(result.target.iLufs).toBe(-18);
  });

  it('all 5 presets have correct values', () => {
    const expectations: Record<LoudnessPreset, { iLufs: number; lra: number; tpDb: number }> = {
      youtube: { iLufs: -14, lra: 11, tpDb: -1.0 },
      spotify: { iLufs: -14, lra: 11, tpDb: -1.0 },
      podcast: { iLufs: -16, lra: 10, tpDb: -1.0 },
      'broadcast-ebu': { iLufs: -23, lra: 10, tpDb: -1.0 },
      'broadcast-atsc': { iLufs: -24, lra: 10, tpDb: -2.0 },
    };
    for (const [preset, expected] of Object.entries(expectations)) {
      expect(LOUDNESS_PRESETS[preset as LoudnessPreset].iLufs).toBe(expected.iLufs);
    }
  });

  it('action=fail, out of tolerance', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      action: 'fail',
    });
    expect(result.status).toBe('out-of-tolerance');
    expect(result.action).toBe('fail');
  });

  it('inPlace flag accepted', async () => {
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      action: 'normalize',
      inPlace: true,
    });
    expect(result.status).toBe('out-of-tolerance');
  });

  it('F14 inPlace=true uses a tmp output path (not the *_normalized.* derivation)', async () => {
    // Drives the inPlace code branch (out-of-tolerance, action=normalize, inPlace=true).
    // Stubbed ffmpeg means the tmp file never lands on disk, so the rename catch-block
    // surfaces the tmp path. We assert it is NOT the legacy `_normalized.<ext>` form
    // (which is what non-inPlace runs return) — that validates the branch ran.
    mockLoudness({ iLufs: -22, lra: 8, tpDb: -3 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      action: 'normalize',
      inPlace: true,
    });
    expect(result.action).toBe('normalize');
    expect(result.resultArtifactId).toContain('_normalize_tmp');
    expect(result.resultArtifactId).not.toContain('_normalized');
  });

  it('F14 within-tolerance preserves gate.action and surfaces resultArtifactId for normalize', async () => {
    // 0.5 LU off → within tolerance=1. Plan §F14: "within tolerance, normalize | …
    // no pass 2; original artifact returned". Action must reflect caller's intent.
    mockLoudness({ iLufs: -15.5, lra: 9.8, tpDb: -1.2 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      action: 'normalize',
    });
    expect(result.status).toBe('within-tolerance');
    expect(result.action).toBe('normalize');
    expect(result.resultArtifactId).toBe('/fake/audio.wav');
  });

  it('F14 within-tolerance with action=warn does not synthesize a resultArtifactId', async () => {
    mockLoudness({ iLufs: -15.5, lra: 9.8, tpDb: -1.2 });
    const result = await new LoudnessGateEvaluator().evaluate('/fake/audio.wav', {
      type: 'loudness',
      target: { iLufs: -16, lra: 10, tpDb: -1 },
      action: 'warn',
    });
    expect(result.status).toBe('within-tolerance');
    expect(result.action).toBe('warn');
    expect(result.resultArtifactId).toBeUndefined();
  });

  describe('parseLoudnormJson', () => {
    it('parses JSON from stderr output', () => {
      const stderr = `prefix\n{"input_i":"-14.2","input_tp":"-1.0","input_lra":"7.5","input_thresh":"-24.0","output_i":"-14.0","output_tp":"-1.0","output_lra":"7.0","output_thresh":"-23.0","normalization_type":"dynamic","target_offset":"0.5"}`;
      const result = (
        new LoudnessGateEvaluator() as unknown as {
          parseLoudnormJson(stderr: string): Record<string, string>;
        }
      ).parseLoudnormJson(stderr);
      expect(result.input_i).toBe('-14.2');
    });

    it('throws when no JSON found', () => {
      expect(() =>
        (
          new LoudnessGateEvaluator() as unknown as {
            parseLoudnormJson(stderr: string): Record<string, string>;
          }
        ).parseLoudnormJson('no braces'),
      ).toThrow('No JSON found');
    });

    it('throws on empty output', () => {
      expect(() =>
        (
          new LoudnessGateEvaluator() as unknown as {
            parseLoudnormJson(stderr: string): Record<string, string>;
          }
        ).parseLoudnormJson(''),
      ).toThrow('No JSON found');
    });
  });
});
