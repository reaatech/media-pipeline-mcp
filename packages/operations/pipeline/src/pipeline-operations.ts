import type { ArtifactRegistry } from '@reaatech/media-pipeline-mcp';
import type {
  Artifact,
  Pipeline,
  PipelineStatus,
  PipelineStep,
} from '@reaatech/media-pipeline-mcp';
import { v4 as uuidv4 } from 'uuid';

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: Omit<PipelineStep, 'id'>[];
}

export interface PipelineTemplateDefinition {
  templateId: string;
  variables?: Record<string, string>;
}

export class PipelineOperations {
  private templates: Map<string, PipelineTemplate> = new Map();

  constructor(private artifactRegistry: ArtifactRegistry) {
    this.registerDefaultTemplates();
  }

  private registerDefaultTemplates(): void {
    // Product Photo Pipeline
    this.templates.set('product-photo', {
      id: 'product-photo',
      name: 'Product Photo Pipeline',
      description: 'Generate product photo, upscale, remove background',
      steps: [
        {
          operation: 'image.generate',
          inputs: { prompt: '{{prompt}}' },
          config: { dimensions: '1024x1024' },
        },
        {
          operation: 'image.upscale',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { scale: '4x' },
        },
        {
          operation: 'image.remove_background',
          inputs: { artifact_id: '{{step2.output}}' },
          config: {},
        },
      ],
    });

    // Social Media Kit Pipeline
    this.templates.set('social-media-kit', {
      id: 'social-media-kit',
      name: 'Social Media Kit',
      description: 'Generate image and resize to multiple aspect ratios',
      steps: [
        {
          operation: 'image.generate',
          inputs: { prompt: '{{prompt}}' },
          config: { dimensions: '1024x1024' },
        },
        {
          operation: 'image.resize',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { dimensions: '1080x1080' },
        },
        {
          operation: 'image.resize',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { dimensions: '1080x1350' },
        },
        {
          operation: 'image.resize',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { dimensions: '1200x630' },
        },
      ],
    });

    // Document Intake Pipeline
    this.templates.set('document-intake', {
      id: 'document-intake',
      name: 'Document Intake Pipeline',
      description: 'OCR document, extract fields, summarize',
      steps: [
        {
          operation: 'document.ocr',
          inputs: { artifact_id: '{{artifact_id}}' },
          config: { format: 'plain-text' },
        },
        {
          operation: 'document.extract_fields',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { fields: [] },
        },
        {
          operation: 'document.summarize',
          inputs: { artifact_id: '{{step1.output}}' },
          config: { length: 'short', style: 'bullet-points' },
        },
      ],
    });

    // Video Thumbnail Pipeline
    this.templates.set('video-thumbnail', {
      id: 'video-thumbnail',
      name: 'Video Thumbnail Pipeline',
      description: 'Extract frames from video, describe, select best, upscale',
      steps: [
        {
          operation: 'video.extract_frames',
          inputs: { artifact_id: '{{artifact_id}}' },
          config: { interval: 30 },
        },
        {
          operation: 'image.describe',
          inputs: { artifact_id: '{{step1.output[0]}}' },
          config: { detail: 'brief' },
        },
        {
          operation: 'image.upscale',
          inputs: { artifact_id: '{{step1.output[0]}}' },
          config: { scale: '2x' },
        },
      ],
    });
  }

  listTemplates(): PipelineTemplate[] {
    return Array.from(this.templates.values());
  }

  getTemplate(templateId: string): PipelineTemplate | undefined {
    return this.templates.get(templateId);
  }

