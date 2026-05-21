import { EventEmitter } from 'node:events';

/**
 * Real-time STT streaming (F20).
 *
 * Supports Deepgram (WebSocket) and Google Cloud Speech (gRPC StreamingRecognize).
 * OpenAI Whisper is batch-only and not supported as a stream — calling with
 * provider='openai' throws ProviderUnsupportedError per the spec.
 *
 * Both `ws` (Deepgram) and `@google-cloud/speech` (Google) are optional peer deps.
 * Production deployments install whichever they need; CI/test environments without
 * them can still construct TranscribeStream but `start()` will throw if the
 * relevant peer is missing for the chosen provider.
 */

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export type TranscribeStreamEvent =
  | { kind: 'interim'; transcript: string; confidence?: number; words?: WordTiming[] }
  | {
      kind: 'final';
      transcript: string;
      confidence?: number;
      words?: WordTiming[];
      startMs: number;
      endMs: number;
      speaker?: string;
    }
  | { kind: 'metadata'; languageDetected?: string; sampleRateHz?: number }
  | { kind: 'error'; code: string; message: string };

export interface TranscribeStreamRequest {
  source:
    | { kind: 'inline'; encoding: 'linear16' | 'opus' | 'mulaw'; sampleRateHz: number }
    | { kind: 'url'; url: string }
    | { kind: 'mic' };
  language?: string;
  model?: string;
  provider?: 'deepgram' | 'openai' | 'google';
  interim?: boolean;
  diarize?: boolean;
  endpointingMs?: number;
}

export class ProviderUnsupportedError extends Error {
  readonly code = 'PROVIDER_UNSUPPORTED' as const;
  constructor(provider: string, operation: string) {
    super(`${provider} does not support ${operation}`);
  }
}

export class MicNotAvailableError extends Error {
  readonly code = 'MIC_NOT_AVAILABLE' as const;
  constructor() {
    super(
      'Microphone capture (kind: "mic") is only available in local-only deployments with node-record-lpcm16 installed',
    );
  }
}

export interface TranscribeStreamOptions {
  /** Deepgram API key (only required when provider='deepgram'). Google uses ADC. */
  apiKey: string;
  /** Override the Deepgram base URL (e.g. for self-hosted Deepgram). */
  baseUrl?: string;
  /** Total audio seconds streamed; used to compute cost when the stream ends. */
  trackBytes?: boolean;
  /**
   * Options forwarded to `new SpeechClient(...)` when provider='google'. Lets
   * callers point at a non-default service-account key file, project ID, or
   * inline credentials object. If omitted, the client falls back to
   * Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS env var).
   */
  googleClientOptions?: Record<string, unknown>;
}

function gcpEncodingFor(deepgramEncoding: 'linear16' | 'opus' | 'mulaw'): string {
  // Map shared inline-encoding names to Google's RecognitionConfig.AudioEncoding enum.
  switch (deepgramEncoding) {
    case 'linear16':
      return 'LINEAR16';
    case 'opus':
      return 'OGG_OPUS';
    case 'mulaw':
      return 'MULAW';
  }
}

function gcpTimeToMs(t: { seconds?: string | number; nanos?: number } | undefined): number {
  if (!t) return 0;
  const sec = typeof t.seconds === 'string' ? Number.parseInt(t.seconds, 10) : (t.seconds ?? 0);
  const nanos = t.nanos ?? 0;
  return sec * 1000 + Math.round(nanos / 1_000_000);
}

interface GoogleWord {
  word?: string;
  startTime?: { seconds?: string | number; nanos?: number };
  endTime?: { seconds?: string | number; nanos?: number };
  speakerTag?: number;
}

interface GoogleStreamingResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: GoogleWord[];
    }>;
    isFinal?: boolean;
  }>;
}

/**
 * Live transcription stream. Usage:
 *   const ts = new TranscribeStream({ apiKey });
 *   ts.on('event', e => ...);
 *   await ts.start({ source: {kind:'inline', encoding:'linear16', sampleRateHz: 16000}, ... });
 *   ts.sendAudio(buf);
 *   await ts.close();
 */
export class TranscribeStream extends EventEmitter {
  private ws?: { send(data: Buffer): void; close(): void; readyState: number };
  private googleStream?: NodeJS.WritableStream & { end(): void };
  private googleProvider = false;
  private opts: TranscribeStreamOptions;
  private byteCount = 0;
  private finalTranscriptBuf: string[] = [];
  private startedAt = 0;
  private endedResolver?: () => void;

  constructor(opts: TranscribeStreamOptions) {
    super();
    this.opts = opts;
  }

  /**
   * Open the provider stream and start forwarding audio chunks.
   * For source.kind='url', this fetches the URL and pumps it in 8KB chunks before
   * waiting for the provider's final endpointing event.
   */
  async start(req: TranscribeStreamRequest): Promise<void> {
    const provider = req.provider ?? 'deepgram';

    if (provider === 'openai') {
      throw new ProviderUnsupportedError(
        'openai',
        'audio.transcribeStream (whisper is batch-only)',
      );
    }

    if (req.source.kind === 'mic') {
      throw new MicNotAvailableError();
    }

    if (provider === 'google') {
      await this.startGoogle(req);
      return;
    }

    await this.startDeepgram(req);
  }

