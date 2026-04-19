import { describe, it, expect, beforeEach } from 'vitest';
import { ObservabilityService, createObservabilityService } from './observability-service';

describe('ObservabilityService', () => {
  let service: ObservabilityService;

  beforeEach(() => {
    service = createObservabilityService({
      serviceName: 'test-service',
      serviceVersion: '1.0.0',
    });
  });

  it('should create observability service with all components', () => {
    expect(service.tracer).toBeDefined();
    expect(service.metrics).toBeDefined();
    expect(service.logger).toBeDefined();
    expect(service.costs).toBeDefined();
  });

  it('should shutdown all components', async () => {
    await expect(service.shutdown()).resolves.not.toThrow();
  });
});
