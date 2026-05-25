import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurnInOptions, LoudnessMeasurement, LoudnessTarget } from '../ffmpeg.js';
import { FfmpegWrapper } from '../ffmpeg.js';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

function makeMockProcess(stderrData?: string) {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') {
        setTimeout(() => (handler as (code: number) => void)(0), 0);
      }
      return undefined;
    }),
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'data') setTimeout(() => handler(Buffer.from('')), 0);
        if (event === 'end') setTimeout(() => handler(), 0);
        return undefined;
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'data' && stderrData) {
          setTimeout(() => handler(Buffer.from(stderrData)), 0);
        } else if (event === 'data') {
          setTimeout(() => handler(Buffer.from('')), 0);
        }
        if (event === 'end') setTimeout(() => handler(), 0);
        return undefined;
      }),
    },
  };
}

function makeFailingProcess(code: number, stderr: string) {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') {
        setTimeout(() => (handler as (code: number) => void)(code), 0);
      }
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'data') setTimeout(() => handler(Buffer.from(stderr)), 0);
        if (event === 'end') setTimeout(() => handler(), 0);
        return undefined;
      }),
    },
  };
}

describe('FfmpegWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeMockProcess());
  });

  describe('isAvailable', () => {
    it('should return true when ffmpeg is found', async () => {
      mockSpawn.mockReturnValueOnce(makeMockProcess());
      const result = await FfmpegWrapper.isAvailable();
      expect(result).toBe(true);
    });

    it('should return false when which fails', async () => {
      mockSpawn.mockReturnValueOnce({
        on: vi.fn((event: string, handler: ((code: number) => void) | ((err: Error) => void)) => {
          if (event === 'close') setTimeout(() => (handler as (code: number) => void)(1), 0);
          if (event === 'error')
            setTimeout(() => (handler as (err: Error) => void)(new Error('not found')), 0);
          return undefined;
        }),
      });
      const result = await FfmpegWrapper.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('exec', () => {
    it('should spawn ffmpeg with provided args', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.exec(['-i', 'input.mp4', '-y', 'output.mp4']);
      const call = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg');
      expect(call).toBeDefined();
      expect(call![1]).toEqual(['-i', 'input.mp4', '-y', 'output.mp4']);
    });

    it('should reject on non-zero exit code', async () => {
      mockSpawn
        .mockReturnValueOnce(makeMockProcess()) // for isAvailable
        .mockReturnValueOnce(makeFailingProcess(1, 'error output'));
      await expect(FfmpegWrapper.exec(['bad'])).rejects.toThrow('ffmpeg exited with code 1');
    });
  });

  describe('extractAudio', () => {
    it('should construct default aac extraction command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.extractAudio('input.mp4', 'output.aac');
      const call = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg');
      expect(call).toBeDefined();
      expect(call![1]).toContain('-i');
      expect(call![1]).toContain('input.mp4');
      expect(call![1]).toContain('-q:a');
      expect(call![1]).toContain('0');
      expect(call![1]).toContain('-map');
      expect(call![1]).toContain('a');
      expect(call![1]).toContain('output.aac');
    });

    it('should construct mp3 extraction command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.extractAudio('input.mp4', 'out.mp3', 'mp3');
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toContain('-acodec');
      expect(args).toContain('libmp3lame');
    });

    it('should construct opus extraction command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.extractAudio('input.mp4', 'out.opus', 'opus');
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toContain('-acodec');
      expect(args).toContain('libopus');
    });
  });

  describe('burnSubtitles', () => {
    it('should construct burn subtitles command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.burnSubtitles('input.mp4', 'subs.ass', 'output.mp4');
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toEqual([
        '-i',
        'input.mp4',
        '-vf',
        'ass=subs.ass',
        '-c:a',
        'copy',
        '-y',
        'output.mp4',
      ]);
    });

    it('should accept burn-in options without changing command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      const options: BurnInOptions = { font: 'Arial', fontSize: 24 };
      await FfmpegWrapper.burnSubtitles('in.mp4', 'sub.ass', 'out.mp4', options);
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toContain('-vf');
      expect(args).toContain('ass=sub.ass');
    });
  });

  describe('measureLoudness', () => {
    it('should parse loudness measurement from stderr JSON', async () => {
      const loudnessJson = JSON.stringify({
        input_i: '-14.2',
        input_lra: '3.5',
        input_tp: '-1.0',
      });
      const mockProc = makeMockProcess(`prefix\n${loudnessJson}\nsuffix`);
      mockSpawn.mockReturnValue(mockProc);

      const result = await FfmpegWrapper.measureLoudness('input.mp4');
      expect(result).toEqual({
        iLufs: -14.2,
        lra: 3.5,
        tpDb: -1.0,
      });
    });

    it('should throw when no JSON in stderr', async () => {
      mockSpawn.mockReturnValue(makeMockProcess('no json here'));
      await expect(FfmpegWrapper.measureLoudness('input.mp4')).rejects.toThrow(
        'Could not parse loudness measurement',
      );
    });
  });

  describe('normalizeLoudness', () => {
    it('should construct normalize loudness command with offset', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      const target: LoudnessTarget = { iLufs: -23, lra: 7, tpDb: -2 };
      const measured: LoudnessMeasurement = { iLufs: -14.2, lra: 3.5, tpDb: -1.0 };

      await FfmpegWrapper.normalizeLoudness('input.mp4', target, measured, 'output.mp4');

      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      const afIndex = args.indexOf('-af');
      expect(afIndex).toBeGreaterThan(-1);
      const filter = args[afIndex + 1];
      expect(filter).toContain('loudnorm=I=-23.0');
      expect(filter).toContain('LRA=7.0');
      expect(filter).toContain('tp=-2.0');
      expect(filter).toContain('offset=8.8');
      expect(filter).toContain('measured_I=-14.2');
      expect(filter).toContain('measured_LRA=3.5');
      expect(filter).toContain('measured_TP=-1.0');
      expect(args).toContain('-ar');
      expect(args).toContain('48000');
      expect(args).toContain('output.mp4');
    });
  });

  describe('cropVideo', () => {
    it('should construct crop command', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.cropVideo('input.mp4', 'output.mp4', 640, 480);
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toEqual([
        '-i',
        'input.mp4',
        '-vf',
        'crop=640:480:0:0',
        '-c:a',
        'copy',
        '-y',
        'output.mp4',
      ]);
    });

    it('should construct crop command with custom x/y', async () => {
      mockSpawn.mockReturnValue(makeMockProcess());
      await FfmpegWrapper.cropVideo('input.mp4', 'output.mp4', 320, 240, 100, 50);
      const args = mockSpawn.mock.calls.find((c: unknown[]) => c[0] === 'ffmpeg')?.[1] ?? [];
      expect(args).toContain('crop=320:240:100:50');
    });
  });

  describe('edge cases', () => {
    it('should throw FfmpegUnavailableError when ffmpeg not found', async () => {
      vi.spyOn(FfmpegWrapper, 'isAvailable').mockResolvedValue(false);
      await expect(FfmpegWrapper.exec(['-i', 'x', 'y'])).rejects.toThrow();
    });

    it('should throw on spawn error', async () => {
      vi.spyOn(FfmpegWrapper, 'isAvailable').mockResolvedValue(true);
      const errorProcess = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'error') setTimeout(() => handler(new Error('spawn failed')), 0);
          return undefined;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      mockSpawn.mockReturnValue(errorProcess);
      await expect(FfmpegWrapper.exec(['bad'])).rejects.toThrow('spawn failed');
    });
  });
});
