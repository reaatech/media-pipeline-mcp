import { beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from './cost-tracker.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe('record', () => {
    it('should record a cost entry', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      const summary = tracker.getSummary();
      expect(summary.total_usd).toBe(0.01);
    });

    it('should accumulate costs', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      tracker.record({
        operation: 'image.upscale',
        provider: 'replicate',
        cost_usd: 0.005,
        artifactId: 'artifact-2',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      const summary = tracker.getSummary();
      expect(summary.total_usd).toBe(0.015);
    });
  });

  describe('getPipelineCost', () => {
    it('should return cost for a specific pipeline', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      tracker.record({
        operation: 'image.upscale',
        provider: 'replicate',
        cost_usd: 0.005,
        artifactId: 'artifact-2',
        pipelineId: 'pipeline-2',
        timestamp: new Date().toISOString(),
      });

      expect(tracker.getPipelineCost('pipeline-1')).toBe(0.01);
      expect(tracker.getPipelineCost('pipeline-2')).toBe(0.005);
    });
  });

  describe('getOperationCost', () => {
    it('should return cost for a specific operation', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.02,
        artifactId: 'artifact-2',
        pipelineId: 'pipeline-2',
        timestamp: new Date().toISOString(),
      });

      expect(tracker.getOperationCost('image.generate')).toBe(0.03);
    });
  });

  describe('getProviderCost', () => {
    it('should return cost for a specific provider', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      expect(tracker.getProviderCost('stability')).toBe(0.01);
    });
  });

  describe('reset', () => {
    it('should clear all recorded costs', () => {
      tracker.record({
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      });

      tracker.reset();

      const summary = tracker.getSummary();
      expect(summary.total_usd).toBe(0);
      expect(summary.by_operation.size).toBe(0);
      expect(summary.by_provider.size).toBe(0);
      expect(summary.by_pipeline.size).toBe(0);
    });
  });

  describe('getRecords', () => {
    it('should return a copy of all records', () => {
      const record = {
        operation: 'image.generate',
        provider: 'stability',
        cost_usd: 0.01,
        artifactId: 'artifact-1',
        pipelineId: 'pipeline-1',
        timestamp: new Date().toISOString(),
      };

      tracker.record(record);

      const records = tracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(record);
    });
  });
});
