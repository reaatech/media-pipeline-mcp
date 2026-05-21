import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyWebhookSignature } from './signatures.js';

/**
 * Inbound webhook handler for provider async-job callbacks (F7).
 *
 * Route shape: `POST /webhooks/:provider/:runId` (per plan §F7) — the runId is the
 * server's own pipeline run id, embedded in the webhook URL handed to the provider
 * at job-start. This is simpler and more reliable than looking the run up by the
 * provider's jobId, which requires parsing each provider's payload format.
 *
 * The provider-jobId tuple is still validated as a defense-in-depth check when a
 * `findByProviderJobId` callback is wired (e.g. to detect duplicate webhooks or
 * URL tampering), but the canonical lookup is `findRun(runId)`.
 */
export interface InboundWebhookHandlerOptions {
  /** Look up a run by its server-issued runId (matches `:runId` in the URL path). */
  findRun: (runId: string) => Promise<{ status?: string; runId?: string } | null>;
  /** Optional: cross-check the provider's payload jobId against the persisted run.
   *  Returns true if the jobId is the one this run is waiting on. */
  findByProviderJobId?: (provider: string, jobId: string) => Promise<{ runId: string } | null>;
  /** Called once signature+lookup succeed. Should invoke pipeline.resume. */
  resumePipelineFn: (runId: string) => Promise<void>;
  /** Per-provider HMAC secrets; absence means signature verification is skipped (dev only). */
  webhookSecrets?: Record<string, string>;
}

export function createInboundWebhookHandler(options: InboundWebhookHandlerOptions) {
  const { findRun, findByProviderJobId, resumePipelineFn, webhookSecrets } = options;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
  ): Promise<void> => {
    // pathSegments[0] === 'webhooks', [1] === provider, [2] === runId
    const [, provider, runId] = pathSegments;

    if (!provider || !runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing provider or runId in path' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const secret = webhookSecrets?.[provider];
    if (secret) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }

      const valid = await verifyWebhookSignature(provider, headers, rawBody, secret);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    // Optional cross-check: if the payload carries an explicit jobId field, confirm
    // it maps to the same runId we got from the URL. Mismatch → 400 (URL tampering or
    // misrouted webhook).
    if (findByProviderJobId) {
      try {
        const payload = JSON.parse(rawBody) as {
          jobId?: string;
          id?: string;
          prediction_id?: string;
        };
        const jobId = payload.jobId ?? payload.id ?? payload.prediction_id;
        if (typeof jobId === 'string' && jobId.length > 0) {
          const match = await findByProviderJobId(provider, jobId);
          if (match && match.runId !== runId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'jobId/runId mismatch',
                expected: runId,
                actual: match.runId,
              }),
            );
            return;
          }
        }
      } catch {
        // Non-JSON payload or no jobId — skip the cross-check.
      }
    }

    const run = await findRun(runId);
    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown run' }));
      return;
    }

    if (run.status === 'completed' || run.status === 'failed') {
      // Late webhook — the run already reached a terminal state. Per spec §F7, return
      // 410 Gone so the provider stops retrying.
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Late webhook: pipeline already finished', status: run.status }),
      );
      return;
    }

    try {
      await resumePipelineFn(runId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'resumed' }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  };
}
