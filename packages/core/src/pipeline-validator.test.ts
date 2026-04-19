import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineValidator, ProviderAvailability } from './pipeline-validator.js';
import type { PipelineDefinition } from './types/index.js';

// Mock ProviderAvailability
class MockProviderAvailability implements ProviderAvailability {
  private availableOperations: Set<string>;

  constructor(availableOperations: string[] = []) {
    this.availableOperations = new Set(availableOperations);
  }

  isAvailable(operation: string): boolean {
    return this.availableOperations.has(operation);
  }

  getEstimatedCost(_operation: string, _config: Record<string, unknown>): number {
    return 0.01;
  }

  getEstimatedDuration(_operation: string, _config: Record<string, unknown>): number {
    return 1000;
  }

  addOperation(operation: string) {
    this.availableOperations.add(operation);
  }
}

describe('PipelineValidator', () => {
  let providerAvailability: MockProviderAvailability;
  let validator: PipelineValidator;

  beforeEach(() => {
    providerAvailability = new MockProviderAvailability(['video.generate', 'image.process']);
    validator = new PipelineValidator(providerAvailability);
  });

  describe('validate', () => {
    it('should validate a correct pipeline definition', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'video.generate',
            inputs: { prompt: 'A cat' },
            config: {},
          },
          {
            id: 'step2',
            operation: 'image.process',
            inputs: { source: '{{step1.output}}' },
            config: {},
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.estimated_cost_usd).toBe(0.02);
      expect(result.estimated_duration_ms).toBe(2000);
    });

    it('should fail for invalid schema', () => {
      const definition = {
        // Missing required id and steps
      } as any;

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Pipeline definition schema validation failed');
    });

    it('should fail for duplicate step IDs', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          { id: 'step1', operation: 'video.generate', inputs: {}, config: {} },
          { id: 'step1', operation: 'image.process', inputs: {}, config: {} },
        ],
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate step ID: step1');
    });

    it('should fail for referencing non-existent step', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'image.process',
            inputs: { source: '{{nonexistent.output}}' },
            config: {},
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('non-existent step'))).toBe(true);
    });

    it('should fail for forward/circular reference', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'image.process',
            inputs: { source: '{{step2.output}}' },
            config: {},
          },
          {
            id: 'step2',
            operation: 'video.generate',
            inputs: {},
            config: {},
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('future step'))).toBe(true);
    });

    it('should fail for unavailable provider', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [{ id: 'step1', operation: 'unknown.operation', inputs: {}, config: {} }],
      };

      const result = validator.validate(definition);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('No provider available'))).toBe(true);
    });

    it('should warn for retry without maxRetries', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'video.generate',
            inputs: {},
            config: {},
            qualityGate: { action: 'retry', type: 'threshold', config: {} },
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.warnings.some((w) => w.includes('no maxRetries specified'))).toBe(true);
    });

    it('should warn for llm-judge without prompt', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'video.generate',
            inputs: {},
            config: {},
            qualityGate: { action: 'fail', type: 'llm-judge', config: {} },
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.warnings.some((w) => w.includes('without a prompt'))).toBe(true);
    });

    it('should warn for threshold without checks', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'video.generate',
            inputs: {},
            config: {},
            qualityGate: { action: 'fail', type: 'threshold', config: {} },
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.warnings.some((w) => w.includes('without checks configured'))).toBe(true);
    });

    it('should warn for dimension-check without expected dimensions', () => {
      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [
          {
            id: 'step1',
            operation: 'video.generate',
            inputs: {},
            config: {},
            qualityGate: { action: 'fail', type: 'dimension-check', config: {} },
          },
        ],
      };

      const result = validator.validate(definition);

      expect(result.warnings.some((w) => w.includes('without expected dimensions'))).toBe(true);
    });

    it('should warn for unavailable provider but still validate', () => {
      providerAvailability = new MockProviderAvailability([]);
      validator = new PipelineValidator(providerAvailability);

      const definition: PipelineDefinition = {
        id: 'pipeline-1',
        steps: [{ id: 'step1', operation: 'video.generate', inputs: {}, config: {} }],
      };

      const result = validator.validate(definition);

      expect(result.warnings.some((w) => w.includes('Provider not available'))).toBe(true);
    });
  });
});
