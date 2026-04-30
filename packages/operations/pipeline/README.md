# @reaatech/media-pipeline-mcp-pipeline

[![npm version](https://img.shields.io/npm/v/@reaatech/media-pipeline-mcp-pipeline.svg)](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-pipeline)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/reaatech/media-pipeline-mcp/ci.yml?branch=main&label=CI)](https://github.com/reaatech/media-pipeline-mcp/actions/workflows/ci.yml)

> **Status:** Pre-1.0 — APIs may change in minor versions. Pin to a specific version in production.

Pipeline operations package providing template management, variable interpolation, validation, and orchestration of multi-step media workflows.

## Installation

```bash
npm install @reaatech/media-pipeline-mcp-pipeline
# or
pnpm add @reaatech/media-pipeline-mcp-pipeline
```

## Quick Start

```typescript
import { createPipelineOperations } from "@reaatech/media-pipeline-mcp-pipeline";

const ops = createPipelineOperations();

// List available templates
const templates = ops.listTemplates();

// Instantiate a template with variables
const pipeline = ops.instantiateTemplate("product-photo", {
  prompt: "Professional product photo of a running shoe",
  dimensions: "1080x1080",
});

// Validate the pipeline
const result = ops.validate(pipeline);
console.log(result.valid); // true

// Execute the pipeline
const output = await ops.execute(pipeline);
console.log(output.status); // "completed"
output.artifacts.forEach((a) => console.log(a.id, a.type));
```

## Pre-Built Templates

| Template | Description | Steps |
|----------|-------------|-------|
| `product-photo` | Product photo pipeline | generate → upscale → remove_bg |
| `social-media-kit` | Multi-format social media images | generate → resize × 3 (square, story, banner) |
| `document-intake` | Document processing workflow | OCR → extract_fields → summarize |
| `video-thumbnail` | Video thumbnail generation | extract_frames → describe → upscale |

## API Reference

### `PipelineOperations`

```typescript
class PipelineOperations {
  listTemplates(): string[];
  getTemplate(name: string): PipelineTemplate | undefined;
  instantiateTemplate(name: string, variables: Record<string, string>): Pipeline;
  validate(pipeline: Pipeline): ValidationResult;
  execute(pipeline: Pipeline): Promise<PipelineResult>;
  interpolate(pipeline: Pipeline): Pipeline;
}
```

### `PipelineTemplate`

```typescript
interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  steps: PipelineTemplateStep[];
}

interface PipelineTemplateStep {
  id: string;
  operation: string;
  inputs: Record<string, string>;
  config: Record<string, unknown>;
  qualityGate?: QualityGate;
}
```

### Variable Interpolation

Templates support variable replacement using `{{variable_name}}` syntax:

```typescript
const template = ops.getTemplate("product-photo");
// Template step inputs may contain {{prompt}}, {{dimensions}}, etc.

const pipeline = ops.instantiateTemplate("product-photo", {
  prompt: "A red sports car on a track",
  dimensions: "1024x1024",
});
// Variables replaced inline in the pipeline definition
```

### Step Reference Interpolation

Runtime interpolation of `{{step_id.output}}` references:

```typescript
// Before execution:
//   inputs: { artifact_id: "{{generate.output}}" }

// After step "generate" completes:
//   inputs: { artifact_id: "artifact-abc123" }
```

### Validation

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

interface ValidationError {
  stepId: string;
  message: string;
}
```

Validation checks:
- Duplicate step IDs
- Circular references between steps
- Forward references (step referencing a later step)
- Missing step references

## Usage Patterns

### List and Select a Template

```typescript
const ops = createPipelineOperations();
const names = ops.listTemplates();
// ["product-photo", "social-media-kit", "document-intake", "video-thumbnail"]

const template = ops.getTemplate("product-photo");
console.log(template!.description); // "Product photo pipeline with upscale and background removal"
```

### Instantiate with User Variables

```typescript
const pipeline = ops.instantiateTemplate("social-media-kit", {
  prompt: "Modern logo for a SaaS startup",
});

console.log(pipeline.steps.length); // 4 (generate + 3 resize operations)
```

### Validate Before Execution

```typescript
const validation = ops.validate(pipeline);
if (!validation.valid) {
  console.error("Pipeline validation failed:");
  validation.errors.forEach((e) => console.error(`  ${e.stepId}: ${e.message}`));
  return;
}

await ops.execute(pipeline);
```

### Sequential Step Execution

Operations auto-infer artifact types and MIME types from the operation prefix:
- `image.*` → artifact type `"image"`, MIME `"image/png"`
- `audio.*` → artifact type `"audio"`, MIME `"audio/mpeg"`
- `video.*` → artifact type `"video"`, MIME `"video/mp4"`
- `document.*` → artifact type `"document"`, MIME `"text/plain"`

## Related Packages

- [`@reaatech/media-pipeline-mcp`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp) — Core pipeline execution engine
- [`@reaatech/media-pipeline-mcp-storage`](https://www.npmjs.com/package/@reaatech/media-pipeline-mcp-storage) — Artifact persistence

## License

[MIT](https://github.com/reaatech/media-pipeline-mcp/blob/main/LICENSE)