  private async startDeepgram(req: TranscribeStreamRequest): Promise<void> {
    // Dynamic import so `ws` stays an optional peer dep.
    let WebSocket: typeof import('ws').WebSocket;
    try {
      ({ WebSocket } = await import('ws'));
    } catch {
      throw new Error(
        "TranscribeStream requires the 'ws' peer dependency. Install with: pnpm add ws",
      );
    }

    const language = req.language ?? 'en';
    const model = req.model ?? 'nova-2';
    const baseUrl = this.opts.baseUrl ?? 'wss://api.deepgram.com';

    // Deepgram URL params per https://developers.deepgram.com/docs/live-streaming-audio
    const params = new URLSearchParams({
      model,
      language,
      interim_results: String(req.interim ?? true),
      diarize: String(req.diarize ?? false),
      smart_format: 'true',
      punctuate: 'true',
      endpointing: String(req.endpointingMs ?? 800),
    });

    if (req.source.kind === 'inline') {
      params.set('encoding', req.source.encoding);
      params.set('sample_rate', String(req.source.sampleRateHz));
    }

    const url = `${baseUrl}/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.opts.apiKey}` } });
    this.ws = ws as unknown as { send(data: Buffer): void; close(): void; readyState: number };
    this.startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      try {
        const msg = JSON.parse(text) as DeepgramMessage;
        this.handleDeepgramMessage(msg);
      } catch {
        // Non-JSON frame (e.g. metadata pong) — ignore.
      }
    });

    ws.on('close', () => {
      this.emit('close');
      this.endedResolver?.();
    });

    ws.on('error', (err) => {
      this.emit('event', {
        kind: 'error',
        code: 'WS_ERROR',
        message: (err as Error).message,
      } satisfies TranscribeStreamEvent);
    });

    // For URL source, fetch the audio and stream it in chunks.
    if (req.source.kind === 'url') {
      const response = await fetch(req.source.url);
      if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }
      // Stream in 8KB chunks per spec §F20.
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sendAudio(Buffer.from(value));
      }
      // Deepgram CloseStream: zero-byte message signals end-of-input.
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
  }

  private async startGoogle(req: TranscribeStreamRequest): Promise<void> {
    // Dynamic import so `@google-cloud/speech` stays an optional peer dep.
    // The package is gRPC-heavy (~100MB); only deployments that actually need
    // Google STT pay the install cost. The string-variable indirection prevents
    // TypeScript from resolving the module at compile time, so the audio-gen
    // package builds without `@google-cloud/speech` installed.
    const moduleName: string = '@google-cloud/speech';
    let speech: { SpeechClient: new (opts?: unknown) => unknown };
    try {
      speech = (await import(moduleName)) as { SpeechClient: new (opts?: unknown) => unknown };
    } catch {
      throw new Error(
        "TranscribeStream with provider='google' requires the '@google-cloud/speech' peer dependency. " +
          'Install with: pnpm add @google-cloud/speech',
      );
    }

    // ADC (Application Default Credentials) via GOOGLE_APPLICATION_CREDENTIALS or
    // an inline keyFilename / credentials object passed via opts.googleClientOptions.
    const ClientCtor = speech.SpeechClient;
    const client = new ClientCtor(this.opts.googleClientOptions ?? {}) as {
      streamingRecognize: (cfg: unknown) => NodeJS.WritableStream & {
        on(event: string, cb: (data: unknown) => void): unknown;
        end(): void;
      };
    };

    const language = req.language ?? 'en-US';
    const model = req.model; // optional: e.g. 'latest_long', 'phone_call', 'video'
    const encoding =
      req.source.kind === 'inline' ? gcpEncodingFor(req.source.encoding) : 'LINEAR16';
    const sampleRateHertz = req.source.kind === 'inline' ? req.source.sampleRateHz : 16000;

    const config: Record<string, unknown> = {
      encoding,
      sampleRateHertz,
      languageCode: language,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
    };
    if (model) config.model = model;
    if (req.diarize) {
      config.diarizationConfig = {
        enableSpeakerDiarization: true,
        minSpeakerCount: 2,
        maxSpeakerCount: 6,
      };
    }

    const recognizeStream = client.streamingRecognize({
      config,
      interimResults: req.interim ?? true,
      singleUtterance: false,
    });

    this.googleProvider = true;
    this.googleStream = recognizeStream;
    this.startedAt = Date.now();

    recognizeStream.on('data', (raw: unknown) => {
      this.handleGoogleResponse(raw as GoogleStreamingResponse);
    });
    recognizeStream.on('error', (err: unknown) => {
      this.emit('event', {
        kind: 'error',
        code: 'GRPC_ERROR',
        message: (err as Error).message,
      } satisfies TranscribeStreamEvent);
    });
    recognizeStream.on('end', () => {
      this.emit('close');
      this.endedResolver?.();
    });

    if (req.source.kind === 'url') {
      const response = await fetch(req.source.url);
      if (!response.ok || !response.body) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.sendAudio(Buffer.from(value));
      }
      recognizeStream.end();
    }
  }

  /** Send an audio chunk. No-op when underlying stream isn't open. */
  sendAudio(chunk: Buffer): void {
    if (this.googleProvider && this.googleStream) {
      this.byteCount += chunk.length;
      // Google streamingRecognize accepts { audioContent: Buffer } messages.
      (this.googleStream as unknown as { write(data: unknown): boolean }).write({
        audioContent: chunk,
      });
      return;
    }
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;
    this.byteCount += chunk.length;
    this.ws.send(chunk);
  }

  /** Wait for the provider to send all finals, then close. */
  async close(): Promise<{ transcript: string; durationMs: number; bytes: number }> {
    if (this.googleProvider && this.googleStream) {
      try {
        this.googleStream.end();
      } catch {
        /* already closed */
      }
      await new Promise<void>((resolve) => {
        this.endedResolver = resolve;
      });
      return {
        transcript: this.finalTranscriptBuf.join(' ').trim(),
        durationMs: Date.now() - this.startedAt,
        bytes: this.byteCount,
      };
    }

    if (!this.ws) {
      return { transcript: '', durationMs: 0, bytes: 0 };
    }
    // Tell Deepgram we're done.
    try {
      this.ws.send(Buffer.from(JSON.stringify({ type: 'CloseStream' })));
    } catch {
      /* socket already closed */
    }

    await new Promise<void>((resolve) => {
      this.endedResolver = resolve;
      // Guard: WS close may have already fired.
      if (this.ws && this.ws.readyState >= 2 /* CLOSING/CLOSED */) resolve();
    });

    return {
      transcript: this.finalTranscriptBuf.join(' ').trim(),
      durationMs: Date.now() - this.startedAt,
      bytes: this.byteCount,
    };
  }

  private handleGoogleResponse(msg: GoogleStreamingResponse): void {
    const result = msg.results?.[0];
    if (!result) return;
    const alt = result.alternatives?.[0];
    if (!alt) return;

    const transcript = alt.transcript ?? '';
    const isFinal = result.isFinal ?? false;
    const words: WordTiming[] | undefined = alt.words?.map((w) => ({
      word: w.word ?? '',
      startMs: gcpTimeToMs(w.startTime),
      endMs: gcpTimeToMs(w.endTime),
    }));

    if (isFinal) {
      if (transcript.length > 0) this.finalTranscriptBuf.push(transcript);
      this.emit('event', {
        kind: 'final',
        transcript,
        confidence: alt.confidence,
        words,
        // Google returns relative offsets per result; absolute timing comes from words.
        startMs: words?.[0]?.startMs ?? 0,
        endMs: words?.[words.length - 1]?.endMs ?? 0,
        speaker:
          alt.words?.[0]?.speakerTag !== undefined ? `${alt.words[0].speakerTag}` : undefined,
      } satisfies TranscribeStreamEvent);
    } else if (transcript.length > 0) {
      this.emit('event', {
        kind: 'interim',
        transcript,
        confidence: alt.confidence,
        words,
      } satisfies TranscribeStreamEvent);
    }
  }

  private handleDeepgramMessage(msg: DeepgramMessage): void {
    if (msg.type === 'Metadata') {
      this.emit('event', {
        kind: 'metadata',
        languageDetected: msg.detected_language,
        sampleRateHz: msg.sample_rate,
      } satisfies TranscribeStreamEvent);
      return;
    }
    if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
      const alt = msg.channel.alternatives[0];
      const transcript = alt.transcript ?? '';
      const isFinal = msg.is_final ?? false;
      const words: WordTiming[] | undefined = alt.words?.map((w) => ({
        word: w.word,
        startMs: Math.round((w.start ?? 0) * 1000),
        endMs: Math.round((w.end ?? 0) * 1000),
        confidence: w.confidence,
      }));
      if (isFinal) {
        if (transcript.length > 0) this.finalTranscriptBuf.push(transcript);
        this.emit('event', {
          kind: 'final',
          transcript,
          confidence: alt.confidence,
          words,
          startMs: Math.round((msg.start ?? 0) * 1000),
          endMs: Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000),
          speaker: alt.words?.[0]?.speaker !== undefined ? `${alt.words[0].speaker}` : undefined,
        } satisfies TranscribeStreamEvent);
      } else if (transcript.length > 0) {
        this.emit('event', {
          kind: 'interim',
          transcript,
          confidence: alt.confidence,
          words,
        } satisfies TranscribeStreamEvent);
      }
    }
  }
}

interface DeepgramWord {
  word: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
}

interface DeepgramMessage {
  type: 'Metadata' | 'Results' | 'UtteranceEnd' | 'SpeechStarted';
  is_final?: boolean;
  start?: number;
  duration?: number;
  detected_language?: string;
  sample_rate?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: DeepgramWord[];
    }>;
  };
}
