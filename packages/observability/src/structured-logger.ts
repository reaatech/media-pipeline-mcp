import type { ObservabilityConfig } from './observability-service.js';

export interface LogContext {
  pipelineId?: string;
  stepId?: string;
  traceId?: string;
  operation?: string;
  provider?: string;
  artifactId?: string;
  costUsd?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export class StructuredLogger {
  private logLevel: number;
  private serviceName: string;

  constructor(config: ObservabilityConfig) {
    this.serviceName = config.serviceName;
    this.logLevel = this.parseLogLevel(config.logLevel || 'info');
  }

  private parseLogLevel(level: string): number {
    const levels: Record<string, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return levels[level.toLowerCase()] ?? 1;
  }

  private shouldLog(level: number): boolean {
    return level >= this.logLevel;
  }

  private formatLog(level: string, message: string, context?: LogContext): string {
    const logEntry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      level,
      message,
      ...context,
    };
    return JSON.stringify(logEntry);
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog(0)) {
      console.debug(this.formatLog('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog(1)) {
      console.info(this.formatLog('info', message, context));
    }
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog(2)) {
      console.warn(this.formatLog('warn', message, context));
    }
  }

  error(message: string, error?: Error, context?: LogContext): void {
    if (this.shouldLog(3)) {
      const logContext = {
        ...context,
        error: error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
      };
      console.error(this.formatLog('error', message, logContext));
    }
  }

  logOperation(
    operation: string,
    provider: string,
    artifactId: string,
    costUsd: number,
    durationMs: number,
    context?: LogContext,
  ): void {
    this.info(`Operation ${operation} completed`, {
      operation,
      provider,
      artifactId,
      costUsd,
      durationMs,
      ...context,
    });
  }

  logPipelineStep(
    pipelineId: string,
    stepId: string,
    operation: string,
    status: 'start' | 'complete' | 'failed' | 'gated',
    context?: LogContext,
  ): void {
    this.info(`Pipeline step ${status}`, {
      pipelineId,
      stepId,
      operation,
      status,
      ...context,
    });
  }
}
