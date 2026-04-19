import { TracerService } from './tracer-service.js';
import { MetricsService } from './metrics-service.js';
import { StructuredLogger } from './structured-logger.js';
import { CostReporter } from './cost-reporter.js';

export interface ObservabilityConfig {
  serviceName: string;
  serviceVersion: string;
  otlpEndpoint?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class ObservabilityService {
  public readonly tracer: TracerService;
  public readonly metrics: MetricsService;
  public readonly logger: StructuredLogger;
  public readonly costs: CostReporter;

  constructor(config: ObservabilityConfig) {
    this.tracer = new TracerService(config);
    this.metrics = new MetricsService(config);
    this.logger = new StructuredLogger(config);
    this.costs = new CostReporter();
  }

  async shutdown(): Promise<void> {
    await this.tracer.shutdown();
    await this.metrics.shutdown();
  }
}

export function createObservabilityService(config: ObservabilityConfig): ObservabilityService {
  return new ObservabilityService(config);
}
