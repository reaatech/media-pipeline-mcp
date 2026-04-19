/**
 * Audit Logger
 *
 * Immutable audit trail for all operations with SIEM export support.
 */

export interface AuditEvent {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  actor: {
    userId: string;
    email: string;
    role: string;
    ipAddress?: string;
    userAgent?: string;
  };
  action: {
    operation: string;
    resourceType: string;
    resourceId?: string;
    parameters?: Record<string, unknown>;
  };
  outcome: {
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    duration_ms: number;
  };
  context: {
    pipelineId?: string;
    artifactId?: string;
    cost_usd?: number;
    tenantId?: string;
    sessionId?: string;
  };
  metadata: Record<string, unknown>;
}

export type AuditEventType =
  | 'authentication'
  | 'authorization'
  | 'pipeline.execute'
  | 'pipeline.define'
  | 'pipeline.resume'
  | 'artifact.create'
  | 'artifact.read'
  | 'artifact.delete'
  | 'provider.health'
  | 'config.change'
  | 'user.create'
  | 'user.delete'
  | 'rate_limit.exceeded';

export interface AuditExportConfig {
  // SIEM endpoints
  splunkEndpoint?: string;
  splunkToken?: string;

  datadogEndpoint?: string;
  datadogApiKey?: string;

  sumoLogicEndpoint?: string;
  sumoLogicSourceName?: string;

  // Retention
  retentionDays: number;

  // Buffering
  bufferSize: number;
  flushInterval: number;
}

export class AuditLogger {
  private config: AuditExportConfig;
  private buffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor(config: AuditExportConfig) {
    this.config = config;

    // Set up periodic flush
    if (config.flushInterval > 0) {
      this.flushTimer = setInterval(() => this.flush(), config.flushInterval);
    }
  }

  /**
   * Log an audit event
   */
  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): void {
    const auditEvent: AuditEvent = {
      ...event,
      id: this.generateId(),
      timestamp: new Date().toISOString(),
    };

    this.buffer.push(auditEvent);

    // Flush immediately if buffer is full
    if (this.buffer.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  /**
   * Log authentication event
   */
  logAuthentication(userId: string, email: string, success: boolean, ipAddress?: string): void {
    this.log({
      eventType: 'authentication',
      actor: { userId, email, role: 'unknown', ipAddress },
      action: { operation: 'auth.login', resourceType: 'user' },
      outcome: { success, duration_ms: 0 },
      context: {},
      metadata: {},
    });
  }

  /**
   * Log authorization failure
   */
  logAuthorizationFailure(userId: string, operation: string, permission: string): void {
    this.log({
      eventType: 'authorization',
      actor: { userId, email: `${userId}@local`, role: 'unknown' },
      action: { operation, resourceType: 'permission' },
      outcome: {
        success: false,
        errorCode: 'FORBIDDEN',
        errorMessage: `Missing permission: ${permission}`,
        duration_ms: 0,
      },
      context: {},
      metadata: { requiredPermission: permission },
    });
  }

  /**
   * Log pipeline execution
   */
  logPipelineExecution(
    userId: string,
    pipelineId: string,
    success: boolean,
    duration_ms: number,
    cost_usd: number,
    tenantId?: string
  ): void {
    this.log({
      eventType: success ? 'pipeline.execute' : 'pipeline.execute',
      actor: { userId, email: `${userId}@local`, role: 'operator' },
      action: { operation: 'pipeline.execute', resourceType: 'pipeline', resourceId: pipelineId },
      outcome: { success, duration_ms },
      context: { pipelineId, cost_usd, tenantId },
      metadata: {},
    });
  }

  /**
   * Log artifact access
   */
  logArtifactAccess(
    userId: string,
    artifactId: string,
    action: 'read' | 'create' | 'delete',
    success: boolean
  ): void {
    this.log({
      eventType: `artifact.${action}`,
      actor: { userId, email: `${userId}@local`, role: 'operator' },
      action: { operation: `artifact.${action}`, resourceType: 'artifact', resourceId: artifactId },
      outcome: { success, duration_ms: 0 },
      context: { artifactId },
      metadata: {},
    });
  }

  /**
   * Log rate limit exceeded
   */
  logRateLimitExceeded(clientId: string, operation?: string): void {
    this.log({
      eventType: 'rate_limit.exceeded',
      actor: { userId: clientId, email: `${clientId}@local`, role: 'unknown' },
      action: { operation: operation || 'unknown', resourceType: 'rate_limit' },
      outcome: {
        success: false,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'Rate limit exceeded',
        duration_ms: 0,
      },
      context: {},
      metadata: { clientId, operation },
    });
  }

  /**
   * Flush buffer to SIEM endpoints
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      // Export to Splunk
      if (this.config.splunkEndpoint && this.config.splunkToken) {
        await this.exportToSplunk(events);
      }

      // Export to Datadog
      if (this.config.datadogEndpoint && this.config.datadogApiKey) {
        await this.exportToDatadog(events);
      }

      // Export to Sumo Logic
      if (this.config.sumoLogicEndpoint) {
        await this.exportToSumoLogic(events);
      }

      // Also write to local file for backup
      await this.writeToFile(events);
    } catch (error) {
      console.error('Audit log flush failed:', error);
      // Re-queue events on failure
      this.buffer = [...events, ...this.buffer];
    }
  }

  private async exportToSplunk(events: AuditEvent[]): Promise<void> {
    const payload = events.map((e) => ({
      time: new Date(e.timestamp).getTime() / 1000,
      host: 'media-pipeline-mcp',
      source: 'audit',
      sourcetype: 'audit:json',
      event: e,
    }));

    await fetch(`${this.config.splunkEndpoint}/services/collector/event`, {
      method: 'POST',
      headers: {
        Authorization: `Splunk ${this.config.splunkToken}`,
        'Content-Type': 'application/json',
      },
      body: payload.map((e) => JSON.stringify(e)).join('\n'),
    });
  }

  private async exportToDatadog(events: AuditEvent[]): Promise<void> {
    const payload = events.map((e) => ({
      ddsource: 'media-pipeline-mcp',
      ddtags: `event_type:${e.eventType},service:media-pipeline-mcp`,
      hostname: 'media-pipeline-mcp',
      message: JSON.stringify(e),
      service: 'media-pipeline-mcp',
      status: e.outcome.success ? 'info' : 'error',
    }));

    await fetch(`${this.config.datadogEndpoint}/api/v2/logs`, {
      method: 'POST',
      headers: {
        'DD-API-KEY': this.config.datadogApiKey || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  private async exportToSumoLogic(events: AuditEvent[]): Promise<void> {
    await fetch(this.config.sumoLogicEndpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: events.map((e) => JSON.stringify(e)).join('\n'),
    });
  }

  private async writeToFile(events: AuditEvent[]): Promise<void> {
    // Write to local file as backup
    const fs = await import('fs/promises');
    const path = await import('path');
    const logDir = path.join(process.cwd(), 'logs', 'audit');
    await fs.mkdir(logDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `audit-${date}.jsonl`);

    await fs.appendFile(logFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  private generateId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    // Final flush
    this.flush();
  }
}

export function createAuditLogger(config: AuditExportConfig): AuditLogger {
  return new AuditLogger(config);
}
