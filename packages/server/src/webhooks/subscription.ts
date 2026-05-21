export interface PipelineSubscription {
  id: string;
  pipelineId: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineSubscriptionRequest {
  pipelineId: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
}

export class SubscriptionManager {
  private subscriptions: Map<string, PipelineSubscription> = new Map();

  subscribe(request: PipelineSubscriptionRequest): PipelineSubscription {
    const id = `sub-${crypto.randomUUID().substring(0, 8)}`;
    const subscription: PipelineSubscription = {
      id,
      pipelineId: request.pipelineId,
      url: request.url,
      events: request.events,
      secret: request.secret,
      headers: request.headers,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.subscriptions.set(id, subscription);
    return subscription;
  }

  unsubscribe(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  get(id: string): PipelineSubscription | undefined {
    return this.subscriptions.get(id);
  }

  findByPipelineId(pipelineId: string): PipelineSubscription[] {
    return Array.from(this.subscriptions.values()).filter((sub) => sub.pipelineId === pipelineId);
  }

  findByEvent(event: string): PipelineSubscription[] {
    return Array.from(this.subscriptions.values()).filter((sub) => sub.events.includes(event));
  }

  findByPipelineIdAndEvent(pipelineId: string, event: string): PipelineSubscription[] {
    return Array.from(this.subscriptions.values()).filter(
      (sub) => sub.pipelineId === pipelineId && sub.events.includes(event),
    );
  }

  list(): PipelineSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  clear(): void {
    this.subscriptions.clear();
  }
}