  validatePipeline(pipeline: Pipeline): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for duplicate step IDs
    const stepIds = new Set<string>();
    for (const step of pipeline.steps) {
      if (stepIds.has(step.id)) {
        errors.push(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);
    }

    // Check for circular references and validate input references
    const outputMap = new Map<string, string>();
    for (const step of pipeline.steps) {
      // Each step produces an output referenced by step ID
      outputMap.set(step.id, `${step.id}.output`);

      // Check all input references
      for (const [_inputKey, value] of Object.entries(step.inputs)) {
        if (typeof value === 'string') {
          // Check if it's a reference to another step
          const refMatch = value.match(/\{\{(.+?)\}\}/);
          if (refMatch) {
            const ref = refMatch[1];
            // Check if reference is to a previous step output
            if (ref.includes('.')) {
              const [refStepId] = ref.split('.');
              if (!outputMap.has(refStepId)) {
                errors.push(`Step ${step.id} references non-existent step: ${refStepId}`);
              }
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  interpolateVariables(
    template: PipelineTemplate,
    variables: Record<string, string>,
  ): PipelineStep[] {
    const steps: PipelineStep[] = [];

    for (let i = 0; i < template.steps.length; i++) {
      const stepTemplate = template.steps[i];
      const stepId = `step${i + 1}`;

      // Interpolate variables in inputs
      const interpolatedInputs: Record<string, string> = {};
      for (const [inputKey, inputValue] of Object.entries(stepTemplate.inputs)) {
        let interpolated: string = String(inputValue);
        // Replace {{variable}} with actual values
        for (const [varName, varValue] of Object.entries(variables)) {
          interpolated = interpolated.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
        }
        // Replace {{stepN.output}} references with actual step IDs
        interpolated = interpolated.replace(
          /\{\{step(\d+)\.output\}\}/g,
          (_match: string, stepNum: string) => {
            return `{{step${stepNum}.output}}`;
          },
        );
        interpolatedInputs[inputKey] = interpolated;
      }

      steps.push({
        id: stepId,
        operation: stepTemplate.operation,
        inputs: interpolatedInputs,
        config: stepTemplate.config,
      });
    }

    return steps;
  }

  async executePipeline(pipeline: Pipeline): Promise<{
    status: PipelineStatus;
    artifacts: Artifact[];
    cost_usd: number;
    duration_ms: number;
    error?: string;
  }> {
    const startTime = Date.now();
    const artifacts: Artifact[] = [];
    let totalCost = 0;

    // Validate pipeline first
    const validation = this.validatePipeline(pipeline);
    if (!validation.valid) {
      return {
        status: 'failed',
        artifacts: [],
        cost_usd: 0,
        duration_ms: Date.now() - startTime,
        error: validation.errors.join('; '),
      };
    }

    // Execute steps sequentially
    for (const step of pipeline.steps) {
      try {
        // Interpolate inputs from previous step outputs
        const interpolatedInputs = this.interpolateStepInputs(step, artifacts);

        // Create a simulated artifact for this step
        const artifactId = `artifact-${uuidv4()}`;
        const artifact: Artifact = {
          id: artifactId,
          type: this.inferArtifactType(step.operation),
          uri: `file:///artifacts/${artifactId}`,
          mimeType: this.inferMimeType(step.operation),
          metadata: {
            sourceStep: step.id,
            operation: step.operation,
            inputs: interpolatedInputs,
          },
        };

        this.artifactRegistry.register(artifact);
        artifacts.push(artifact);

        // Simulate cost
        totalCost += 0.01;
      } catch (error) {
        return {
          status: 'failed',
          artifacts,
          cost_usd: totalCost,
          duration_ms: Date.now() - startTime,
          error: (error as Error).message,
        };
      }
    }

    return {
      status: 'completed',
      artifacts,
      cost_usd: totalCost,
      duration_ms: Date.now() - startTime,
    };
  }

  private interpolateStepInputs(step: PipelineStep, artifacts: Artifact[]): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(step.inputs)) {
      if (typeof value === 'string') {
        let interpolated = value;

        // Handle {{stepN.output}} references
        const refMatch = value.match(/\{\{step(\d+)\.output\}\}/);
        if (refMatch) {
          const stepIndex = Number.parseInt(refMatch[1]) - 1;
          if (stepIndex >= 0 && stepIndex < artifacts.length) {
            interpolated = artifacts[stepIndex].id;
          }
        }

        result[key] = interpolated;
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  private inferArtifactType(operation: string): Artifact['type'] {
    if (operation.startsWith('image.')) return 'image';
    if (operation.startsWith('video.')) return 'video';
    if (operation.startsWith('audio.')) return 'audio';
    if (operation.startsWith('document.')) return 'document';
    return 'text';
  }

  private inferMimeType(operation: string): string {
    if (operation.startsWith('image.')) return 'image/png';
    if (operation.startsWith('video.')) return 'video/mp4';
    if (operation.startsWith('audio.')) return 'audio/aac';
    if (operation.startsWith('document.')) return 'application/pdf';
    return 'text/plain';
  }
}

export function createPipelineOperations(artifactRegistry: ArtifactRegistry): PipelineOperations {
  return new PipelineOperations(artifactRegistry);
}
