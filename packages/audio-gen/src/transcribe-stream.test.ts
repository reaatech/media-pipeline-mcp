import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MicNotAvailableError,
  ProviderUnsupportedError,
  TranscribeStream,
} from './transcribe-stream.js';

class MockWebSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

vi.mock('ws', () => ({
  default: MockWebSocket,
  WebSocket: MockWebSocket,
}));

function attachMockWs(
  ts: TranscribeStream,
  ws: EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
  },
) {
  ws.removeAllListeners();
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.readyState = 1;
  (ts as unknown as { ws: typeof ws }).ws = ws;
  (ts as unknown as { startedAt: number }).startedAt = Date.now();
  ws.on('message', (data: Buffer | string) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const msg = JSON.parse(text);
      (ts as unknown as { handleDeepgramMessage(msg: unknown): void }).handleDeepgramMessage(msg);
    } catch {
      /* non-JSON frame */
    }
  });
  ws.on('close', () => {
    (ts as unknown as { endedResolver?: () => void }).endedResolver?.();
  });
  ws.on('error', (err: Error) => {
    ts.emit('event', { kind: 'error', code: 'WS_ERROR', message: err.message });
  });
}

describe('TranscribeStream — class construction', () => {
  it('constructs with apiKey', () => {
    const ts = new TranscribeStream({ apiKey: 'test-key' });
    expect(ts).toBeInstanceOf(TranscribeStream);
  });

  it('constructs with full options', () => {
    const ts = new TranscribeStream({
      apiKey: 'test-key',
      baseUrl: 'wss://custom.example.com',
      trackBytes: true,
      googleClientOptions: { projectId: 'my-project' },
    });
    expect(ts).toBeInstanceOf(TranscribeStream);
  });
});

describe('TranscribeStream — provider routing (F20)', () => {
  it('rejects provider="openai" — Whisper is batch-only', async () => {
    const ts = new TranscribeStream({ apiKey: 'test' });
    await expect(
      ts.start({
        source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
        provider: 'openai',
      }),
    ).rejects.toThrow(ProviderUnsupportedError);
  });

  it('rejects mic source — local capture requires node-record-lpcm16', async () => {
    const ts = new TranscribeStream({ apiKey: 'test' });
    await expect(ts.start({ source: { kind: 'mic' }, provider: 'deepgram' })).rejects.toThrow(
      MicNotAvailableError,
    );
  });

  it('defaults provider to deepgram when not specified', async () => {
    const ts = new TranscribeStream({ apiKey: 'test' });
    vi.spyOn(
      ts as unknown as { startDeepgram(): Promise<unknown> },
      'startDeepgram',
    ).mockResolvedValue(undefined);
    const promise = ts.start({
      source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
    });
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('TranscribeStream — Deepgram flow', () => {
  let ts: TranscribeStream;
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = new MockWebSocket();
    ts = new TranscribeStream({ apiKey: 'test-key', baseUrl: 'wss://custom.example.com' });
    vi.spyOn(
      ts as unknown as { startDeepgram(): Promise<unknown> },
      'startDeepgram',
    ).mockImplementation(async function (this: {
      ws: MockWebSocket | null;
      startedAt: number;
      handleDeepgramMessage(msg: unknown): void;
      endedResolver?: () => void;
      emit(event: string, ...args: unknown[]): boolean;
    }) {
      this.ws = ws;
      this.startedAt = Date.now();
      const handler = (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        try {
          const msg = JSON.parse(text);
          this.handleDeepgramMessage(msg);
        } catch {}
      };
      ws.on('message', handler);
      ws.on('close', () => {
        this.endedResolver?.();
      });
      ws.on('error', (err: Error) => {
        this.emit('event', { kind: 'error', code: 'WS_ERROR', message: err.message });
      });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends audio chunks via WebSocket after start', async () => {
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });
    ts.sendAudio(Buffer.from('audio-data'));
    expect(ws.send).toHaveBeenCalledWith(Buffer.from('audio-data'));
  });

  it('emits interim results from Deepgram Results message', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({
      source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
      interim: true,
    });

    const interimMsg = JSON.stringify({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'hello world', confidence: 0.95 }] },
    });
    ws.emit('message', Buffer.from(interimMsg));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].kind).toBe('interim');
    expect(events[0].transcript).toBe('hello world');
  });

  it('emits final results from Deepgram Results message', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({
      source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
      interim: true,
    });

    const finalMsg = JSON.stringify({
      type: 'Results',
      is_final: true,
      start: 1.0,
      duration: 2.0,
      channel: {
        alternatives: [
          {
            transcript: 'hello world',
            confidence: 0.98,
            words: [{ word: 'hello', start: 1.0, end: 1.5, confidence: 0.99 }],
          },
        ],
      },
    });
    ws.emit('message', Buffer.from(finalMsg));
    expect(events[0].kind).toBe('final');
    expect(events[0].transcript).toBe('hello world');
    expect(events[0].startMs).toBe(1000);
  });

  it('emits interim even when transcript is non-empty and not final', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });

    const msg = JSON.stringify({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'interim text', confidence: 0.9 }] },
    });
    ws.emit('message', Buffer.from(msg));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].kind).toBe('interim');
  });

  it('emits metadata events from Deepgram Metadata message', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });

    const metaMsg = JSON.stringify({
      type: 'Metadata',
      detected_language: 'en-US',
      sample_rate: 16000,
    });
    ws.emit('message', Buffer.from(metaMsg));
    expect(events[0].kind).toBe('metadata');
    expect(events[0].languageDetected).toBe('en-US');
  });

  it('ignores non-JSON messages', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });
    ws.emit('message', Buffer.from('not-json'));
    expect(events.length).toBe(0);
  });

  it('emits error on WebSocket error', async () => {
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });
    ws.emit('error', new Error('connection lost'));
    expect(events[0].kind).toBe('error');
    expect(events[0].code).toBe('WS_ERROR');
  });

  it('sendAudio is no-op when ws is not open', () => {
    const ts2 = new TranscribeStream({ apiKey: 'test' });
    expect(() => ts2.sendAudio(Buffer.from('test'))).not.toThrow();
  });

  it('close returns transcript and duration when ws exists', async () => {
    await ts.start({ source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 } });

    const closePromise = ts.close();
    ws.emit('close');
    const result = await closePromise;
    expect(typeof result.transcript).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.bytes).toBe('number');
  });

  it('close returns zeros when ws is not connected', async () => {
    const ts2 = new TranscribeStream({ apiKey: 'test' });
    const result = await ts2.close();
    expect(result.transcript).toBe('');
    expect(result.durationMs).toBe(0);
    expect(result.bytes).toBe(0);
  });
});

