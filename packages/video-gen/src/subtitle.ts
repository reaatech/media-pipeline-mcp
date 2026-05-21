import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FfmpegUnavailableError } from '@reaatech/media-pipeline-mcp-core';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleConfig {
  artifactId: string;
  language?: string;
  format?: SubtitleFormat;
  sttProvider?: string;
  sttModel?: string;
  burnIn?: BurnInOptions;
  diarize?: boolean;
  translateTo?: string;
}

export interface BurnInOptions {
  font?: string;
  fontSize?: number;
  fontColor?: string;
  outline?: { color: string; widthPx: number };
  position?: 'top' | 'middle' | 'bottom';
  marginPx?: number;
  background?: { color: string; opacity: number };
}

export interface SubtitleOutput {
  subtitleArtifactId: string;
  burnedArtifactId?: string;
  language: string;
  segments: SubtitleSegment[];
  totalCostUsd: number;
}

export interface SubtitleSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

const MAX_LINE_LENGTH = 42;
const MAX_CPS = 17; // Characters per second

export class SubtitlePipeline {
  constructor(
    private providers: Map<string, MediaProvider>,
    private storage: ArtifactStore,
  ) {}

  private getProvider(operation: string, preferred?: string): MediaProvider {
    const preferredProvider = preferred ? this.providers.get(preferred) : undefined;
    if (preferredProvider?.supportedOperations.includes(operation)) {
      return preferredProvider;
    }

    for (const provider of this.providers.values()) {
      if (provider.supportedOperations.includes(operation)) {
        return provider;
      }
    }

    throw new Error(`No provider available for ${operation}`);
  }

