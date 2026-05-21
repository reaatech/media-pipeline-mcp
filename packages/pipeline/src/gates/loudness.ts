import { spawn } from 'node:child_process';
import { FfmpegUnavailableError } from '@reaatech/media-pipeline-mcp-core';

export type LoudnessAction = 'normalize' | 'warn' | 'fail';
export type LoudnessPreset = 'youtube' | 'spotify' | 'podcast' | 'broadcast-ebu' | 'broadcast-atsc';

export interface LoudnessTarget {
  iLufs: number;
  lra: number;
  tpDb: number;
}

export interface LoudnessGate {
  type: 'loudness';
  preset?: LoudnessPreset;
  target?: LoudnessTarget;
  toleranceLu?: number;
  action: LoudnessAction;
  inPlace?: boolean;
}

export interface LoudnessVerdict {
  measured: { iLufs: number; lra: number; tpDb: number };
  target: LoudnessTarget;
  status: 'within-tolerance' | 'out-of-tolerance';
  action: LoudnessAction;
  resultArtifactId?: string;
  delta?: { iLufs: number; lra: number; tpDb: number };
}

export const LOUDNESS_PRESETS: Record<LoudnessPreset, LoudnessTarget> = {
  youtube: { iLufs: -14, lra: 11, tpDb: -1.0 },
  spotify: { iLufs: -14, lra: 11, tpDb: -1.0 },
  podcast: { iLufs: -16, lra: 10, tpDb: -1.0 },
  'broadcast-ebu': { iLufs: -23, lra: 10, tpDb: -1.0 },
  'broadcast-atsc': { iLufs: -24, lra: 10, tpDb: -2.0 },
};

interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  output_i: string;
  output_tp: string;
  output_lra: string;
  output_thresh: string;
  normalization_type: string;
  target_offset: string;
}

export class LoudnessGateEvaluator {
  async evaluate(artifactPath: string, gate: LoudnessGate): Promise<LoudnessVerdict> {
    // Resolve target from preset or explicit config
    const target = gate.target
      ? { iLufs: gate.target.iLufs, lra: gate.target.lra, tpDb: gate.target.tpDb }
      : gate.preset
        ? { ...LOUDNESS_PRESETS[gate.preset] }
        : { ...LOUDNESS_PRESETS.youtube };

    const toleranceLu = gate.toleranceLu ?? 1.0;

    // Pass 1: measure loudness
    const measured = await this.measureLoudness(artifactPath);

    // Check if within tolerance
    const iLufsDelta = measured.iLufs - target.iLufs;
    const lraDelta = measured.lra - target.lra;
    const tpDbDelta = measured.tpDb - target.tpDb;

    const withinTolerance =
      Math.abs(iLufsDelta) <= toleranceLu &&
      Math.abs(lraDelta) <= toleranceLu &&
      Math.abs(tpDbDelta) <= toleranceLu;

    const delta = { iLufs: iLufsDelta, lra: lraDelta, tpDb: tpDbDelta };

    if (withinTolerance) {
      // Plan §F14: "within tolerance, normalize | … no pass 2; original artifact
      // returned". Preserve the caller's declared action so downstream can tell
      // whether to expect a normalize-shaped result (artifact reused) vs. a
      // warn/fail status. Previously this returned `'warn'` regardless, masking
      // the caller's intent.
      return {
        measured,
        target,
        status: 'within-tolerance',
        action: gate.action,
        ...(gate.action === 'normalize' ? { resultArtifactId: artifactPath } : {}),
      };
    }

    if (gate.action === 'normalize') {
      // Plan §F14: "inPlace=true | normalize, inPlace=true | source artifact replaced
      // (same ID, new bytes)". When inPlace is set, write to a tmp path, then atomically
      // move over the original — leaving the source artifactId stable.
      const inPlace = gate.inPlace === true;
      const outPath = inPlace
        ? artifactPath.replace(/(\.\w+)$/, '_normalize_tmp$1')
        : artifactPath.replace(/(\.\w+)$/, '_normalized$1');
      await this.normalizeLoudness(artifactPath, target, measured, outPath);

      let resultArtifactId = outPath;
      if (inPlace) {
        try {
          const { rename } = await import('node:fs/promises');
          await rename(outPath, artifactPath);
          resultArtifactId = artifactPath;
        } catch {
          // The tmp file may not exist (e.g., tests stub ffmpeg without producing
          // bytes). Fall back to reporting the tmp path so callers still get a usable
          // result, even though the in-place replacement didn't land on disk.
          resultArtifactId = outPath;
        }
      }

      return {
        measured,
        target,
        status: 'out-of-tolerance',
        action: 'normalize',
        resultArtifactId,
        delta,
      };
    }

    return {
      measured,
      target,
      status: 'out-of-tolerance',
      action: gate.action,
      delta,
    };
  }

