import { Readable } from 'node:stream';
import type { MediaProvider } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurnInOptions, SubtitleFormat, SubtitleSegment } from '../subtitle.js';
import { createSubtitlePipeline, SubtitlePipeline } from '../subtitle.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockMkdtempSync = vi.hoisted(() => vi.fn().mockReturnValue('/tmp/test-subtitles'));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn(() => Buffer.from('mock-data')));
const mockRmSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: mockMkdtempSync,
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    rmSync: mockRmSync,
  };
});

type PipelineProxy = {
  encodeSRT: (segments: SubtitleSegment[]) => string;
  encodeVTT: (segments: SubtitleSegment[]) => string;
  encodeASS: (segments: SubtitleSegment[]) => string;
  encode: (format: 'srt' | 'vtt' | 'ass', segments: SubtitleSegment[]) => string;
  formatSrtTime: (ms: number) => string;
  formatVttTime: (ms: number) => string;
  formatAssTime: (ms: number) => string;
  wrapText: (text: string, maxLen: number) => string;
  postProcessSegments: (segments: SubtitleSegment[]) => SubtitleSegment[];
  parseSttSegments: (data: Buffer, metadata: Record<string, unknown>) => SubtitleSegment[];
  parseSRT: (content: string) => SubtitleSegment[];
  parseVTT: (content: string) => SubtitleSegment[];
  convertToAss: (
    content: string,
    fromFormat: 'srt' | 'vtt' | 'ass',
    burnIn: BurnInOptions,
  ) => string;
  translateSegments: (
    segments: SubtitleSegment[],
    targetLanguage: string,
  ) => Promise<SubtitleSegment[]>;
  getProvider: (operation: string, preferred?: string) => unknown;
  mimeTypeForFormat: (format: SubtitleFormat) => string;
  streamToBuffer: (stream: NodeJS.ReadableStream) => Promise<Buffer>;
  parseFromFormat: (content: string, format: SubtitleFormat) => SubtitleSegment[];
  ensureFfmpeg: () => Promise<void>;
  extractAudio: (inputId: string, outputPath: string) => Promise<void>;
  burnSubtitles: (inputPath: string, assPath: string, outputPath: string) => Promise<void>;
};

function createPipeline(providers?: ReadonlyMap<string, unknown>): SubtitlePipeline {
  const p = new SubtitlePipeline(
    (providers ?? new Map()) as unknown as Map<string, MediaProvider>,
    {} as unknown as ArtifactStore,
  );
  return p;
}

function proxy(pipeline: SubtitlePipeline): PipelineProxy {
  return pipeline as unknown as PipelineProxy;
}

const sampleSegments: SubtitleSegment[] = [
  { index: 1, startMs: 0, endMs: 5000, text: 'Hello world' },
  { index: 2, startMs: 5000, endMs: 10000, text: 'This is a subtitle test' },
];

const diarizedSegments: SubtitleSegment[] = [
  { index: 1, startMs: 0, endMs: 3000, text: 'Hello everyone', speaker: 'Speaker1' },
  { index: 2, startMs: 3000, endMs: 6000, text: 'How are you today', speaker: 'Speaker2' },
];

