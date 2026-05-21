import { beforeEach, describe, expect, it } from 'vitest';

import { MetricsService } from './metrics-service.js';

describe('MetricsService', () => {
  let metrics: MetricsService;

  const baseConfig = {
    serviceName: 'test-service',
    serviceVersion: '1.0.0',
  };

  beforeEach(() => {
    metrics = new MetricsService(baseConfig);
  });

  it('should record operation duration', () => {
    expect(() => {
      metrics.recordOperationDuration('image.generate', 'stability', 1234);
    }).not.toThrow();
  });

  it('should record operation cost', () => {
    expect(() => {
      metrics.recordOperationCost('image.generate', 'openai', 0.05);
    }).not.toThrow();
  });

  it('should record pipeline duration', () => {
    expect(() => {
      metrics.recordPipelineDuration('pipe-123', 5678);
    }).not.toThrow();
  });

  it('should record pipeline duration with different pipeline id', () => {
    expect(() => {
      metrics.recordPipelineDuration('pipe-456', 1000);
    }).not.toThrow();
  });

  it('should increment pipeline steps', () => {
    expect(() => {
      metrics.incrementPipelineSteps('pipe-123');
    }).not.toThrow();
  });

  it('should increment pipeline steps with custom count', () => {
    expect(() => {
      metrics.incrementPipelineSteps('pipe-123', 5);
    }).not.toThrow();
  });

  it('should record quality gate pass rate', () => {
    expect(() => {
      metrics.recordQualityGatePassRate('llm-judge', 0.95);
    }).not.toThrow();
  });

  it('should record quality gate pass rate with different type', () => {
    expect(() => {
      metrics.recordQualityGatePassRate('threshold', 0.8);
    }).not.toThrow();
  });

  it('should increment quality gate retries', () => {
    expect(() => {
      metrics.incrementQualityGateRetries('llm-judge');
    }).not.toThrow();
  });

  it('should increment quality gate retries with custom count', () => {
    expect(() => {
      metrics.incrementQualityGateRetries('threshold', 3);
    }).not.toThrow();
  });

  it('should record provider error rate', () => {
    expect(() => {
      metrics.recordProviderErrorRate('stability', 'image.generate', 0.02);
    }).not.toThrow();
  });

  it('should record provider error rate with different provider', () => {
    expect(() => {
      metrics.recordProviderErrorRate('replicate', 'image.upscale', 0.1);
    }).not.toThrow();
  });

  it('should shutdown gracefully', async () => {
    await expect(metrics.shutdown()).resolves.toBeUndefined();
  });

  it('should handle shutdown when meterProvider is undefined', async () => {
    const metrics2 = new MetricsService(baseConfig);
    // @ts-expect-error - accessing private for test
    delete metrics2.meterProvider;
    await expect(metrics2.shutdown()).resolves.toBeUndefined();
  });
});
