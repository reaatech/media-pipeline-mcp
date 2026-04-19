# Contributing to media-pipeline-mcp

Thank you for your interest in contributing! This guide covers how to add new provider adapters, operations, and pipeline templates.

---

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 8+
- Docker (for local testing)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/media-pipeline/media-pipeline-mcp.git
cd media-pipeline-mcp

# Install dependencies
pnpm install

# Start development server
pnpm dev

# Run tests
pnpm test
```

---

## Adding a New Provider Adapter

Provider adapters connect the pipeline engine to external media services (Stability AI, OpenAI, Replicate, etc.).

### Step 1: Create Provider Package

```bash
# Create new provider package
mkdir -p packages/providers/your-provider
cd packages/providers/your-provider

# Copy template structure
cp ../provider-core/package.json .
cp ../provider-core/tsconfig.json .
cp ../provider-core/vitest.config.ts .
```

### Step 2: Implement Provider Class

```typescript
// packages/providers/your-provider/src/your-provider.ts
import { MediaProvider, ProviderInput, ProviderOutput } from '@media-pipeline/provider-core';

export class YourProvider extends MediaProvider {
  readonly name = 'your-provider';
  readonly supportedOperations = [
    'image.generate',
    'image.upscale'
  ];

  constructor(private config: YourProviderConfig) {
    super();
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Implement health check
      return true;
    } catch {
      return false;
    }
  }

  async execute(operation: string, input: ProviderInput): Promise<ProviderOutput> {
    switch (operation) {
      case 'image.generate':
        return this.generateImage(input);
      case 'image.upscale':
        return this.upscaleImage(input);
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  private async generateImage(input: ProviderInput): Promise<ProviderOutput> {
    // Implement image generation
    const response = await fetch('https://api.your-provider.com/generate', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: input.prompt,
        dimensions: input.config.dimensions
      })
    });

    const result = await response.json();
    
    return {
      artifactType: 'image',
      data: result.image_url,
      metadata: {
        width: result.width,
        height: result.height,
        format: 'png'
      },
      cost_usd: result.cost
    };
  }

  private async upscaleImage(input: ProviderInput): Promise<ProviderOutput> {
    // Implement upscaling
  }
}
```

### Step 3: Write Tests

```typescript
// packages/providers/your-provider/src/your-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YourProvider } from './your-provider';

describe('YourProvider', () => {
  let provider: YourProvider;

  beforeEach(() => {
    provider = new YourProvider({ apiKey: 'test-key' });
  });

  it('should report healthy when API is reachable', async () => {
    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });

  it('should generate image from prompt', async () => {
    const result = await provider.execute('image.generate', {
      prompt: 'A test image',
      config: { dimensions: '1024x1024' }
    });

    expect(result.artifactType).toBe('image');
    expect(result.metadata.width).toBe(1024);
    expect(result.metadata.height).toBe(1024);
  });
});
```

### Step 4: Register Provider

Add to configuration:

```typescript
// media-pipeline-mcp.config.ts
import { YourProvider } from './packages/providers/your-provider';

export default {
  providers: {
    'your-provider': {
      instance: new YourProvider({
        apiKey: process.env.YOUR_PROVIDER_API_KEY
      }),
      operations: {
        'image.generate': 'your-provider',
        'image.upscale': 'your-provider'
      }
    }
  }
};
```

---

## Adding a New Operation

Operations are the atomic capabilities exposed as MCP tools.

### Step 1: Create Operation Package

```bash
mkdir -p packages/operations/your-operation
cd packages/operations/your-operation
```

### Step 2: Implement Operation

```typescript
// packages/operations/your-operation/src/your-operation.ts
import { Operation, OperationContext, Artifact } from '@media-pipeline/core';
import { z } from 'zod';

export const yourOperation: Operation = {
  name: 'your.operation',
  description: 'Description of what this operation does',
  
  inputSchema: z.object({
    artifact_id: z.string(),
    param1: z.string().optional(),
    param2: z.number().optional()
  }),

  outputSchema: z.object({
    artifact_id: z.string()
  }),

  async execute(input: z.infer<typeof this.inputSchema>, ctx: OperationContext): Promise<Artifact> {
    // Get input artifact
    const inputArtifact = await ctx.artifactStore.get(input.artifact_id);
    
    // Process the artifact
    const result = await processArtifact(inputArtifact, input.param1, input.param2);
    
    // Store output artifact
    const outputArtifact: Artifact = {
      id: ctx.generateArtifactId(),
      type: result.type,
      uri: await ctx.artifactStore.put(
        ctx.generateArtifactId(),
        result.data,
        result.metadata
      ),
      mimeType: result.mimeType,
      metadata: result.metadata,
      sourceStep: ctx.stepId
    };

    return outputArtifact;
  }
};
```

### Step 3: Create MCP Tool Registration

```typescript
// packages/operations/your-operation/src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { yourOperation } from './your-operation';

