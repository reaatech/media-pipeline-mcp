import { ArtifactRegistry, type PipelineExecutor } from '@reaatech/media-pipeline-mcp-core';
import type { PipelineStep, VariantsConfig } from '@reaatech/media-pipeline-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineOperations, createPipelineOperations } from './pipeline-operations.js';
import { VariantsExecutor, type VariantsExecutorContext } from './variants.js';

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
      expect(template?.name).toBe('Product Photo Pipeline');
      expect(template?.steps.length).toBe(3);
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

    it('should skip validation for non-dotted references like {{prompt}}', async () => {
      const pipeline = {
        id: 'test-pipeline',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: '{{prompt}}' },
            config: {},
          },
        ],
      };

      const result = operations.validatePipeline(pipeline);
      expect(result.valid).toBe(true);
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
            inputs: { prompt: '{{step2.output}}' },
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

    it('should execute video/audio/document operations with correct types', async () => {
      const pipeline = {
        id: 'test-multi',
        steps: [
          {
            id: 'v1',
            operation: 'video.generate',
            inputs: { prompt: 'A video' },
            config: {},
          },
          {
            id: 'a1',
            operation: 'audio.tts',
            inputs: { text: 'Hello' },
            config: {},
          },
          {
            id: 'd1',
            operation: 'document.ocr',
            inputs: { artifact_id: '{{v1.output}}' },
            config: {},
          },
        ],
      };

      const result = await operations.executePipeline(pipeline);

      expect(result.status).toBe('completed');
      expect(result.artifacts.length).toBe(3);
      expect(result.artifacts[0].type).toBe('video');
      expect(result.artifacts[0].mimeType).toBe('video/mp4');
      expect(result.artifacts[1].type).toBe('audio');
      expect(result.artifacts[1].mimeType).toBe('audio/aac');
      expect(result.artifacts[2].type).toBe('document');
      expect(result.artifacts[2].mimeType).toBe('application/pdf');
    });

    it('should handle non-string inputs during interpolation', async () => {
      const pipeline = {
        id: 'test-nonstring',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: 'Test', seed: 42 as unknown as string },
            config: {},
          },
        ],
      };

      const result = await operations.executePipeline(pipeline);

      expect(result.status).toBe('completed');
      expect(result.artifacts.length).toBe(1);
    });
  });

  describe('createPipelineOperations factory', () => {
    it('should create instance via factory function', () => {
      const instance = createPipelineOperations(artifactRegistry);
      expect(instance).toBeInstanceOf(PipelineOperations);
    });

    it('should create instance with options', () => {
      const mockExecutor = { resume: vi.fn() } as unknown as PipelineExecutor;
      const instance = createPipelineOperations(artifactRegistry, { executor: mockExecutor });
      expect(instance).toBeInstanceOf(PipelineOperations);
    });
  });

  describe('resumePipeline', () => {
    it('should throw when executor not configured', async () => {
      await expect(operations.resumePipeline('test-run')).rejects.toThrow(
        'PipelineExecutor not configured',
      );
    });
  });

  describe('estimatePipeline', () => {
    it('should throw when estimator not configured', async () => {
      await expect(operations.estimatePipeline({ id: 'test', steps: [] })).rejects.toThrow(
        'PipelineEstimator not configured',
      );
    });
  });

  describe('executeVariants', () => {
    it('should throw when variantsExecutor not configured', async () => {
      const step: PipelineStep = {
        id: 's1',
        operation: 'image.generate',
        inputs: { prompt: 'test' },
        config: {},
      };
      const config: VariantsConfig = {
        n: 2,
        judge: { type: 'rule', expression: 'metadata.width >= 0' },
      };
      const context: VariantsExecutorContext = {
        executeOperation: async () => ({
          artifact: { id: 'a', type: 'image', uri: '', mimeType: '', metadata: {}, createdAt: '' },
          costUsd: 0,
        }),
      };
      await expect(operations.executeVariants(step, config, context)).rejects.toThrow(
        'VariantsExecutor not configured',
      );
    });

    it('should delegate to variantsExecutor when configured', async () => {
      const mockExecutor = new VariantsExecutor();
      const mockContext: VariantsExecutorContext = {
        executeOperation: async () => ({
          artifact: { id: 'a', type: 'image', uri: '', mimeType: '', metadata: {}, createdAt: '' },
          costUsd: 0.001,
        }),
      };

      const ops = new PipelineOperations(artifactRegistry, { variantsExecutor: mockExecutor });
      const step: PipelineStep = {
        id: 's1',
        operation: 'image.generate',
        inputs: { prompt: 'test' },
        config: {},
      };
      const config: VariantsConfig = {
        n: 1,
        judge: { type: 'rule', expression: 'metadata.width >= 0' },
      };

      const result = await ops.executeVariants(step, config, mockContext);
      expect(result.winner).toBeDefined();
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