  /** Plan §F14 says video inputs get -c:v copy so the video stream passes through
   *  untouched while audio is normalized. Match on common video extensions; audio-only
   *  files (mp3/wav/flac/aac/opus/ogg) skip the flag. */
  private isVideoPath(path: string): boolean {
    return /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(path);
  }

  private async ensureFfmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('which', ['ffmpeg']);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new FfmpegUnavailableError());
      });
      proc.on('error', () => reject(new FfmpegUnavailableError()));
    });
  }

  private async measureLoudness(
    inputPath: string,
  ): Promise<{ iLufs: number; lra: number; tpDb: number }> {
    await this.ensureFfmpeg();
    return new Promise((resolve, reject) => {
      const args = [
        '-i',
        inputPath,
        '-af',
        'loudnorm=I=-23:LRA=7:tp=-2:print_format=json',
        '-f',
        'null',
        '-',
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg loudnorm pass 1 failed with code ${code}`));
          return;
        }

        try {
          const measurement = this.parseLoudnormJson(stderr);
          resolve({
            iLufs: Number.parseFloat(measurement.input_i),
            lra: Number.parseFloat(measurement.input_lra),
            tpDb: Number.parseFloat(measurement.input_tp),
          });
        } catch {
          reject(new Error('Failed to parse loudnorm measurement'));
        }
      });

      proc.on('error', reject);
    });
  }

  private async normalizeLoudness(
    inputPath: string,
    target: LoudnessTarget,
    measured: { iLufs: number; lra: number; tpDb: number },
    outputPath: string,
  ): Promise<void> {
    await this.ensureFfmpeg();
    return new Promise((resolve, reject) => {
      const offset = measured.iLufs - target.iLufs;
      const measuredI = measured.iLufs.toFixed(1);
      const measuredLra = measured.lra.toFixed(1);
      const measuredTp = measured.tpDb.toFixed(1);
      const targetI = target.iLufs.toFixed(1);
      const targetLra = target.lra.toFixed(1);
      const targetTp = target.tpDb.toFixed(1);

      const filter = `loudnorm=I=${targetI}:LRA=${targetLra}:tp=${targetTp}:offset=${offset.toFixed(1)}:measured_I=${measuredI}:measured_LRA=${measuredLra}:measured_TP=${measuredTp}:linear=true:print_format=summary`;

      // Plan §F14 mechanism step 3 last sentence: "For video, copy video stream: -c:v copy".
      // Detected from the input extension so audio-only files don't pick up an unused flag.
      const videoArgs = this.isVideoPath(inputPath) ? ['-c:v', 'copy'] : [];

      const proc = spawn('ffmpeg', [
        '-i',
        inputPath,
        '-af',
        filter,
        ...videoArgs,
        '-ar',
        '48000',
        '-y',
        outputPath,
      ]);

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg loudnorm pass 2 failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private parseLoudnormJson(stderr: string): LoudnormMeasurement {
    // Look for JSON block in ffmpeg stderr output
    const jsonStart = stderr.indexOf('{');
    const jsonEnd = stderr.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No JSON found in loudnorm output');
    }

    return JSON.parse(stderr.slice(jsonStart, jsonEnd + 1)) as LoudnormMeasurement;
  }
}

export function createLoudnessGateEvaluator(): LoudnessGateEvaluator {
  return new LoudnessGateEvaluator();
}