export function registerYourOperation(server: Server) {
  server.tool(
    'your.operation',
    'Description for MCP client',
    yourOperation.inputSchema.shape,
    async (params) => {
      const artifact = await yourOperation.execute(params, operationContext);
      return {
        content: [
          {
            type: 'text',
            text: `Created artifact: ${artifact.id}`
          },
          {
            type: 'resource',
            resource: {
              uri: artifact.uri,
              mimeType: artifact.mimeType
            }
          }
        ]
      };
    }
  );
}
```

### Step 4: Write Tests

```typescript
// packages/operations/your-operation/src/your-operation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { yourOperation } from './your-operation';

describe('your-operation', () => {
  it('should process artifact correctly', async () => {
    const mockContext = {
      artifactStore: {
        get: vi.fn().mockResolvedValue({ data: 'test', metadata: {} }),
        put: vi.fn().mockResolvedValue('uri')
      },
      generateArtifactId: vi.fn().mockReturnValue('artifact-123'),
      stepId: 'step-1'
    };

    const result = await yourOperation.execute(
      { artifact_id: 'input-123', param1: 'value' },
      mockContext
    );

    expect(result.id).toBe('artifact-123');
    expect(mockContext.artifactStore.put).toHaveBeenCalled();
  });
});
```

---

## Adding a Pipeline Template

Pipeline templates are pre-built workflows for common use cases.

### Step 1: Define Template

```typescript
// packages/operations/pipeline/src/templates/your-template.ts
import { PipelineDefinition } from '@media-pipeline/core';

export const yourTemplate: PipelineDefinition = {
  id: 'your-template',
  steps: [
    {
      id: 'step1',
      operation: 'image.generate',
      inputs: {
        prompt: '{{user_prompt}}'
      },
      config: {
        dimensions: '1024x1024',
        model: 'sd3'
      }
    },
    {
      id: 'step2',
      operation: 'image.upscale',
      inputs: {
        artifact_id: '{{step1.output}}'
      },
      config: {
        scale: '4x'
      }
    }
  ]
};
```

### Step 2: Register Template

```typescript
// packages/operations/pipeline/src/templates/index.ts
import { yourTemplate } from './your-template';

export const templates = [
  // ... existing templates
  yourTemplate
];
```

### Step 3: Add Tests

```typescript
// packages/operations/pipeline/src/templates/your-template.test.ts
import { describe, it, expect } from 'vitest';
import { yourTemplate } from './your-template';
import { executePipeline } from '@media-pipeline/core';

describe('your-template', () => {
  it('should execute successfully with mock providers', async () => {
    const result = await executePipeline(yourTemplate, {
      providers: [mockProvider]
    });

    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(2);
  });
});
```

---

## Provider Interface Compliance

All providers must implement this interface:

```typescript
interface MediaProvider {
  // Provider name (must be unique)
  readonly name: string;
  
  // List of operations this provider supports
  readonly supportedOperations: string[];
  
  // Health check - returns true if provider is operational
  healthCheck(): Promise<boolean>;
  
  // Execute an operation
  execute(operation: string, input: ProviderInput): Promise<ProviderOutput>;
}

interface ProviderInput {
  operation: string;
  params: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface ProviderOutput {
  data: Buffer | ReadableStream;
  mimeType: string;
  metadata: Record<string, unknown>;
  costUsd?: number;
  durationMs?: number;
}
```

---

## Code Style

- **Language:** TypeScript strict mode
- **Formatting:** Prettier (auto-formatted on commit)
- **Linting:** ESLint with custom config
- **Testing:** Vitest with ≥80% coverage
- **Commits:** Conventional Commits format

---

## Pull Request Process

1. Create a feature branch from `main`
2. Implement changes with tests
3. Ensure all tests pass: `pnpm test`
4. Ensure type checking passes: `pnpm typecheck`
5. Ensure linting passes: `pnpm lint`
6. Update documentation if needed
7. Submit PR with clear description
8. Address review feedback
9. Squash and merge

---

## Questions?

- Check existing issues and discussions
- Join our Discord community
- Read the ARCHITECTURE.md for system design details
