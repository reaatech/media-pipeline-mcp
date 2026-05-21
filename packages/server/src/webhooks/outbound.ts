import { createHmac } from 'node:crypto';
import type { PipelineEvent } from '@reaatech/media-pipeline-mcp-core';
import type { PipelineSubscription } from './subscription.js';

export interface DeliveryAttempt {
  id: string;
  subscriptionId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  statusCode?: number;
  error?: string;
  attempt: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 300_000, 1_800_000]; // 1s, 5s, 30s, 5min, 30min
const MAX_ATTEMPTS = 5;

function computeSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export class WebhookDeliveryService {
  private attempts = new Map<string, DeliveryAttempt[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async deliverEvent(
    runId: string,
    event: PipelineEvent,
    subscription: PipelineSubscription,
  ): Promise<DeliveryAttempt> {
    const payload = JSON.stringify({
      runId,
      event: event.type,
      pipelineId: event.pipelineId,
      stepId: event.stepId,
      timestamp: event.timestamp,
      data: event.data,
    });

    const attemptId = `delivery-${crypto.randomUUID().substring(0, 8)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': event.type,
      'X-Delivery-Id': attemptId,
      ...subscription.headers,
    };

    if (subscription.secret) {
      // Per plan §F7: outbound payloads use X-Media-Pipeline-Signature so subscribers
      // can attribute the signature to this service. The legacy X-Signature-256 header
      // is kept as a duplicate for backwards-compat with subscribers wired against it.
      const sig = `sha256=${computeSignature(payload, subscription.secret)}`;
      headers['X-Media-Pipeline-Signature'] = sig;
      headers['X-Signature-256'] = sig;
    }

    return this.sendWithRetry({
      attemptId,
      subscriptionId: subscription.id,
      eventType: event.type,
      url: subscription.url,
      payload,
      headers,
      attempt: 1,
    });
  }

  private async sendWithRetry(params: {
    attemptId: string;
    subscriptionId: string;
    eventType: string;
    url: string;
    payload: string;
    headers: Record<string, string>;
    attempt: number;
  }): Promise<DeliveryAttempt> {
    const { attemptId, subscriptionId, eventType, url, payload, headers, attempt } = params;
    const maxAttempts = MAX_ATTEMPTS;

    const record: DeliveryAttempt = {
      id: attemptId,
      subscriptionId,
      eventType,
      status: 'pending',
      attempt,
      maxAttempts,
      lastAttemptAt: new Date(),
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      record.status = response.ok ? 'success' : 'failed';
      record.statusCode = response.status;
    } catch (error) {
      record.status = 'failed';
      record.error = (error as Error).message;
    }

    this.recordAttempt(subscriptionId, record);

    if (record.status === 'failed' && attempt < maxAttempts) {
      const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      record.nextRetryAt = new Date(Date.now() + delayMs);

      const timerId = setTimeout(() => {
        void this.sendWithRetry({
          attemptId,
          subscriptionId,
          eventType,
          url,
          payload,
          headers,
          attempt: attempt + 1,
        });
      }, delayMs);

      this.timers.set(attemptId, timerId);
    }

    return record;
  }

  private recordAttempt(subscriptionId: string, record: DeliveryAttempt): void {
    const existing = this.attempts.get(subscriptionId) ?? [];
    existing.push(record);
    this.attempts.set(subscriptionId, existing);
  }

  getAttempts(subscriptionId: string): DeliveryAttempt[] {
    return this.attempts.get(subscriptionId) ?? [];
  }

  cancelRetries(subscriptionId: string): void {
    const attempts = this.attempts.get(subscriptionId) ?? [];
    for (const attempt of attempts) {
      const timer = this.timers.get(attempt.id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(attempt.id);
      }
    }
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.attempts.clear();
  }
}
