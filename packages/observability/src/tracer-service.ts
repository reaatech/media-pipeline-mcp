import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import type { ObservabilityConfig } from './observability-service.js';

export class TracerService {
  private sdk?: opentelemetry.NodeSDK;
  private tracer = trace.getTracer('media-pipeline-mcp');

  constructor(config: ObservabilityConfig) {
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion,
    });

    const instrumentations = [getNodeAutoInstrumentations()];

    const traceExporter = config.otlpEndpoint
      ? new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` })
      : undefined;

    this.sdk = new opentelemetry.NodeSDK({
      resource,
      instrumentations,
      traceExporter,
    });

    this.sdk.start();
  }

  startPipelineSpan(pipelineId: string): Span {
    const span = this.tracer.startSpan('media.pipeline', {
      attributes: {
        'media.pipeline_id': pipelineId,
      },
    });
    return span;
  }

  startOperationSpan(operation: string, provider?: string, artifactId?: string): Span {
    const span = this.tracer.startSpan(`media.${operation}`, {
      attributes: {
        'media.operation': operation,
        ...(provider && { 'media.provider': provider }),
        ...(artifactId && { 'media.artifact_id': artifactId }),
      },
    });
    return span;
  }

  setSpanAttributes(span: Span, attributes: Record<string, string | number | boolean>): void {
    span.setAttributes(attributes);
  }

  recordSpanError(span: Span, error: Error): void {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  endSpan(span: Span): void {
    span.end();
  }

  withSpan<T>(span: Span, fn: () => T): T {
    const ctx = trace.setSpan(context.active(), span);
    return context.with(ctx, fn);
  }

  async shutdown(): Promise<void> {
    if (this.sdk) {
      await this.sdk.shutdown();
    }
  }
}