describe('SubtitlePipeline', () => {
  describe('factory', () => {
    it('should create pipeline via factory function', () => {
      const pipeline = createSubtitlePipeline(new Map(), {} as unknown as ArtifactStore);
      expect(pipeline).toBeDefined();
      expect(typeof pipeline.generate).toBe('function');
    });
  });

  describe('getProvider', () => {
    it('should return preferred provider if it supports the operation', () => {
      const providerA = { name: 'a', supportedOperations: ['audio.stt'] };
      const providerB = { name: 'b', supportedOperations: ['audio.stt'] };
      const providers = new Map([
        ['a', providerA],
        ['b', providerB],
      ]);
      const p = proxy(createPipeline(providers));
      const result = p.getProvider('audio.stt', 'a');
      expect(result).toBe(providerA);
    });

    it('should fall back to any provider if preferred does not support operation', () => {
      const providerA = { name: 'a', supportedOperations: ['other.op'] };
      const providerB = { name: 'b', supportedOperations: ['audio.stt'] };
      const providers = new Map([
        ['a', providerA],
        ['b', providerB],
      ]);
      const p = proxy(createPipeline(providers));
      const result = p.getProvider('audio.stt');
      expect(result).toBe(providerB);
    });

    it('should throw if no provider supports the operation', () => {
      const providerA = { name: 'a', supportedOperations: ['other.op'] };
      const providers = new Map([['a', providerA]]);
      const pipeline = createPipeline(providers);
      expect(() => proxy(pipeline).getProvider('audio.stt')).toThrow(
        'No provider available for audio.stt',
      );
    });
  });

  describe('time formatting', () => {
    it('should format SRT time correctly', () => {
      const p = proxy(createPipeline());
      expect(p.formatSrtTime(0)).toBe('00:00:00,000');
      expect(p.formatSrtTime(3661000)).toBe('01:01:01,000');
      expect(p.formatSrtTime(1234567)).toBe('00:20:34,567');
    });

    it('should format VTT time correctly', () => {
      const p = proxy(createPipeline());
      expect(p.formatVttTime(0)).toBe('00:00:00.000');
      expect(p.formatVttTime(3661000)).toBe('01:01:01.000');
      expect(p.formatVttTime(1234567)).toBe('00:20:34.567');
    });

    it('should format ASS time correctly', () => {
      const p = proxy(createPipeline());
      expect(p.formatAssTime(0)).toBe('0:00:00.00');
      expect(p.formatAssTime(3661000)).toBe('1:01:01.00');
      expect(p.formatAssTime(1234567)).toBe('0:20:34.56');
    });
  });

  describe('encoding', () => {
    it('should encode SRT correctly', () => {
      const p = proxy(createPipeline());
      const result = p.encodeSRT(sampleSegments);
      expect(result).toContain('1');
      expect(result).toContain('00:00:00,000 --> 00:00:05,000');
      expect(result).toContain('Hello world');
      expect(result).toContain('2');
      expect(result).toContain('00:00:05,000 --> 00:00:10,000');
      expect(result).toContain('This is a subtitle test');
    });

    it('should encode SRT with speaker prefix', () => {
      const p = proxy(createPipeline());
      const result = p.encodeSRT(diarizedSegments);
      expect(result).toContain('Speaker1: Hello everyone');
      expect(result).toContain('Speaker2: How are you today');
    });

    it('should encode VTT correctly', () => {
      const p = proxy(createPipeline());
      const result = p.encodeVTT(sampleSegments);
      expect(result).toContain('WEBVTT');
      expect(result).toContain('00:00:00.000 --> 00:00:05.000');
      expect(result).toContain('Hello world');
      expect(result).toContain('00:00:05.000 --> 00:00:10.000');
      expect(result).toContain('This is a subtitle test');
    });

    it('should encode VTT with speaker tags', () => {
      const p = proxy(createPipeline());
      const result = p.encodeVTT(diarizedSegments);
      expect(result).toContain('<v Speaker1>');
      expect(result).toContain('</v>');
      expect(result).toContain('<v Speaker2>');
    });

    it('should encode ASS correctly', () => {
      const p = proxy(createPipeline());
      const result = p.encodeASS(sampleSegments);
      expect(result).toContain('[Script Info]');
      expect(result).toContain('[V4+ Styles]');
      expect(result).toContain('[Events]');
      expect(result).toContain(
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      );
      expect(result).toContain('Dialogue: 0,');
      expect(result).toContain('Hello world');
    });

    it('should encode ASS with speaker prefix', () => {
      const p = proxy(createPipeline());
      const result = p.encodeASS(diarizedSegments);
      expect(result).toContain('\\h(Speaker1)');
      expect(result).toContain('\\h(Speaker2)');
    });

    it('should delegate encode to correct format method', () => {
      const p = proxy(createPipeline());
      const srt = p.encode('srt', sampleSegments);
      expect(srt).toContain('00:00:00,000 -->');
      const vtt = p.encode('vtt', sampleSegments);
      expect(vtt).toContain('WEBVTT');
      const ass = p.encode('ass', sampleSegments);
      expect(ass).toContain('[Script Info]');
    });

    it('should handle empty segments', () => {
      const p = proxy(createPipeline());
      expect(p.encodeSRT([])).toBe('');
      expect(p.encodeVTT([])).toContain('WEBVTT');
      expect(p.encodeASS([])).toContain('[Script Info]');
    });
  });

  describe('text wrapping', () => {
    it('should not wrap text within max length', () => {
      const p = proxy(createPipeline());
      expect(p.wrapText('Hello world', 42)).toBe('Hello world');
    });

    it('should wrap text exceeding max length', () => {
      const p = proxy(createPipeline());
      const longText =
        'This is a very long sentence that should definitely be broken into multiple lines for subtitle display';
      const result = p.wrapText(longText, 42);
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(42);
      }
    });

    it('should break at word boundaries', () => {
      const p = proxy(createPipeline());
      const result = p.wrapText('aaaa bbbb cccc dddd eeee ffff gggg hhhh', 10);
      const lines = result.split('\n');
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(10);
      }
      expect(lines.every((l) => !l.startsWith(' ') && !l.endsWith(' '))).toBe(true);
    });

    it('should return empty string for empty input', () => {
      const p = proxy(createPipeline());
      expect(p.wrapText('', 42)).toBe('');
    });
  });

  describe('CPS limiting', () => {
    it('should not truncate text within CPS limit', () => {
      const p = proxy(createPipeline());
      const segments: SubtitleSegment[] = [
        { index: 1, startMs: 0, endMs: 10000, text: 'Short text' },
      ];
      const result = p.postProcessSegments(segments);
      expect(result[0].text).toBe('Short text');
    });

    it('should truncate text exceeding CPS limit', () => {
      const p = proxy(createPipeline());
      const longText = 'A'.repeat(200);
      const segments: SubtitleSegment[] = [{ index: 1, startMs: 0, endMs: 2000, text: longText }];
      const result = p.postProcessSegments(segments);
      const maxChars = Math.floor(17 * 2);
      expect(result[0].text.length).toBeLessThanOrEqual(maxChars);
    });

    it('should break truncated text at word boundary', () => {
      const p = proxy(createPipeline());
      const text = `hello world ${'A'.repeat(100)}`;
      const segments: SubtitleSegment[] = [{ index: 1, startMs: 0, endMs: 1000, text }];
      const result = p.postProcessSegments(segments);
      expect(result[0].text).not.toContain('A');
    });

    it('should apply line wrapping before CPS check', () => {
      const p = proxy(createPipeline());
      const text = 'word '.repeat(20).trim();
      const segments: SubtitleSegment[] = [{ index: 1, startMs: 0, endMs: 10000, text }];
      const result = p.postProcessSegments(segments);
      const lines = result[0].text.split('\n');
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(42);
      }
    });

    it('should handle zero duration segments gracefully', () => {
      const p = proxy(createPipeline());
      const segments: SubtitleSegment[] = [{ index: 1, startMs: 0, endMs: 0, text: 'Test' }];
      const result = p.postProcessSegments(segments);
      expect(result[0].text).toBe('Test');
    });

    it('should re-index segments', () => {
      const p = proxy(createPipeline());
      const segments: SubtitleSegment[] = [
        { index: 99, startMs: 0, endMs: 5000, text: 'First' },
        { index: 999, startMs: 5000, endMs: 10000, text: 'Second' },
      ];
      const result = p.postProcessSegments(segments);
      expect(result[0].index).toBe(1);
      expect(result[1].index).toBe(2);
    });
  });

  describe('STT parsing', () => {
    it('should parse JSON with segments array', () => {
      const p = proxy(createPipeline());
      const json = JSON.stringify({
        segments: [
          { start: 0, end: 2.5, text: 'Hello world' },
          { start: 2.5, end: 5.0, text: 'Second line' },
        ],
      });
      const result = p.parseSttSegments(Buffer.from(json), {});
      expect(result).toHaveLength(2);
      expect(result[0].startMs).toBe(0);
      expect(result[0].endMs).toBe(2500);
      expect(result[0].text).toBe('Hello world');
      expect(result[1].index).toBe(2);
    });

    it('should parse JSON with speaker diarization', () => {
      const p = proxy(createPipeline());
      const json = JSON.stringify({
        segments: [
          { start: 0, end: 2.0, text: 'Hello', speaker: 'A' },
          { start: 2.0, end: 4.0, text: 'Hi there', speaker: 'B' },
        ],
      });
      const result = p.parseSttSegments(Buffer.from(json), {});
      expect(result[0].speaker).toBe('A');
      expect(result[1].speaker).toBe('B');
    });

    it('should handle single transcription JSON', () => {
      const p = proxy(createPipeline());
      const json = JSON.stringify({ text: 'Full transcription text' });
      const result = p.parseSttSegments(Buffer.from(json), {});
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Full transcription text');
    });

    it('should fall back to plain text', () => {
      const p = proxy(createPipeline());
      const result = p.parseSttSegments(Buffer.from('Plain text fallback'), {});
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Plain text fallback');
    });
  });

  describe('SRT parsing', () => {
    it('should parse valid SRT content', () => {
      const p = proxy(createPipeline());
      const srt =
        '1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n00:00:03,000 --> 00:00:04,500\nLine two\n';
      const result = p.parseSRT(srt);
      expect(result).toHaveLength(2);
      expect(result[0].startMs).toBe(1000);
      expect(result[0].endMs).toBe(2500);
      expect(result[0].text).toBe('Hello world');
      expect(result[1].startMs).toBe(3000);
      expect(result[1].endMs).toBe(4500);
      expect(result[1].text).toBe('Line two');
    });

    it('should skip malformed blocks', () => {
      const p = proxy(createPipeline());
      const srt = 'garbage\n\n1\n00:00:01,000 --> 00:00:02,500\nValid text\n';
      const result = p.parseSRT(srt);
      expect(result).toHaveLength(1);
    });
  });

  describe('VTT parsing', () => {
    it('should parse valid VTT content', () => {
      const p = proxy(createPipeline());
      const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n';
      const result = p.parseVTT(vtt);
      expect(result).toHaveLength(1);
      expect(result[0].startMs).toBe(1000);
      expect(result[0].endMs).toBe(2500);
    });
  });

  describe('ASS conversion', () => {
    it('should convert SRT to ASS with default burn-in', () => {
      const p = proxy(createPipeline());
      const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello world\n';
      const result = p.convertToAss(srt, 'srt', {});
      expect(result).toContain('[Script Info]');
      expect(result).toContain('[V4+ Styles]');
      expect(result).toContain('[Events]');
      expect(result).toContain('Dialogue:');
      expect(result).toContain('Hello world');
    });

    it('should convert VTT to ASS with default burn-in', () => {
      const p = proxy(createPipeline());
      const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n';
      const result = p.convertToAss(vtt, 'vtt', {});
      expect(result).toContain('[Script Info]');
      expect(result).toContain('Hello world');
    });

    it('should pass through ASS format directly', () => {
      const p = proxy(createPipeline());
      const ass =
        '[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello\n';
      const result = p.convertToAss(ass, 'ass', {});
      expect(result).toBe(ass);
    });

    it('should apply full burn-in options', () => {
      const p = proxy(createPipeline());
      const srt = '1\n00:00:01,000 --> 00:00:02,500\nStyled text\n';
      const burnIn: BurnInOptions = {
        font: 'Comic Sans',
        fontSize: 36,
        fontColor: '#FF0000',
        outline: { color: '#00FF00', widthPx: 4 },
        position: 'top',
        marginPx: 50,
        background: { color: '#000000', opacity: 0.7 },
      };
      const result = p.convertToAss(srt, 'srt', burnIn);
      expect(result).toContain('Comic Sans');
      expect(result).toContain('36');
      expect(result).toContain('&H00FF0000');
      expect(result).toContain('4');
      expect(result).toContain('8');
      expect(result).toContain('50');
      expect(result).toContain('\\3c');
    });

    it('should map position to correct ASS alignment', () => {
      const p = proxy(createPipeline());
      const srt = '1\n00:00:01,000 --> 00:00:02,500\nTest\n';

      const top = p.convertToAss(srt, 'srt', { position: 'top' });
      expect(top).toContain('8');

      const middle = p.convertToAss(srt, 'srt', { position: 'middle' });
      expect(middle).toContain('4');

      const bottom = p.convertToAss(srt, 'srt', { position: 'bottom' });
      expect(bottom).toContain('2');
    });

    it('should handle background opacity', () => {
      const p = proxy(createPipeline());
      const srt = '1\n00:00:01,000 --> 00:00:02,500\nTest\n';
      const result = p.convertToAss(srt, 'srt', {
        background: { color: '#FFFFFF', opacity: 0 },
      });
      const opaqueHex = Math.round(255).toString(16).padStart(2, '0');
      expect(result).toContain(`\\3a&H${opaqueHex}&`);

      const result2 = p.convertToAss(srt, 'srt', {
        background: { color: '#000000', opacity: 1 },
      });
      expect(result2).toContain('\\3a&H00&');
    });
  });

  describe('translation', () => {
    it('should translate segments via provider', async () => {
      const mockProvider = {
        name: 'mock-llm',
        supportedOperations: ['text.complete'],
        execute: vi.fn().mockResolvedValue({
          data: Buffer.from('Hola mundo\n---\nEsto es una prueba'),
          mimeType: 'text/plain',
          costUsd: 0.001,
        }),
      };
      const providers = new Map([['mock-llm', mockProvider]]);
      const p = proxy(createPipeline(providers));
      const segments: SubtitleSegment[] = [
        { index: 1, startMs: 0, endMs: 3000, text: 'Hello world' },
        { index: 2, startMs: 3000, endMs: 6000, text: 'This is a test' },
      ];

      const result = await p.translateSegments(segments, 'es');

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('Hola mundo');
      expect(result[1].text).toBe('Esto es una prueba');
      expect(mockProvider.execute).toHaveBeenCalledTimes(1);
      const callArg = mockProvider.execute.mock.calls[0][0] as { params: { prompt: string } };
      expect(callArg.params.prompt).toContain('Translate');
      expect(callArg.params.prompt).toContain('es');
      expect(callArg.params.prompt).toContain('Hello world');
    });

    it('should fall back to original text on translation mismatch', async () => {
      const mockProvider = {
        name: 'mock-llm',
        supportedOperations: ['text.complete'],
        execute: vi.fn().mockResolvedValue({
          data: Buffer.from('Only one line'),
          mimeType: 'text/plain',
          costUsd: 0.001,
        }),
      };
      const providers = new Map([['mock-llm', mockProvider]]);
      const p = proxy(createPipeline(providers));
      const segments: SubtitleSegment[] = [
        { index: 1, startMs: 0, endMs: 3000, text: 'First' },
        { index: 2, startMs: 3000, endMs: 6000, text: 'Second' },
      ];
      const result = await p.translateSegments(segments, 'fr');
      expect(result[0].text).toBe('Only one line');
      expect(result[1].text).toBe('Second');
    });
  });

  describe('mimeTypeForFormat', () => {
    it('should return text/plain for srt', () => {
      const p = proxy(createPipeline());
      expect((p as unknown as PipelineProxy).mimeTypeForFormat('srt')).toBe('text/plain');
    });

    it('should return text/vtt for vtt', () => {
      const p = proxy(createPipeline());
      expect((p as unknown as PipelineProxy).mimeTypeForFormat('vtt')).toBe('text/vtt');
    });

    it('should return text/plain for ass', () => {
      const p = proxy(createPipeline());
      expect((p as unknown as PipelineProxy).mimeTypeForFormat('ass')).toBe('text/plain');
    });
  });

  describe('streamToBuffer', () => {
    it('should convert readable stream to buffer', async () => {
      const p = proxy(createPipeline());
      const stream = Readable.from(Buffer.from('test data'));
      const result = await (p as unknown as PipelineProxy).streamToBuffer(stream);
      expect(result.toString()).toBe('test data');
    });

    it('should reject on stream error', async () => {
      const p = proxy(createPipeline());
      const stream = new Readable({
        read() {
          this.destroy(new Error('stream error'));
        },
      });
      await expect((p as unknown as PipelineProxy).streamToBuffer(stream)).rejects.toThrow(
        'stream error',
      );
    });
  });

  describe('parseFromFormat', () => {
    it('should return empty array for unknown format', () => {
      const p = proxy(createPipeline());
      const result = (p as unknown as PipelineProxy).parseFromFormat('content', 'ass');
      expect(result).toEqual([]);
    });
  });
});