  async generate(config: SubtitleConfig): Promise<SubtitleOutput> {
    const format = config.format ?? 'srt';
    const language = config.language ?? 'en';

    // 1. Materialise the source artifact to a temp path so ffmpeg can read it.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-'));
    const tempInputPath = path.join(tempDir, 'input.mp4');
    const tempAudioPath = path.join(tempDir, 'audio.aac');

    try {
      const storageResult = await this.storage.get(config.artifactId);
      const inputBuf = await this.streamToBuffer(storageResult.data as NodeJS.ReadableStream);
      fs.writeFileSync(tempInputPath, inputBuf);

      // 2. Extract audio stream (no-op pass-through if input is already audio).
      await this.extractAudio(tempInputPath, tempAudioPath);
      const audioBuffer = fs.readFileSync(tempAudioPath);

      // 3. Run STT via provider
      const sttProvider = this.getProvider('audio.stt', config.sttProvider);
      const sttInput: ProviderInput = {
        operation: 'audio.stt',
        params: {
          audio_data: audioBuffer,
          language,
          diarize: config.diarize ?? false,
          model: config.sttModel,
        },
        config: {},
      };

      const sttResult = await sttProvider.execute(sttInput);

      // Parse STT output into segments
      let segments = this.parseSttSegments(sttResult.data as Buffer, sttResult.metadata);

      // 4. Post-process segments (line wrapping, CPS limit)
      segments = this.postProcessSegments(segments);

      // 5. Translate if requested
      const finalLanguage = language;
      if (config.translateTo && config.translateTo !== language) {
        segments = await this.translateSegments(segments, config.translateTo);
      }

      // 6. Encode to subtitle format
      const subtitleContent = this.encode(format, segments);
      const subtitleId = `artifact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      await this.storage.put(subtitleId, Buffer.from(subtitleContent, 'utf-8'), {
        id: subtitleId,
        type: 'text',
        mimeType: this.mimeTypeForFormat(format),
        metadata: {
          format,
          language: finalLanguage,
          segmentCount: segments.length,
          operation: 'subtitle.generate',
        },
      });

      // 7. Burn subtitles if requested
      let burnedArtifactId: string | undefined;

      if (config.burnIn) {
        const subtitlePath = path.join(tempDir, `subtitles.${format}`);
        fs.writeFileSync(subtitlePath, subtitleContent, 'utf-8');

        // Convert to ASS for burning
        const assPath = path.join(tempDir, 'subtitles.ass');
        const assContent =
          format === 'ass'
            ? subtitleContent
            : this.convertToAss(subtitleContent, format, config.burnIn);
        fs.writeFileSync(assPath, assContent, 'utf-8');

        const outputVideoPath = path.join(tempDir, 'output.mp4');

        await this.burnSubtitles(tempInputPath, assPath, outputVideoPath);

        const burnedBuffer = fs.readFileSync(outputVideoPath);
        burnedArtifactId = `artifact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        await this.storage.put(burnedArtifactId, burnedBuffer, {
          id: burnedArtifactId,
          type: 'video',
          mimeType: 'video/mp4',
          metadata: {
            operation: 'subtitle.burn',
            sourceArtifact: config.artifactId,
            subtitleArtifact: subtitleId,
            subtitleFormat: format,
            burnOptions: config.burnIn,
          },
        });
      }

      return {
        subtitleArtifactId: subtitleId,
        burnedArtifactId,
        language: finalLanguage,
        segments,
        totalCostUsd: 0,
      };
    } finally {
      // Cleanup temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
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

  private async extractAudio(inputId: string, outputPath: string): Promise<void> {
    await this.ensureFfmpeg();
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-i', inputId, '-q:a', '0', '-map', 'a', '-y', outputPath]);

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg audio extraction failed with code ${code}`));
      });

      proc.on('error', reject);
    });
  }

  private async burnSubtitles(
    inputPath: string,
    assPath: string,
    outputPath: string,
  ): Promise<void> {
    await this.ensureFfmpeg();
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i',
        inputPath,
        '-vf',
        `ass=${assPath}`,
        '-c:a',
        'copy',
        '-y',
        outputPath,
      ]);

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg subtitle burn failed with code ${code}`));
      });

      proc.on('error', reject);
    });
  }

  private parseSttSegments(data: Buffer, _metadata: Record<string, unknown>): SubtitleSegment[] {
    const raw = data.toString('utf-8');

    // Try parsing as JSON (whisper-style verbose_json)
    try {
      const parsed = JSON.parse(raw);

      if (parsed.segments && Array.isArray(parsed.segments)) {
        return parsed.segments.map(
          (seg: { start: number; end: number; text: string; speaker?: string }, i: number) => ({
            index: i + 1,
            startMs: Math.round(seg.start * 1000),
            endMs: Math.round(seg.end * 1000),
            text: (seg.text ?? '').trim(),
            speaker: seg.speaker,
          }),
        );
      }

      // Single transcription
      return [
        {
          index: 1,
          startMs: 0,
          endMs: 5000,
          text: parsed.text?.trim() ?? raw.trim(),
        },
      ];
    } catch {
      // Plain text fallback
      return [
        {
          index: 1,
          startMs: 0,
          endMs: 5000,
          text: raw.trim(),
        },
      ];
    }
  }

  private postProcessSegments(segments: SubtitleSegment[]): SubtitleSegment[] {
    return segments.map((seg, i) => {
      let text = seg.text;

      // Apply line wrapping at MAX_LINE_LENGTH
      text = this.wrapText(text, MAX_LINE_LENGTH);

      // Enforce CPS limit by splitting if needed
      const durationSec = (seg.endMs - seg.startMs) / 1000;
      if (durationSec > 0) {
        const cps = text.length / durationSec;
        if (cps > MAX_CPS) {
          // Reduce text length proportionally
          const maxChars = Math.floor(MAX_CPS * durationSec);
          text = text.substring(0, maxChars);
          // Break at word boundary
          const lastSpace = text.lastIndexOf(' ');
          if (lastSpace > 0) {
            text = text.substring(0, lastSpace);
          }
        }
      }

      return { ...seg, text, index: i + 1 };
    });
  }

  private wrapText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;

    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (`${currentLine} ${word}`.trim().length > maxLen) {
        if (currentLine) lines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += (currentLine ? ' ' : '') + word;
      }
    }

    if (currentLine) lines.push(currentLine.trim());

    return lines.join('\n');
  }

  private async translateSegments(
    segments: SubtitleSegment[],
    targetLanguage: string,
  ): Promise<SubtitleSegment[]> {
    const provider = this.getProvider('text.complete');
    const texts = segments.map((s) => s.text).join('\n---\n');

    const input: ProviderInput = {
      operation: 'text.complete',
      params: {
        prompt: `Translate the following subtitle text to ${targetLanguage}. Keep line breaks. Return only the translated text:\n\n${texts}`,
        model: 'llama3.2',
      },
      config: {},
    };

    const result = await provider.execute(input);
    const translated = result.data.toString('utf-8');
    const translatedLines = translated.split('\n---\n');

    return segments.map((seg, i) => ({
      ...seg,
      text: translatedLines[i]?.trim() ?? seg.text,
    }));
  }

  private encode(format: SubtitleFormat, segments: SubtitleSegment[]): string {
    switch (format) {
      case 'srt':
        return this.encodeSRT(segments);
      case 'vtt':
        return this.encodeVTT(segments);
      case 'ass':
        return this.encodeASS(segments);
    }
  }

  private encodeSRT(segments: SubtitleSegment[]): string {
    return segments
      .map((seg) => {
        const start = this.formatSrtTime(seg.startMs);
        const end = this.formatSrtTime(seg.endMs);
        const speaker = seg.speaker ? `${seg.speaker}: ` : '';
        return `${seg.index}\n${start} --> ${end}\n${speaker}${seg.text}\n`;
      })
      .join('\n');
  }

  private encodeVTT(segments: SubtitleSegment[]): string {
    const header = 'WEBVTT\n\n';
    return (
      header +
      segments
        .map((seg) => {
          const start = this.formatVttTime(seg.startMs);
          const end = this.formatVttTime(seg.endMs);
          const speaker = seg.speaker ? `<v ${seg.speaker}>` : '';
          const speakerEnd = seg.speaker ? '</v>' : '';
          return `${start} --> ${end}\n${speaker}${seg.text}${speakerEnd}\n`;
        })
        .join('\n')
    );
  }

  private encodeASS(segments: SubtitleSegment[]): string {
    const header =
      '[Script Info]\n' +
      'ScriptType: v4.00+\n' +
      'PlayResX: 1920\n' +
      'PlayResY: 1080\n' +
      'WrapStyle: 0\n' +
      '\n' +
      '[V4+ Styles]\n' +
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
      'Style: Default,Arial,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n' +
      '\n' +
      '[Events]\n' +
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

    const events = segments
      .map((seg) => {
        const start = this.formatAssTime(seg.startMs);
        const end = this.formatAssTime(seg.endMs);
        const speaker = seg.speaker ? `\\h(${seg.speaker})\\N` : '';
        return `Dialogue: 0,${start},${end},Default,,0,0,0,,${speaker}${seg.text.replace(/\n/g, '\\N')}`;
      })
      .join('\n');

    return `${header + events}\n`;
  }

  private formatSrtTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const millis = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  private formatVttTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const millis = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  private formatAssTime(ms: number): string {
    const totalSec = ms / 1000;
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec) % 60;
    const cs = Math.floor((ms % 1000) / 10);
    return `${String(h).padStart(1, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  private convertToAss(content: string, fromFormat: SubtitleFormat, burnIn: BurnInOptions): string {
    if (fromFormat === 'ass') return content;

    // Parse SRT or VTT and convert to ASS
    const segments = this.parseFromFormat(content, fromFormat);

    const fontName = burnIn.font ?? 'Arial';
    const fontSize = burnIn.fontSize ?? 24;
    const fontColor = burnIn.fontColor ?? 'FFFFFF';
    const primaryColour = `&H00${fontColor.replace('#', '')}`;
    const outlineW = burnIn.outline?.widthPx ?? 2;
    const outlineColor = burnIn.outline?.color ?? '000000';
    const outlineColour = `&H00${outlineColor.replace('#', '')}`;
    const marginV = burnIn.marginPx ?? 10;
    const alignment = burnIn.position === 'top' ? 8 : burnIn.position === 'middle' ? 4 : 2;

    let bgBox = '';
    if (burnIn.background) {
      const bgColor = burnIn.background.color?.replace('#', '') ?? '000000';
      const opacity = Math.round((1 - (burnIn.background.opacity ?? 0.5)) * 255);
      bgBox = `\\3c&H${bgColor}&\\3a&H${opacity.toString(16).padStart(2, '0')}&`;
    }

    const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${fontName},${fontSize},&H00${primaryColour},&H00${primaryColour},${outlineColour},&H00000000,0,0,0,0,100,100,0,0,1,${outlineW},0,${alignment},10,10,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const events = segments
      .map((seg) => {
        return `Dialogue: 0,${this.formatAssTime(seg.startMs)},${this.formatAssTime(seg.endMs)},Default,,0,0,0,,${bgBox}${seg.text.replace(/\n/g, '\\N')}`;
      })
      .join('\n');

    return `${header + events}\n`;
  }

  private parseFromFormat(content: string, format: SubtitleFormat): SubtitleSegment[] {
    if (format === 'srt') return this.parseSRT(content);
    if (format === 'vtt') return this.parseVTT(content);
    return [];
  }

  private parseSRT(content: string): SubtitleSegment[] {
    const segments: SubtitleSegment[] = [];
    const blocks = content.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      const index = Number.parseInt(lines[0], 10);
      const timeMatch = lines[1].match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/,
      );

      if (!timeMatch || Number.isNaN(index)) continue;

      const startMs =
        (Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])) * 1000 +
        Number(timeMatch[4]);

      const endMs =
        (Number(timeMatch[5]) * 3600 + Number(timeMatch[6]) * 60 + Number(timeMatch[7])) * 1000 +
        Number(timeMatch[8]);

      const text = lines.slice(2).join('\n').trim();

      segments.push({ index, startMs, endMs, text });
    }

    return segments;
  }

  private parseVTT(content: string): SubtitleSegment[] {
    // Remove WEBVTT header
    const body = content.replace(/^WEBVTT\n+/, '').trim();
    // VTT cues lack index numbers that SRT requires — add them
    const cues = body.split(/\n\n+/);
    const srtBlocks = cues.map((cue, i) => {
      const normalized = cue.replace(/\./g, ',');
      return `${i + 1}\n${normalized}`;
    });
    return this.parseSRT(srtBlocks.join('\n\n'));
  }

  private mimeTypeForFormat(format: SubtitleFormat): string {
    switch (format) {
      case 'srt':
        return 'text/plain';
      case 'vtt':
        return 'text/vtt';
      case 'ass':
        return 'text/plain';
    }
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}

export function createSubtitlePipeline(
  providers: Map<string, MediaProvider>,
  storage: ArtifactStore,
): SubtitlePipeline {
  return new SubtitlePipeline(providers, storage);
}
