import { describe, it, expect, beforeEach } from 'vitest';
import { CostReporter } from './cost-reporter';

describe('CostReporter', () => {
  let reporter: CostReporter;

  beforeEach(() => {
    reporter = new CostReporter();
  });

  it('should record costs and update summary', () => {
    reporter.recordCost({
      pipelineId: 'pipe-123',
      stepId: 'step-1',
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
      artifactId: 'artifact-123',
    });

    const summary = reporter.getSummary();
    expect(summary.totalCostUsd).toBe(0.01);
    expect(summary.byPipeline.get('pipe-123')).toBe(0.01);
    expect(summary.byOperation.get('image.generate')).toBe(0.01);
    expect(summary.byProvider.get('stability')).toBe(0.01);
  });

  it('should aggregate costs across multiple entries', () => {
    reporter.recordCost({
      pipelineId: 'pipe-123',
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    reporter.recordCost({
      pipelineId: 'pipe-123',
      operation: 'image.upscale',
      provider: 'replicate',
      costUsd: 0.005,
    });

    const summary = reporter.getSummary();
    expect(summary.totalCostUsd).toBe(0.015);
    expect(summary.byPipeline.get('pipe-123')).toBe(0.015);
    expect(summary.byOperation.get('image.generate')).toBe(0.01);
    expect(summary.byOperation.get('image.upscale')).toBe(0.005);
  });

  it('should return pipeline-specific cost', () => {
    reporter.recordCost({
      pipelineId: 'pipe-1',
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    reporter.recordCost({
      pipelineId: 'pipe-2',
      operation: 'image.generate',
      provider: 'openai',
      costUsd: 0.02,
    });

    expect(reporter.getPipelineCost('pipe-1')).toBe(0.01);
    expect(reporter.getPipelineCost('pipe-2')).toBe(0.02);
    expect(reporter.getPipelineCost('pipe-3')).toBe(0);
  });

  it('should return operation-specific cost', () => {
    reporter.recordCost({
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    reporter.recordCost({
      operation: 'image.upscale',
      provider: 'replicate',
      costUsd: 0.005,
    });

    expect(reporter.getOperationCost('image.generate')).toBe(0.01);
    expect(reporter.getOperationCost('image.upscale')).toBe(0.005);
  });

  it('should return provider-specific cost', () => {
    reporter.recordCost({
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    reporter.recordCost({
      operation: 'image.generate',
      provider: 'openai',
      costUsd: 0.02,
    });

    expect(reporter.getProviderCost('stability')).toBe(0.01);
    expect(reporter.getProviderCost('openai')).toBe(0.02);
  });

  it('should maintain cost history', () => {
    reporter.recordCost({
      operation: 'op1',
      provider: 'prov1',
      costUsd: 0.01,
    });

    reporter.recordCost({
      operation: 'op2',
      provider: 'prov2',
      costUsd: 0.02,
    });

    const history = reporter.getCostHistory();
    expect(history).toHaveLength(2);
    // All entries should be present
    const operations = history.map((e) => e.operation);
    expect(operations).toContain('op1');
    expect(operations).toContain('op2');
  });

  it('should limit cost history when specified', () => {
    reporter.recordCost({
      operation: 'op1',
      provider: 'prov1',
      costUsd: 0.01,
    });

    reporter.recordCost({
      operation: 'op2',
      provider: 'prov2',
      costUsd: 0.02,
    });

    reporter.recordCost({
      operation: 'op3',
      provider: 'prov3',
      costUsd: 0.03,
    });

    const limitedHistory = reporter.getCostHistory(2);
    expect(limitedHistory).toHaveLength(2);
    // Should return only 2 entries
    const operations = limitedHistory.map((e) => e.operation);
    expect(operations).toHaveLength(2);
  });

  it('should reset all data', () => {
    reporter.recordCost({
      pipelineId: 'pipe-123',
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    reporter.reset();

    const summary = reporter.getSummary();
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byPipeline.size).toBe(0);
    expect(summary.byOperation.size).toBe(0);
    expect(summary.byProvider.size).toBe(0);
    expect(reporter.getCostHistory()).toHaveLength(0);
  });

  it('should handle costs without pipeline ID', () => {
    reporter.recordCost({
      operation: 'image.generate',
      provider: 'stability',
      costUsd: 0.01,
    });

    const summary = reporter.getSummary();
    expect(summary.totalCostUsd).toBe(0.01);
    expect(summary.byPipeline.size).toBe(0);
    expect(summary.byOperation.get('image.generate')).toBe(0.01);
  });
});