function makeMockFfmpegProcess() {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => (handler as (code: number) => void)(0), 0);
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

function makeFailingFfmpegProcess(code: number) {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => (handler as (code: number) => void)(code), 0);
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

function makeErrorFfmpegProcess(errMsg: string) {
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'error') setTimeout(() => handler(new Error(errMsg)), 0);
      return undefined;
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  };
}

describe('ensureFfmpeg', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('should resolve when ffmpeg is found', async () => {
    mockSpawn.mockReturnValue(makeMockFfmpegProcess());
    const p = proxy(createPipeline());
    await expect((p as unknown as PipelineProxy).ensureFfmpeg()).resolves.toBeUndefined();
  });

  it('should reject when ffmpeg not found', async () => {
    mockSpawn.mockReturnValue(makeFailingFfmpegProcess(1));
    const p = proxy(createPipeline());
    await expect((p as unknown as PipelineProxy).ensureFfmpeg()).rejects.toThrow();
  });

  it('should reject on spawn error', async () => {
    mockSpawn.mockReturnValue(makeErrorFfmpegProcess('spawn failed'));
    const p = proxy(createPipeline());
    await expect((p as unknown as PipelineProxy).ensureFfmpeg()).rejects.toThrow();
  });
});

describe('extractAudio', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('should extract audio successfully', async () => {
    mockSpawn.mockReturnValue(makeMockFfmpegProcess());
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).extractAudio('input.mp4', 'output.aac'),
    ).resolves.toBeUndefined();
  });

  it('should reject on ffmpeg failure', async () => {
    mockSpawn
      .mockReturnValueOnce(makeMockFfmpegProcess())
      .mockReturnValueOnce(makeFailingFfmpegProcess(1));
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).extractAudio('input.mp4', 'output.aac'),
    ).rejects.toThrow('ffmpeg audio extraction failed with code 1');
  });

  it('should reject on spawn error', async () => {
    mockSpawn
      .mockReturnValueOnce(makeMockFfmpegProcess())
      .mockReturnValueOnce(makeErrorFfmpegProcess('spawn error'));
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).extractAudio('input.mp4', 'output.aac'),
    ).rejects.toThrow('spawn error');
  });
});

