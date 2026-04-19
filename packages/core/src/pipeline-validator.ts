import type { PipelineDefinition, ValidationResult } from './types/index.js';
import { PipelineDefinitionSchema } from './types/index.js';

export interface ProviderAvailability {
  isAvailable(operation: string): boolean;
  getEstimatedCost(operation: string, config: Record<string, unknown>): number;
  getEstimatedDuration(operation: string, config: Record<string, unknown>): number;
}

export class PipelineValidator {
  private providerAvailability: ProviderAvailability;

  constructor(providerAvailability: ProviderAvailability) {
    this.providerAvailability = providerAvailability;
  }

  validate(definition: PipelineDefinition): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Schema validation
    const schemaResult = PipelineDefinitionSchema.safeParse(definition);
    if (!schemaResult.success) {
      errors.push('Pipeline definition schema validation failed');
      for (const issue of schemaResult.error.issues) {
        errors.push(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      return { valid: false, errors, warnings };
    }

    // 2. Check for duplicate step IDs and path traversal characters
    const stepIds = new Set<string>();
    for (const step of definition.steps) {
      if (stepIds.has(step.id)) {
        errors.push(`Duplicate step ID: ${step.id}`);
      }
      // Validate step ID doesn't contain path traversal characters
      if (step.id.includes('..') || step.id.includes('/') || step.id.includes('\\')) {
        errors.push(`Invalid step ID '${step.id}': contains path traversal characters`);
      }
      stepIds.add(step.id);
    }

    // 3. Check for circular references and invalid artifact references
    const referenceErrors = this.validateReferences(definition);
    errors.push(...referenceErrors);

    // 4. Check provider availability
    const providerErrors = this.validateProviders(definition);
    errors.push(...providerErrors);

    // 5. Validate quality gate configurations
    const gateWarnings = this.validateQualityGates(definition);
    warnings.push(...gateWarnings);

    // 6. Estimate cost and duration
    let estimatedCost = 0;
    let estimatedDuration = 0;

    for (const step of definition.steps) {
      if (this.providerAvailability.isAvailable(step.operation)) {
        estimatedCost += this.providerAvailability.getEstimatedCost(step.operation, step.config);
        estimatedDuration += this.providerAvailability.getEstimatedDuration(
          step.operation,
          step.config
        );
      } else {
        warnings.push(`Provider not available for operation: ${step.operation}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      estimated_cost_usd: estimatedCost,
      estimated_duration_ms: estimatedDuration,
    };
  }

  private validateReferences(definition: PipelineDefinition): string[] {
    const errors: string[] = [];
    const definedStepIds = new Set(definition.steps.map((s) => s.id));
    const outputReferences = new Map<string, string>(); // stepId -> first occurrence

    for (const step of definition.steps) {
      for (const [paramName, inputValue] of Object.entries(step.inputs)) {
        // Check for {{step_id.output}} references
        const match = inputValue.match(/^\{\{(\w+)\.output\}\}$/);
        if (match) {
          const referencedStepId = match[1];

          if (!definedStepIds.has(referencedStepId)) {
            errors.push(
              `Step '${step.id}' references non-existent step '${referencedStepId}' in input '${paramName}'`
            );
            continue;
          }

          // Check for circular reference (referencing a step that comes after)
          const referencedIndex = definition.steps.findIndex((s) => s.id === referencedStepId);
          const currentIndex = definition.steps.findIndex((s) => s.id === step.id);

          if (referencedIndex >= currentIndex) {
            errors.push(
              `Step '${step.id}' references future step '${referencedStepId}' (circular/forward reference not allowed)`
            );
          }

          // Track first reference
          if (!outputReferences.has(referencedStepId)) {
            outputReferences.set(referencedStepId, step.id);
          }
        }
      }
    }

    return errors;
  }

  private validateProviders(definition: PipelineDefinition): string[] {
    const errors: string[] = [];

    for (const step of definition.steps) {
      if (!this.providerAvailability.isAvailable(step.operation)) {
        errors.push(`No provider available for operation '${step.operation}' in step '${step.id}'`);
      }
    }

    return errors;
  }

  private validateQualityGates(definition: PipelineDefinition): string[] {
    const warnings: string[] = [];

    for (const step of definition.steps) {
      if (step.qualityGate) {
        const gate = step.qualityGate;

        // Check for retry without maxRetries
        if (gate.action === 'retry' && gate.maxRetries === undefined) {
          warnings.push(
            `Step '${step.id}' has retry action but no maxRetries specified (defaulting to 1)`
          );
        }

        // Check for llm-judge without prompt
        if (gate.type === 'llm-judge' && !gate.config.prompt) {
          warnings.push(`Step '${step.id}' has llm-judge gate without a prompt`);
        }

        // Check for threshold without checks
        if (gate.type === 'threshold' && !Array.isArray(gate.config.checks)) {
          warnings.push(`Step '${step.id}' has threshold gate without checks configured`);
        }

        // Check for dimension-check without dimensions
        if (
          gate.type === 'dimension-check' &&
          (gate.config.expectedWidth === undefined || gate.config.expectedHeight === undefined)
        ) {
          warnings.push(`Step '${step.id}' has dimension-check gate without expected dimensions`);
        }
      }
    }

    return warnings;
  }
}
