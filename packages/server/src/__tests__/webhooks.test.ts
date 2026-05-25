import { createServer, type IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInboundWebhookHandler } from '../webhooks/inbound.js';
import {
  SubscriptionManager,
  verifyWebhookSignature,
  WebhookDeliveryService,
} from '../webhooks/index.js';

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    manager = new SubscriptionManager();
  });

  afterEach(() => {
    manager.clear();
  });

  it('should create a subscription', () => {
    const sub = manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://example.com/webhook',
      events: ['pipeline:complete', 'step:complete'],
    });

    expect(sub.id).toBeDefined();
    expect(sub.pipelineId).toBe('pipeline-1');
    expect(sub.url).toBe('https://example.com/webhook');
    expect(sub.events).toEqual(['pipeline:complete', 'step:complete']);
    expect(sub.createdAt).toBeInstanceOf(Date);
  });

  it('should store optional secret and headers', () => {
    const sub = manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://example.com/webhook',
      events: ['pipeline:complete'],
      secret: 'my-secret',
      headers: { 'X-Custom': 'value' },
    });

    expect(sub.secret).toBe('my-secret');
    expect(sub.headers).toEqual({ 'X-Custom': 'value' });
  });

  it('should unsubscribe by id', () => {
    const sub = manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://example.com/webhook',
      events: ['pipeline:complete'],
    });

    const deleted = manager.unsubscribe(sub.id);
    expect(deleted).toBe(true);
    expect(manager.get(sub.id)).toBeUndefined();
  });

  it('should find subscriptions by pipeline id', () => {
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://a.com/hook',
      events: ['pipeline:complete'],
    });
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://b.com/hook',
      events: ['step:complete'],
    });
    manager.subscribe({
      pipelineId: 'pipeline-2',
      url: 'https://c.com/hook',
      events: ['pipeline:complete'],
    });

    const subs = manager.findByPipelineId('pipeline-1');
    expect(subs).toHaveLength(2);
  });

  it('should find subscriptions by event', () => {
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://a.com/hook',
      events: ['pipeline:complete', 'step:complete'],
    });
    manager.subscribe({
      pipelineId: 'pipeline-2',
      url: 'https://b.com/hook',
      events: ['pipeline:complete'],
    });

    const subs = manager.findByEvent('step:complete');
    expect(subs).toHaveLength(1);
  });

  it('should find subscriptions by pipeline id and event', () => {
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://a.com/hook',
      events: ['pipeline:complete', 'step:complete'],
    });
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://b.com/hook',
      events: ['pipeline:complete'],
    });

    const subs = manager.findByPipelineIdAndEvent('pipeline-1', 'step:complete');
    expect(subs).toHaveLength(1);
  });

  it('should list all subscriptions', () => {
    manager.subscribe({
      pipelineId: 'pipeline-1',
      url: 'https://a.com/hook',
      events: ['pipeline:complete'],
    });
    manager.subscribe({
      pipelineId: 'pipeline-2',
      url: 'https://b.com/hook',
      events: ['step:complete'],
    });

    const list = manager.list();
    expect(list).toHaveLength(2);
  });

  it('should return false when unsubscribing non-existent id', () => {
    const deleted = manager.unsubscribe('nonexistent');
    expect(deleted).toBe(false);
  });
});

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let testServer: ReturnType<typeof createServer>;
  let serverUrl: string;

  beforeEach(async () => {
    service = new WebhookDeliveryService();
    testServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
      testServer.listen(0, () => {
        const addr = testServer.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    service.destroy();
    testServer.close();
  });

  it('should track delivery attempts', async () => {
    const subscription = {
      id: 'sub-1',
      pipelineId: 'pipeline-1',
      url: serverUrl,
      events: ['pipeline:complete'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    const record = await service.deliverEvent('run-1', event, subscription);

    expect(record.subscriptionId).toBe('sub-1');
    expect(record.eventType).toBe('pipeline:complete');
    expect(record.attempt).toBe(1);
    expect(record.maxAttempts).toBe(5);
  });

  it('should attempt delivery to a working endpoint', async () => {
    const subscription = {
      id: 'sub-2',
      pipelineId: 'pipeline-1',
      url: serverUrl,
      events: ['pipeline:complete'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    const record = await service.deliverEvent('run-1', event, subscription);
    expect(record.status).toBe('success');
    expect(record.statusCode).toBe(200);
  });

  it('should handle delivery to a 500 endpoint', async () => {
    const errorServer = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    });

    await new Promise<void>((resolve) => {
      errorServer.listen(0, async () => {
        const addr = errorServer.address() as AddressInfo;
        const errorServerUrl = `http://127.0.0.1:${addr.port}`;

        const subscription = {
          id: 'sub-3',
          pipelineId: 'pipeline-1',
          url: errorServerUrl,
          events: ['pipeline:complete'],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const event = {
          type: 'pipeline:complete' as const,
          pipelineId: 'pipeline-1',
          timestamp: new Date().toISOString(),
        };

        const record = await service.deliverEvent('run-1', event, subscription);
        expect(record.status).toBe('failed');
        expect(record.statusCode).toBe(500);

        errorServer.close();
        resolve();
      });
    });
  });

  it('should compute HMAC signature header', async () => {
    const subscription = {
      id: 'sub-4',
      pipelineId: 'pipeline-1',
      url: serverUrl,
      events: ['pipeline:complete'],
      secret: 'test-secret',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    const record = await service.deliverEvent('run-1', event, subscription);
    expect(record.status).toBe('success');
  });

  it('should allow retrieval of delivery attempts', async () => {
    const subscription = {
      id: 'sub-5',
      pipelineId: 'pipeline-1',
      url: serverUrl,
      events: ['pipeline:complete'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    await service.deliverEvent('run-1', event, subscription);
    const attempts = service.getAttempts('sub-5');
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });

  it('should retry on 5xx and set retry timer', async () => {
    const errorServer = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
    });

    await new Promise<void>((resolve) => {
      errorServer.listen(0, async () => {
        const addr = errorServer.address() as AddressInfo;
        const url = `http://127.0.0.1:${addr.port}`;

        const subscription = {
          id: 'sub-retry3',
          pipelineId: 'pipeline-1',
          url,
          events: ['pipeline:complete'],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const event = {
          type: 'pipeline:complete' as const,
          pipelineId: 'pipeline-1',
          timestamp: new Date().toISOString(),
        };

        const record = await service.deliverEvent('run-retry3', event, subscription);
        expect(record.status).toBe('failed');
        expect(record.attempt).toBe(1);

        // Wait for the first retry delay to elapse (1s for attempt 0)
        await new Promise((r) => setTimeout(r, 1200));
        const attempts = service.getAttempts('sub-retry3');
        expect(attempts.length).toBeGreaterThanOrEqual(2);

        errorServer.close();
        resolve();
      });
    });
  }, 15000);

  it('should handle network error during delivery', async () => {
    const subscription = {
      id: 'sub-net',
      pipelineId: 'pipeline-1',
      url: 'http://localhost:1/nonexistent',
      events: ['pipeline:complete'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    const record = await service.deliverEvent('run-net', event, subscription);
    expect(record.status).toBe('failed');
    expect(record.error).toBeDefined();
  }, 10000);

  it('should cancel retries for a subscription', async () => {
    const subscription = {
      id: 'sub-cancel',
      pipelineId: 'pipeline-1',
      url: 'http://localhost:2/nonexistent',
      events: ['pipeline:complete'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const event = {
      type: 'pipeline:complete' as const,
      pipelineId: 'pipeline-1',
      timestamp: new Date().toISOString(),
    };

    const record = await service.deliverEvent('run-cancel', event, subscription);
    expect(record.status).toBe('failed');
    service.cancelRetries('sub-cancel');
    const attempts = service.getAttempts('sub-cancel');
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('should clear all state on destroy', () => {
    service.destroy();
    const attempts = service.getAttempts('sub-none');
    expect(attempts).toHaveLength(0);
  });
});

describe('InboundWebhookHandler', () => {
  function makeReq(body: string, headers?: Record<string, string>): IncomingMessage {
    const stream = Readable.from([Buffer.from(body, 'utf8')]);
    const req = stream as unknown as IncomingMessage;
    req.headers = headers ?? {};
    (req as unknown as { url: string }).url = '/webhooks';
    return req;
  }

  function makeRes(): { res: ServerResponse; statusCode: number; body: string } {
    const result = { statusCode: 0, body: '' };
    const socket = new Socket();
    // ServerResponse expects an IncomingMessage; in tests we only need a
    // socket-like to construct it, so cast through unknown.
    const res = new ServerResponse(socket as unknown as IncomingMessage);
    res.writeHead = vi.fn(function (this: ServerResponse, code: number, _h?: unknown) {
      result.statusCode = code;
      return this;
    }) as unknown as ServerResponse['writeHead'];
    res.end = vi.fn(function (this: ServerResponse, data: unknown) {
      result.body = typeof data === 'string' ? data : JSON.stringify(data);
      return this;
    }) as unknown as ServerResponse['end'];
    return {
      res,
      get statusCode() {
        return result.statusCode;
      },
      get body() {
        return result.body;
      },
    };
  }

  // Spec §F7 URL is /webhooks/:provider/:runId — handler's findRun(runId) callback
  // looks up the active run state. Test helpers below produce a findRun that returns
  // a configurable status, mirroring the in-server lookup against this.pipelines.
  function makeFindRun(state?: 'running' | 'completed' | 'failed' | 'cancelled' | null) {
    return vi.fn(async (runId: string) => {
      if (state === null) return null;
      return { runId, status: state ?? 'running' };
    });
  }

  it('should return 400 when provider or runId missing', async () => {
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun(),
      resumePipelineFn: vi.fn(),
    });
    const req = makeReq('{}');
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', '']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(400);
    expect(body).toContain('Missing');
  });

  it('should return 401 on invalid signature', async () => {
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun(),
      resumePipelineFn: vi.fn(),
      webhookSecrets: { replicate: 'test-secret' },
    });
    const req = makeReq('{}', { 'webhook-signature': 'invalid' });
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'replicate', 'run-1']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(401);
    expect(body).toContain('Invalid signature');
  });

  it('should return 200 on valid signature and resume', async () => {
    const expectedSig = computeReplicateSig('test-secret', '{}');
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun('running'),
      resumePipelineFn: vi.fn().mockResolvedValue(undefined),
      webhookSecrets: { replicate: 'test-secret' },
    });
    const req = makeReq('{}', { 'webhook-signature': expectedSig });
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'replicate', 'run-1']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(200);
    expect(body).toContain('resumed');
  });

  it('should return 404 for unknown run', async () => {
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun(null),
      resumePipelineFn: vi.fn(),
    });
    const req = makeReq('{}');
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'provider', 'run-99']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(404);
    expect(body).toContain('Unknown run');
  });

  it('should return 410 for late webhook (already completed)', async () => {
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun('completed'),
      resumePipelineFn: vi.fn(),
    });
    const req = makeReq('{}');
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'provider', 'run-complete']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(410);
    expect(body).toContain('Late webhook');
  });

  it('should return 500 on resume pipeline error', async () => {
    const handler = createInboundWebhookHandler({
      findRun: makeFindRun('running'),
      resumePipelineFn: vi.fn().mockRejectedValue(new Error('Resume failed')),
    });
    const req = makeReq('{}');
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'provider', 'run-err']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = (res.end as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(500);
    expect(body).toContain('Resume failed');
  });

  it('should handle non-buffer chunk in body parsing', async () => {
    const stream = Readable.from(['{"hello":"world"}']);
    const req = stream as unknown as IncomingMessage;
    req.headers = {};
    (req as unknown as { url: string }).url = '/webhooks';

    const handler = createInboundWebhookHandler({
      findRun: makeFindRun('running'),
      resumePipelineFn: vi.fn().mockResolvedValue(undefined),
    });
    const { res } = makeRes();
    await handler(req, res as unknown as ServerResponse, ['', 'provider', 'run-nonbuf']);
    const statusCode = (res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(statusCode).toBe(200);
    expect((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('resumed');
  });
});

function computeReplicateSig(secret: string, body: string): string {
  const { createHmac } = require('node:crypto');
  const ts = Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${body}`;
  const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${ts},v1=${v1}`;
}

describe('verifyWebhookSignature', () => {
  it('should verify replicate signature with valid timestamp', async () => {
    const secret = 'test-secret';
    const body = JSON.stringify({ event: 'test' });
    const signature = computeReplicateSig(secret, body);
    const valid = await verifyWebhookSignature(
      'replicate',
      { 'webhook-signature': signature },
      body,
      secret,
    );
    expect(valid).toBe(true);
  });

  it('should reject replicate signature with missing header', async () => {
    const valid = await verifyWebhookSignature('replicate', {}, '{}', 'secret');
    expect(valid).toBe(false);
  });

  it('should reject replicate signature with bad format', async () => {
    const valid = await verifyWebhookSignature(
      'replicate',
      { 'webhook-signature': 'bad-format' },
      '{}',
      'secret',
    );
    expect(valid).toBe(false);
  });

  it('should reject replicate signature with missing timestamp', async () => {
    const valid = await verifyWebhookSignature(
      'replicate',
      { 'webhook-signature': 'v1=abc' },
      '{}',
      'secret',
    );
    expect(valid).toBe(false);
  });

  it('should reject replicate signature with expired timestamp', async () => {
    const { createHmac } = require('node:crypto');
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const signedPayload = `${oldTs}.{}`;
    const v1 = createHmac('sha256', 'secret').update(signedPayload).digest('hex');
    const signature = `t=${oldTs},v1=${v1}`;
    const valid = await verifyWebhookSignature(
      'replicate',
      { 'webhook-signature': signature },
      '{}',
      'secret',
    );
    expect(valid).toBe(false);
  });

  it('should verify fal signature', async () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'secret').update('body').digest('hex');
    const valid = await verifyWebhookSignature('fal', { 'x-fal-signature': sig }, 'body', 'secret');
    expect(valid).toBe(true);
  });

  it('should reject fal signature with missing header', async () => {
    const valid = await verifyWebhookSignature('fal', {}, 'body', 'secret');
    expect(valid).toBe(false);
  });

  it('should verify deepgram signature', async () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'secret').update('body').digest('hex');
    const valid = await verifyWebhookSignature(
      'deepgram',
      { 'x-deepgram-signature': sig },
      'body',
      'secret',
    );
    expect(valid).toBe(true);
  });

  it('should reject deepgram signature with missing header', async () => {
    const valid = await verifyWebhookSignature('deepgram', {}, 'body', 'secret');
    expect(valid).toBe(false);
  });

  // Per security fix #3: unknown providers REJECT by default. The previous
  // `return true` was a bypass — any provider not in the SIGNATURE_HEADERS table
  // would accept any payload as valid.
  it('should return false for unknown provider without registered header', async () => {
    const valid = await verifyWebhookSignature('unknown-provider', {}, '{}', 'secret');
    expect(valid).toBe(false);
  });

  it('should return false for unknown provider even with signature header', async () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'generic-secret').update('payload').digest('hex');
    const valid = await verifyWebhookSignature(
      'generic-provider',
      { 'generic-signature': sig },
      'payload',
      'generic-secret',
    );
    expect(valid).toBe(false);
  });

  it('should handle fal with lowercase header', async () => {
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', 'secret').update('body').digest('hex');
    const valid = await verifyWebhookSignature('fal', { 'x-fal-signature': sig }, 'body', 'secret');
    expect(valid).toBe(true);
  });
});