describe('burnSubtitles', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('should burn subtitles successfully', async () => {
    mockSpawn.mockReturnValue(makeMockFfmpegProcess());
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).burnSubtitles('input.mp4', 'subs.ass', 'output.mp4'),
    ).resolves.toBeUndefined();
  });

  it('should reject on ffmpeg failure', async () => {
    mockSpawn
      .mockReturnValueOnce(makeMockFfmpegProcess())
      .mockReturnValueOnce(makeFailingFfmpegProcess(1));
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).burnSubtitles('input.mp4', 'subs.ass', 'output.mp4'),
    ).rejects.toThrow('ffmpeg subtitle burn failed with code 1');
  });

  it('should reject on spawn error', async () => {
    mockSpawn
      .mockReturnValueOnce(makeMockFfmpegProcess())
      .mockReturnValueOnce(makeErrorFfmpegProcess('spawn error'));
    const p = proxy(createPipeline());
    await expect(
      (p as unknown as PipelineProxy).burnSubtitles('input.mp4', 'subs.ass', 'output.mp4'),
    ).rejects.toThrow('spawn error');
  });
});

describe('generate', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(makeMockFfmpegProcess());
    mockMkdtempSync.mockReturnValue('/tmp/test-subtitles');
    mockWriteFileSync.mockImplementation(() => {});
    mockReadFileSync.mockReturnValue(Buffer.from('mock-audio-data'));
    mockRmSync.mockImplementation(() => {});
  });

  function makeMockSttProvider(opts?: {
    text?: string;
    speaker?: string;
    segments?: Array<{ start: number; end: number; text: string; speaker?: string }>;
  }) {
    let data: object;
    if (opts?.segments) {
      data = { segments: opts.segments };
    } else {
      data = {
        segments: [
          { start: 0, end: 2.5, text: opts?.text ?? 'Hello world', speaker: opts?.speaker },
        ],
      };
    }
    return {
      name: 'mock-stt',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from(JSON.stringify(data)),
        mimeType: 'application/json',
        costUsd: 0.01,
      }),
    };
  }

  function makeMockStorage() {
    return {
      get: vi.fn().mockResolvedValue({
        data: Readable.from(Buffer.from('video-data')),
        meta: { id: 'v1', type: 'video', mimeType: 'video/mp4', metadata: {} },
      }),
      put: vi.fn().mockResolvedValue('file://artifact-1'),
    };
  }

  it('should generate SRT subtitles with basic config', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Hello world' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.subtitleArtifactId).toBeDefined();
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('Hello world');
    expect(result.language).toBe('en');
    expect(result.burnedArtifactId).toBeUndefined();
    expect(storage.put).toHaveBeenCalled();
  });

  it('should generate VTT subtitles', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'VTT test' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'vtt' });

    expect(result.subtitleArtifactId).toBeDefined();
    expect(result.segments[0].text).toBe('VTT test');
    expect(result.language).toBe('en');
  });

  it('should generate ASS subtitles', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'ASS test' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'ass' });

    expect(result.subtitleArtifactId).toBeDefined();
    expect(result.segments[0].text).toBe('ASS test');
  });

  it('should use specified language', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Bonjour' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', language: 'fr', format: 'srt' });

    expect(result.language).toBe('fr');
  });

  it('should use specified STT provider', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Custom provider' });
    const fallbackProvider = {
      name: 'fallback',
      supportedOperations: ['audio.stt'],
      execute: vi.fn(),
    };
    const providers = new Map([
      ['custom-stt', sttProvider],
      ['fallback', fallbackProvider],
    ]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({
      artifactId: 'v1',
      sttProvider: 'custom-stt',
      format: 'srt',
    });

    expect(result.segments[0].text).toBe('Custom provider');
    expect(sttProvider.execute).toHaveBeenCalled();
    expect(fallbackProvider.execute).not.toHaveBeenCalled();
  });

  it('should translate segments when translateTo differs from language', async () => {
    const storage = makeMockStorage();
    const provider = {
      name: 'mock-all',
      supportedOperations: ['audio.stt', 'text.complete'],
      execute: vi.fn((input: Record<string, unknown>) => {
        if (input.operation === 'audio.stt') {
          return {
            data: Buffer.from(
              JSON.stringify({
                segments: [{ start: 0, end: 2.5, text: 'Hello world' }],
              }),
            ),
            mimeType: 'application/json',
            costUsd: 0.01,
          };
        }
        return {
          data: Buffer.from('Hola mundo'),
          mimeType: 'text/plain',
          costUsd: 0.001,
        };
      }),
    };
    const providers = new Map([['mock-all', provider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', translateTo: 'es', format: 'srt' });

    expect(result.segments[0].text).toBe('Hola mundo');
  });

  it('should skip translation when translateTo matches language', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Hello' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({
      artifactId: 'v1',
      language: 'en',
      translateTo: 'en',
      format: 'srt',
    });

    expect(result.segments[0].text).toBe('Hello');
  });

  it('should burn subtitles when burnIn is provided', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Burned text' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({
      artifactId: 'v1',
      format: 'srt',
      burnIn: { font: 'Arial', fontSize: 24, position: 'bottom' },
    });

    expect(result.burnedArtifactId).toBeDefined();
    expect(result.segments[0].text).toBe('Burned text');
  });

  it('should burn with full options including background', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Styled burn' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({
      artifactId: 'v1',
      format: 'srt',
      burnIn: {
        font: 'Comic Sans',
        fontSize: 36,
        fontColor: '#FF0000',
        outline: { color: '#00FF00', widthPx: 4 },
        position: 'top',
        marginPx: 50,
        background: { color: '#000000', opacity: 0.7 },
      },
    });

    expect(result.burnedArtifactId).toBeDefined();
    expect(result.segments[0].text).toBe('Styled burn');
  });

  it('should handle diarized segments', async () => {
    const storage = makeMockStorage();
    const sttProvider = {
      name: 'mock-stt',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from(
          JSON.stringify({
            segments: [
              { start: 0, end: 2.0, text: 'Hello', speaker: 'A' },
              { start: 2.0, end: 4.0, text: 'Hi', speaker: 'B' },
            ],
          }),
        ),
        mimeType: 'application/json',
        costUsd: 0.01,
      }),
    };
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].speaker).toBe('A');
    expect(result.segments[1].speaker).toBe('B');
  });

  it('should handle single transcription JSON (no segments array)', async () => {
    const storage = makeMockStorage();
    const sttProvider = {
      name: 'mock-stt',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from(JSON.stringify({ text: 'Full transcription' })),
        mimeType: 'application/json',
        costUsd: 0.01,
      }),
    };
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('Full transcription');
  });

  it('should handle plain text STT fallback', async () => {
    const storage = makeMockStorage();
    const sttProvider = {
      name: 'mock-stt',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from('Plain text fallback'),
        mimeType: 'text/plain',
        costUsd: 0.01,
      }),
    };
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe('Plain text fallback');
  });

  it('should handle fallback routing when no sttProvider specified', async () => {
    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Fallback routing' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.subtitleArtifactId).toBeDefined();
  });

  it('should throw when no STT provider is available', async () => {
    const storage = makeMockStorage();
    const providers = new Map();
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    await expect(pipeline.generate({ artifactId: 'v1', format: 'srt' })).rejects.toThrow(
      'No provider available for audio.stt',
    );
  });

  it('should handle empty segments from STT gracefully', async () => {
    const storage = makeMockStorage();
    const sttProvider = {
      name: 'mock-stt',
      supportedOperations: ['audio.stt'],
      execute: vi.fn().mockResolvedValue({
        data: Buffer.from(JSON.stringify({ segments: [] })),
        mimeType: 'application/json',
        costUsd: 0.01,
      }),
    };
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });

    expect(result.segments).toHaveLength(0);
  });

  it('should handle ffmpeg spawn error during generate', async () => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(makeErrorFfmpegProcess('ffmpeg not found'));

    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'test' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    await expect(pipeline.generate({ artifactId: 'v1', format: 'srt' })).rejects.toThrow();
  });

  it('should handle cleanup error in finally block gracefully', async () => {
    mockRmSync.mockImplementation(() => {
      throw new Error('cleanup failed');
    });

    const storage = makeMockStorage();
    const sttProvider = makeMockSttProvider({ text: 'Cleanup test' });
    const providers = new Map([['mock-stt', sttProvider]]);
    const pipeline = new SubtitlePipeline(
      providers as unknown as Map<string, MediaProvider>,
      storage as unknown as ArtifactStore,
    );

    const result = await pipeline.generate({ artifactId: 'v1', format: 'srt' });
    expect(result.subtitleArtifactId).toBeDefined();
  });
});
