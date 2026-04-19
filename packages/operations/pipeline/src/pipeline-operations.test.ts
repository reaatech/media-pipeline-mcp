import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineOperations } from './pipeline-operations.js';
import { ArtifactRegistry } from '@media-pipeline/core';

describe('PipelineOperations', () => {
  let artifactRegistry: ArtifactRegistry;
  let operations: PipelineOperations;

  beforeEach(() => {
    artifactRegistry = new ArtifactRegistry();
    operations = new PipelineOperations(artifactRegistry);
  });

  describe('templates', () => {
    it('should list all default templates', async () => {
      const templates = operations.listTemplates();

      expect(templates.length).toBe(4);
      expect(templates.some((t) => t.id === 'product-photo')).toBe(true);
      expect(templates.some((t) => t.id === 'social-media-kit')).toBe(true);
      expect(templates.some((t) => t.id === 'document-intake')).toBe(true);
      expect(templates.some((t) => t.id === 'video-thumbnail')).toBe(true);
    });

    it('should get specific template by ID', async () => {
      const template = operations.getTemplate('product-photo');

      expect(template).toBeDefined();
      expect(template!.name).toBe('Product Photo Pipeline');
      expect(template!.steps.length).toBe(3);
    });

    it('should return undefined for non-existent template', async () => {
      const template = operations.getTemplate('non-existent');

      expect(template).toBeUndefined();
    });
  });

  describe('validatePipeline', () => {
    it('should validate valid pipeline', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: 'A cat' },
            config: {},
          },
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
      };

      const result = operations.validatePipeline(pipeline);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect duplicate step IDs', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: 'A cat' },
            config: {},
          },
          {
            id: 'step1',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
      };

      const result = operations.validatePipeline(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate step ID: step1');
    });

    it('should detect reference to non-existent step', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
      };

      const result = operations.validatePipeline(pipeline);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Step step2 references non-existent step: step1');
    });
  });

  describe('interpolateVariables', () => {
    it('should interpolate variables in template', async () => {
      const template = operations.getTemplate('product-photo')!;

      const steps = operations.interpolateVariables(template, {
        prompt: 'A professional product photo',
      });

      expect(steps.length).toBe(3);
      expect(steps[0].inputs.prompt).toBe('A professional product photo');
    });

    it('should preserve step output references', async () => {
      const template = operations.getTemplate('social-media-kit')!;

      const steps = operations.interpolateVariables(template, {
        prompt: 'A logo',
      });

      expect(steps[1].inputs.artifact_id).toBe('{{step1.output}}');
      expect(steps[2].inputs.artifact_id).toBe('{{step1.output}}');
    });
  });

  describe('executePipeline', () => {
    it('should execute valid pipeline successfully', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: 'A cat' },
            config: {},
          },
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
      };

      const result = await operations.executePipeline(pipeline);

      expect(result.status).toBe('completed');
      expect(result.artifacts.length).toBe(2);
      expect(result.cost_usd).toBe(0.02);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should fail on invalid pipeline', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: '{{step2.output}}' }, // Reference to non-existent step
            config: {},
          },
        ],
      };

      const result = await operations.executePipeline(pipeline);

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
    });

    it('should correctly interpolate step outputs during execution', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: 'A cat' },
            config: {},
          },
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
          {
            id: 'step3',
            operation: 'image.resize',
            inputs: { artifact_id: '{{step2.output}}' },
            config: {},
          },
        ],
      };

      const result = await operations.executePipeline(pipeline);

      expect(result.status).toBe('completed');
      expect(result.artifacts.length).toBe(3);
      expect(result.cost_usd).toBe(0.03);
    });
  });
});
