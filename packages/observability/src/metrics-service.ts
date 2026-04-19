import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ValueType } from '@opentelemetry/api';
import type { ObservabilityConfig } from './observability-service.js';

export class MetricsService {
  private meterProvider?: MeterProvider;
  private operationDurationHistogram?: any;
  private operationCostHistogram?: any;
  private pipelineDurationHistogram?: any;
  private pipelineStepsCounter?: any;
  private qualityGatePassRateGauge?: any;
  private qualityGateRetryCounter?: any;
  private providerErrorRateGauge?: any;

  constructor(config: ObservabilityConfig) {
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion,
    });

    // Use a simple metric reader - only create periodic exporter if OTLP endpoint is configured
    const metricReader = config.otlpEndpoint
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${config.otlpEndpoint}/v1/metrics` }),
        })
      : undefined;

    this.meterProvider = new MeterProvider({
      resource,
      ...(metricReader && { readers: [metricReader] }),
    });

    const meter = this.meterProvider.getMeter('media-pipeline-mcp');

    this.operationDurationHistogram = meter.createHistogram('media.operation.duration_ms', {
      description: 'Operation latency by type and provider',
      unit: 'ms',
      valueType: ValueType.DOUBLE,
    });

    this.operationCostHistogram = meter.createHistogram('media.operation.cost_usd', {
      description: 'Cost per operation by type and provider',
      unit: 'USD',
      valueType: ValueType.DOUBLE,
    });

    this.pipelineDurationHistogram = meter.createHistogram('media.pipeline.duration_ms', {
      description: 'End-to-end pipeline execution time',
      unit: 'ms',
      valueType: ValueType.DOUBLE,
    });

    this.pipelineStepsCounter = meter.createCounter('media.pipeline.steps_total', {
      description: 'Total number of pipeline steps executed',
      valueType: ValueType.INT,
    });

    this.qualityGatePassRateGauge = meter.createGauge('media.quality_gate.pass_rate', {
      description: 'Quality gate pass rate by type',
      valueType: ValueType.DOUBLE,
    });

    this.qualityGateRetryCounter = meter.createCounter('media.quality_gate.retry_count', {
      description: 'Number of quality gate retries',
      valueType: ValueType.INT,
    });

    this.providerErrorRateGauge = meter.createGauge('media.provider.error_rate', {
      description: 'Provider error rate by provider and operation',
      valueType: ValueType.DOUBLE,
    });
  }

  recordOperationDuration(operation: string, provider: string, durationMs: number): void {
    this.operationDurationHistogram?.record(durationMs, {
      'media.operation': operation,
      'media.provider': provider,
    });
  }

  recordOperationCost(operation: string, provider: string, costUsd: number): void {
    this.operationCostHistogram?.record(costUsd, {
      'media.operation': operation,
      'media.provider': provider,
    });
  }

  recordPipelineDuration(pipelineId: string, durationMs: number): void {
    this.pipelineDurationHistogram?.record(durationMs, {
      'media.pipeline_id': pipelineId,
    });
  }

  incrementPipelineSteps(pipelineId: string, count: number = 1): void {
    this.pipelineStepsCounter?.add(count, {
      'media.pipeline_id': pipelineId,
    });
  }

  recordQualityGatePassRate(gateType: string, passRate: number): void {
    this.qualityGatePassRateGauge?.record(passRate, {
      'media.quality_gate_type': gateType,
    });
  }

  incrementQualityGateRetries(gateType: string, count: number = 1): void {
    this.qualityGateRetryCounter?.add(count, {
      'media.quality_gate_type': gateType,
    });
  }

  recordProviderErrorRate(provider: string, operation: string, errorRate: number): void {
    this.providerErrorRateGauge?.record(errorRate, {
      'media.provider': provider,
      'media.operation': operation,
    });
  }

  async shutdown(): Promise<void> {
    if (this.meterProvider) {
      await this.meterProvider.shutdown();
    }
  }
}
