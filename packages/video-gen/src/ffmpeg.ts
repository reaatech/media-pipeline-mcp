import { spawn } from 'node:child_process';
import { FfmpegUnavailableError } from '@reaatech/media-pipeline-mcp-core';

export interface BurnInOptions {
  font?: string;
  fontSize?: number;
  fontColor?: string;
  outline?: { color: string; widthPx: number };
  position?: 'top' | 'middle' | 'bottom';
  marginPx?: number;
  background?: { color: string; opacity: number };
}

export interface LoudnessMeasurement {
  iLufs: number;
  lra: number;
  tpDb: number;
}

export type LoudnessTarget = {
  iLufs: number;
  lra: number;
  tpDb: number;
};

// biome-ignore lint/complexity/noStaticOnlyClass: kept as a class so existing call sites (FfmpegWrapper.exec, .isAvailable, .measureLoudness, etc.) don't need to change. A function module would force a breaking rename across the consumer surface.
export class FfmpegWrapper {
  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', ['ffmpeg']);
      proc.on('close', (code) => {
        resolve(code === 0);
      });
      proc.on('error', () => resolve(false));
    });
  }

  static async exec(
    args: string[],
    options?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    if (!(await FfmpegWrapper.isAvailable())) {
      throw new FfmpegUnavailableError();
    }
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, {
        timeout: options?.timeout ?? 120_000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        }
      });

      proc.on('error', reject);
    });
  }

  static async extractAudio(inputPath: string, outputPath: string, format?: string): Promise<void> {
    const fmt = format ?? 'aac';
    const args = ['-i', inputPath, '-q:a', '0', '-map', 'a', outputPath];

    if (fmt === 'mp3') {
      args.splice(2, 0, '-acodec', 'libmp3lame');
    } else if (fmt === 'opus') {
      args.splice(2, 0, '-acodec', 'libopus');
    }

    await FfmpegWrapper.exec(args);
  }

  static async burnSubtitles(
    inputPath: string,
    subtitlePath: string,
    outputPath: string,
    _options?: BurnInOptions,
  ): Promise<void> {
    await FfmpegWrapper.exec([
      '-i',
      inputPath,
      '-vf',
      `ass=${subtitlePath}`,
      '-c:a',
      'copy',
      '-y',
      outputPath,
    ]);
  }

  static async measureLoudness(inputPath: string): Promise<LoudnessMeasurement> {
    const { stderr } = await FfmpegWrapper.exec([
      '-i',
      inputPath,
      '-af',
      'loudnorm=I=-23:LRA=7:tp=-2:print_format=json',
      '-f',
      'null',
      '-',
    ]);

    const jsonStart = stderr.indexOf('{');
    const jsonEnd = stderr.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('Could not parse loudness measurement from ffmpeg output');
    }

    const data = JSON.parse(stderr.slice(jsonStart, jsonEnd + 1));

    return {
      iLufs: Number.parseFloat(data.input_i),
      lra: Number.parseFloat(data.input_lra),
      tpDb: Number.parseFloat(data.input_tp),
    };
  }

  static async normalizeLoudness(
    inputPath: string,
    target: LoudnessTarget,
    measured: LoudnessMeasurement,
    outputPath: string,
  ): Promise<void> {
    const offset = measured.iLufs - target.iLufs;
    const filter = `loudnorm=I=${target.iLufs.toFixed(1)}:LRA=${target.lra.toFixed(1)}:tp=${target.tpDb.toFixed(1)}:offset=${offset.toFixed(1)}:measured_I=${measured.iLufs.toFixed(1)}:measured_LRA=${measured.lra.toFixed(1)}:measured_TP=${measured.tpDb.toFixed(1)}:linear=true:print_format=summary`;

    await FfmpegWrapper.exec(['-i', inputPath, '-af', filter, '-ar', '48000', '-y', outputPath]);
  }

  static async cropVideo(
    inputPath: string,
    outputPath: string,
    width: number,
    height: number,
    x?: number,
    y?: number,
  ): Promise<void> {
    const cropX = x ?? 0;
    const cropY = y ?? 0;

    await FfmpegWrapper.exec([
      '-i',
      inputPath,
      '-vf',
      `crop=${width}:${height}:${cropX}:${cropY}`,
      '-c:a',
      'copy',
      '-y',
      outputPath,
    ]);
  }
}