describe('TranscribeStream — Google flow', () => {
  it('rejects provider="google" with helpful message when @google-cloud/speech is not installed', async () => {
    let speechInstalled = false;
    try {
      await import('@google-cloud/speech');
      speechInstalled = true;
    } catch {
      speechInstalled = false;
    }
    if (speechInstalled) return;
    const ts = new TranscribeStream({ apiKey: 'test' });
    await expect(
      ts.start({
        source: { kind: 'inline', encoding: 'linear16', sampleRateHz: 16000 },
        provider: 'google',
      }),
    ).rejects.toThrow(/@google-cloud\/speech/);
  });
});

describe('TranscribeStream — edge cases', () => {
  it('accumulates final transcripts in buffer and joins on close', async () => {
    const ts = new TranscribeStream({ apiKey: 'test-key' });
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));

    const ws = new MockWebSocket();
    attachMockWs(ts, ws);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          start: 0,
          duration: 1,
          channel: { alternatives: [{ transcript: 'hello', confidence: 1, words: [] }] },
        }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          start: 1,
          duration: 1,
          channel: { alternatives: [{ transcript: 'world', confidence: 1, words: [] }] },
        }),
      ),
    );

    const closePromise = ts.close();
    ws.emit('close');
    const result = await closePromise;
    expect(result.transcript).toBe('hello world');
  });

  it('handles Deepgram message with speaker tag', async () => {
    const ts = new TranscribeStream({ apiKey: 'test-key' });
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    const ws = new MockWebSocket();
    attachMockWs(ts, ws);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          start: 0,
          duration: 1,
          channel: {
            alternatives: [
              {
                transcript: 'hello',
                confidence: 1,
                words: [{ word: 'hello', start: 0, end: 1, confidence: 1, speaker: 1 }],
              },
            ],
          },
        }),
      ),
    );
    expect(events[0].kind).toBe('final');
    expect(events[0].speaker).toBe('1');
  });

  it('does not emit interim when transcript is empty', async () => {
    const ts = new TranscribeStream({ apiKey: 'test-key' });
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    const ws = new MockWebSocket();
    attachMockWs(ts, ws);
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'Results',
          is_final: false,
          channel: { alternatives: [{ transcript: '' }] },
        }),
      ),
    );
    expect(events.length).toBe(0);
  });

  it('does not buffer empty final transcript', () => {
    const ts = new TranscribeStream({ apiKey: 'test-key' });
    const events: Record<string, unknown>[] = [];
    ts.on('event', (e: Record<string, unknown>) => events.push(e));
    (ts as unknown as { handleDeepgramMessage(msg: unknown): void }).handleDeepgramMessage({
      type: 'Results',
      is_final: true,
      start: 0,
      duration: 1,
      channel: { alternatives: [{ transcript: '' }] },
    });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('final');
    expect(
      (ts as unknown as { finalTranscriptBuf: { length: number } }).finalTranscriptBuf.length,
    ).toBe(0);
  });
});
