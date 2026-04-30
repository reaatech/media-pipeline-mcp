import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Artifact, Pipeline, PipelineDefinition } from '@reaatech/media-pipeline-mcp';
import {
  type PipelineEvent,
  PipelineExecutor,
  PipelineValidator,
  createQualityGateEvaluator,
} from '@reaatech/media-pipeline-mcp';
import { AuthMiddleware, RateLimiter } from '@reaatech/media-pipeline-mcp-security';
import type { AuthContext } from '@reaatech/media-pipeline-mcp-security';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { createStorage } from '@reaatech/media-pipeline-mcp-storage';
import type { ServerConfig } from './config.js';
import { CostTracker } from './cost-tracker.js';
import { createProviders } from './provider-factory.js';
import { ProviderRegistry } from './provider-registry.js';
import { toolRegistry } from './tool-registry.js';

export class MCPServer {
  private server: Server;
  private providerRegistry: ProviderRegistry;
  private costTracker: CostTracker;
  private storage: ArtifactStore;
  private executor: PipelineExecutor;
  private validator: PipelineValidator;
  private pipelines: Map<string, Pipeline> = new Map();
  private static readonly MAX_PIPELINE_HISTORY = 1000;
  private config: ServerConfig;
  private httpServer: http.Server | null = null;
  // Auth and rate limiter are initialized for future HTTP gateway integration
  // Currently they require transport-level header access not available in MCP protocol
  private authMiddleware?: AuthMiddleware;
  private rateLimiter?: RateLimiter;

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: 'media-pipeline-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.providerRegistry = new ProviderRegistry();
    this.costTracker = new CostTracker(config.budget);

    // Initialize storage
    this.storage = createStorage(config.storage);

    // Initialize auth middleware if enabled
    if (config.auth?.enabled) {
      const apiKeysMap = new Map();
      if (config.auth.apiKeys) {
        for (const keyData of config.auth.apiKeys) {
          apiKeysMap.set(keyData.key, { userId: keyData.userId, permissions: keyData.permissions });
        }
      }
      this.authMiddleware = new AuthMiddleware({
        jwtSecret: config.auth.jwtSecret,
        apiKeys: apiKeysMap,
        requireAuth: true,
      });
    }

    // Initialize rate limiter if enabled
    if (config.rateLimit?.enabled) {
      const operationLimits = new Map([
        [
          'image.generate',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 2 },
        ],
        [
          'video.generate',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 1 },
        ],
        [
          'audio.tts',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 5 },
        ],
      ]);
      this.rateLimiter = new RateLimiter({
        clientRequestsPerMinute: config.rateLimit.clientRequestsPerMinute,
        clientBurstSize: config.rateLimit.clientBurstSize,
        operationLimits,
      });
    }

    // Create providers from configuration
    const providers = createProviders(config.providers);

    // Register all providers
    for (const provider of providers) {
      this.providerRegistry.register(provider);
    }

    // Initialize executor
    this.executor = new PipelineExecutor({
      providers: this.providerRegistry.getAllProviders(),
      llmJudgeFn: (prompt, artifact) => this.evaluateWithLLM(prompt, artifact),
      customCheckFn: (artifact, gateConfig) => this.evaluateCustomGate(artifact, gateConfig),
      prepareInputs: (operation, inputs) => this.prepareProviderInputs(operation, inputs),
      persistArtifact: (params) => this.persistArtifact(params),
      onEvent: (event) => this.handlePipelineEvent(event),
      onCost: (record) => this.costTracker.record(record),
    });

    // Initialize validator
    this.validator = new PipelineValidator(this.providerRegistry);

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    // List tools - combine registry tools with pipeline/artifact tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const registryTools = toolRegistry.toMCPTools();

      // Add pipeline, artifact, provider tools that aren't in the registry
      const additionalTools = [
        // Pipeline operations
        {
          name: 'media.pipeline.define',
          description: 'Validate and preview a pipeline definition without executing it',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition with steps and quality gates',
                properties: {
                  id: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        operation: { type: 'string' },
                        inputs: { type: 'object', additionalProperties: { type: 'string' } },
                        config: { type: 'object' },
                        qualityGate: { type: 'object' },
                      },
                      required: ['id', 'operation', 'inputs'],
                    },
                  },
                },
                required: ['id', 'steps'],
              },
            },
            required: ['pipeline'],
          },
        },
        {
          name: 'media.pipeline.run',
          description: 'Execute a pipeline definition and return results',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition to execute',
                properties: {
                  id: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        operation: { type: 'string' },
                        inputs: { type: 'object', additionalProperties: { type: 'string' } },
                        config: { type: 'object' },
                        qualityGate: { type: 'object' },
                      },
                      required: ['id', 'operation', 'inputs'],
                    },
                  },
                },
                required: ['id', 'steps'],
              },
            },
            required: ['pipeline'],
          },
        },
        {
          name: 'media.pipeline.status',
          description: 'Check the status of a running or completed pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline_id: { type: 'string', description: 'ID of the pipeline' },
            },
            required: ['pipeline_id'],
          },
        },
        {
          name: 'media.pipeline.resume',
          description: 'Resume a gated or failed pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline_id: { type: 'string', description: 'ID of the pipeline' },
              action: {
                type: 'string',
                enum: ['retry', 'skip', 'abort'],
                description: 'Action to take',
              },
            },
            required: ['pipeline_id', 'action'],
          },
        },
        {
          name: 'media.pipeline.templates',
          description: 'List available pipeline templates',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        // Artifact operations
        {
          name: 'media.artifact.get',
          description: 'Retrieve an artifact by ID',
          inputSchema: {
            type: 'object',
            properties: {
              artifact_id: { type: 'string', description: 'ID of the artifact' },
            },
            required: ['artifact_id'],
          },
        },
        {
          name: 'media.artifact.list',
          description: 'List artifacts with optional prefix filter',
          inputSchema: {
            type: 'object',
            properties: {
              prefix: { type: 'string', description: 'Optional prefix filter' },
              limit: { type: 'number', description: 'Maximum number of results' },
            },
          },
        },
        {
          name: 'media.artifact.delete',
          description: 'Delete an artifact by ID',
          inputSchema: {
            type: 'object',
            properties: {
              artifact_id: { type: 'string', description: 'ID of the artifact to delete' },
            },
            required: ['artifact_id'],
          },
        },
        // Provider operations
        {
          name: 'media.providers.list',
          description: 'List configured providers and their health status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'media.providers.health',
          description: 'Check health of a specific provider',
          inputSchema: {
            type: 'object',
            properties: {
              provider_id: { type: 'string', description: 'ID of the provider' },
            },
            required: ['provider_id'],
          },
        },
      ];

      return {
        tools: [...registryTools, ...additionalTools],
      };
    });

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;

      const authContext = extra?.authInfo as AuthContext | undefined;
      if (
        this.authMiddleware &&
        (!authContext || !this.authMiddleware.canPerformOperation(authContext, name))
      ) {
        return {
          content: [
            { type: 'text', text: `Forbidden: insufficient permissions for tool '${name}'` },
          ],
          success: false,
          error: 'Forbidden',
        };
      }

      switch (name) {
        case 'media.pipeline.define':
          return this.handleDefinePipeline(args as { pipeline: PipelineDefinition });

        case 'media.pipeline.run':
          return this.handleRunPipeline(args as { pipeline: PipelineDefinition });

        case 'media.pipeline.status':
          return this.handlePipelineStatus(args as { pipeline_id: string });

        case 'media.pipeline.resume':
          return this.handleResumePipeline(
            args as { pipeline_id: string; action: 'retry' | 'skip' | 'abort' },
          );

        case 'media.pipeline.templates':
          return this.handleListTemplates();

        case 'media.artifact.get':
          return this.handleGetArtifact(args as { artifact_id: string });

        case 'media.artifact.list':
          return this.handleListArtifacts(args as { prefix?: string; limit?: number });

        case 'media.artifact.delete':
          return this.handleDeleteArtifact(args as { artifact_id: string });

        case 'media.providers.list':
          return this.handleListProviders();

        case 'media.providers.health':
          return this.handleCheckProviderHealth(args as { provider_id: string });

        case 'media.costs.summary':
          return this.handleCostSummary();

        // Image operations
        case 'image.generate':
          return this.handleOperation(args as Record<string, unknown>, 'image.generate');
        case 'image.generate.batch':
          return this.handleOperation(args as Record<string, unknown>, 'image.generate.batch');
        case 'image.upscale':
          return this.handleOperation(args as Record<string, unknown>, 'image.upscale');
        case 'image.remove_background':
          return this.handleOperation(args as Record<string, unknown>, 'image.remove_background');
        case 'image.inpaint':
          return this.handleOperation(args as Record<string, unknown>, 'image.inpaint');
        case 'image.describe':
          return this.handleOperation(args as Record<string, unknown>, 'image.describe');
        case 'image.resize':
          return this.handleOperation(args as Record<string, unknown>, 'image.resize');
        case 'image.crop':
          return this.handleOperation(args as Record<string, unknown>, 'image.crop');
        case 'image.composite':
          return this.handleOperation(args as Record<string, unknown>, 'image.composite');
        case 'image.image_to_image':
          return this.handleOperation(args as Record<string, unknown>, 'image.image_to_image');

        // Audio operations
        case 'audio.tts':
          return this.handleOperation(args as Record<string, unknown>, 'audio.tts');
        case 'audio.stt':
          return this.handleOperation(args as Record<string, unknown>, 'audio.stt');
        case 'audio.diarize':
          return this.handleOperation(args as Record<string, unknown>, 'audio.diarize');
        case 'audio.isolate':
          return this.handleOperation(args as Record<string, unknown>, 'audio.isolate');
        case 'audio.music':
          return this.handleOperation(args as Record<string, unknown>, 'audio.music');
        case 'audio.sound_effect':
          return this.handleOperation(args as Record<string, unknown>, 'audio.sound_effect');

        // Video operations
        case 'video.generate':
          return this.handleOperation(args as Record<string, unknown>, 'video.generate');
        case 'video.image_to_video':
          return this.handleOperation(args as Record<string, unknown>, 'video.image_to_video');
        case 'video.extract_frames':
          return this.handleOperation(args as Record<string, unknown>, 'video.extract_frames');
        case 'video.extract_audio':
          return this.handleOperation(args as Record<string, unknown>, 'video.extract_audio');

        // Document operations
        case 'document.ocr':
          return this.handleOperation(args as Record<string, unknown>, 'document.ocr');
        case 'document.extract_tables':
          return this.handleOperation(args as Record<string, unknown>, 'document.extract_tables');
        case 'document.extract_fields':
          return this.handleOperation(args as Record<string, unknown>, 'document.extract_fields');
        case 'document.summarize':
          return this.handleOperation(args as Record<string, unknown>, 'document.summarize');

        // Quality gate evaluation
        case 'quality_gate.evaluate':
          return this.handleQualityGateEvaluate(args as { artifact_id: string; gate: any });

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  private async handleOperation(args: Record<string, unknown>, operation: string): Promise<any> {
    const startTime = Date.now();

    // Validate input against tool schema
    const tool = toolRegistry.getToolForOperation(operation);
    if (tool) {
      const validation = toolRegistry.validateInput(tool.name, args);
      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: `Validation failed for operation '${operation}':\n${validation.errors.join('\n')}`,
            },
          ],
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }
    }

    // Find a provider for this operation
    const provider = this.providerRegistry.getProvider(operation);

    if (!provider) {
      return {
        content: [
          {
            type: 'text',
            text: `No provider available for operation: ${operation}`,
          },
        ],
        success: false,
        error: `No provider available for operation: ${operation}`,
      };
    }

    try {
      // Build inputs and config for provider
      const inputs = await this.prepareProviderInputs(operation, args);
      const config = (args.config as Record<string, unknown>) || {};

      // Estimate cost for budget check (use default if not available)
      const estimatedCost = 0.01; // Default estimate
      if (!this.costTracker.canAfford(estimatedCost)) {
        const budgetStatus = this.costTracker.getBudgetStatus();
        return {
          content: [
            {
              type: 'text',
              text: `Budget exceeded. Current spending: $${budgetStatus.dailySpent.toFixed(4)} daily, $${budgetStatus.monthlySpent.toFixed(4)} monthly. Please try again later or contact support.`,
            },
          ],
          success: false,
          error: 'Budget exceeded',
        };
      }

      // Execute the operation
      const result = await provider.execute(operation, inputs, config);

      const artifactId = `${operation.replace(/\./g, '-')}-${Date.now()}`;
      const persisted = await this.persistArtifact({
        artifactId,
        operation,
        data: result.data,
        artifact: result.artifact,
        pipelineId: 'direct',
        stepId: operation,
      });
      const uri = persisted.uri ?? result.artifact.uri;

      const duration = Date.now() - startTime;

      // Track cost
      this.costTracker.record({
        operation,
        provider: provider.name,
        cost_usd: result.cost_usd || 0,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `Operation '${operation}' completed successfully.\n` +
              `Provider: ${provider.name}\n` +
              `Artifact ID: ${artifactId}\n` +
              `URI: ${uri}\n` +
              `Cost: $${(result.cost_usd || 0).toFixed(4)}\n` +
              `Duration: ${(duration / 1000).toFixed(1)}s`,
          },
        ],
        success: true,
        artifact_id: artifactId,
        uri,
        provider: provider.name,
        cost_usd: result.cost_usd || 0,
        duration_ms: duration,
        metadata: result.artifact.metadata,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Operation '${operation}' failed: ${(error as Error).message}`,
          },
        ],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async handleDefinePipeline(args: { pipeline: PipelineDefinition }): Promise<any> {
    const result = this.validator.validate(args.pipeline);

    if (result.valid) {
      return {
        content: [
          {
            type: 'text',
            text: `Pipeline '${args.pipeline.id}' is valid.\nEstimated cost: $${result.estimated_cost_usd?.toFixed(4) || '0.0000'}\nEstimated duration: ${result.estimated_duration_ms ? (result.estimated_duration_ms / 1000).toFixed(1) : '0'}s\n${result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.join('\n')}` : ''}`,
          },
        ],
        success: true,
        estimated_cost_usd: result.estimated_cost_usd,
        estimated_duration_ms: result.estimated_duration_ms,
        warnings: result.warnings,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Pipeline '${args.pipeline.id}' validation failed:\n${result.errors.join('\n')}`,
        },
      ],
      success: false,
      error: result.errors.join(', '),
    };
  }

  private async handleRunPipeline(args: { pipeline: PipelineDefinition }): Promise<any> {
    const startTime = Date.now();

    // Validate first
    const validation = this.validator.validate(args.pipeline);
    if (!validation.valid) {
      return {
        content: [
          { type: 'text', text: `Pipeline validation failed: ${validation.errors.join('\n')}` },
        ],
        success: false,
        error: validation.errors.join(', '),
        status: 'validation_failed',
      };
    }

    // Execute
    const pipeline = await this.executor.execute(args.pipeline);
    this.pipelines.set(pipeline.id, pipeline);
    if (this.pipelines.size > MCPServer.MAX_PIPELINE_HISTORY) {
      const oldest = this.pipelines.keys().next().value;
      if (oldest) this.pipelines.delete(oldest);
    }

    const duration = Date.now() - startTime;
    const artifacts = Array.from(pipeline.artifacts.values()).map((a) => ({
      id: a.id,
      type: a.type,
      uri: a.uri,
      sourceStep: a.sourceStep,
    }));

    return {
      content: [
        {
          type: 'text',
          text:
            `Pipeline '${pipeline.id}' completed with status: ${pipeline.status}\n` +
            `Duration: ${(duration / 1000).toFixed(1)}s\n` +
            `Cost: $${this.costTracker.getPipelineCost(pipeline.id).toFixed(4)}\n` +
            `Artifacts: ${artifacts.length}`,
        },
      ],
      success: pipeline.status === 'completed',
      error:
        pipeline.status !== 'completed'
          ? `Pipeline ended with status: ${pipeline.status}`
          : undefined,
      pipeline_id: pipeline.id,
      status: pipeline.status,
      artifacts,
      cost_usd: this.costTracker.getPipelineCost(pipeline.id),
      duration_ms: duration,
      failedStep: pipeline.failedStep,
      gatedStep: pipeline.gatedStep,
    };
  }

  private handlePipelineStatus(args: { pipeline_id: string }): any {
    const pipeline = this.pipelines.get(args.pipeline_id);

    if (!pipeline) {
      return {
        content: [{ type: 'text', text: `Pipeline not found: ${args.pipeline_id}` }],
        success: false,
        error: `Pipeline not found: ${args.pipeline_id}`,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Pipeline '${pipeline.id}' status: ${pipeline.status}\n` +
            `Completed steps: ${pipeline.completedSteps.length}/${pipeline.steps.length}\n` +
            `Artifacts: ${pipeline.artifacts.size}`,
        },
      ],
      success: true,
      pipeline_id: pipeline.id,
      status: pipeline.status,
      completedSteps: pipeline.completedSteps,
      totalSteps: pipeline.steps.length,
      artifacts: Array.from(pipeline.artifacts.values()).map((a) => ({
        id: a.id,
        type: a.type,
        sourceStep: a.sourceStep,
      })),
    };
  }

  private async handleResumePipeline(args: {
    pipeline_id: string;
    action: 'retry' | 'skip' | 'abort';
  }): Promise<any> {
    const pipeline = this.pipelines.get(args.pipeline_id);

    if (!pipeline) {
      return {
        content: [{ type: 'text', text: `Pipeline not found: ${args.pipeline_id}` }],
        success: false,
        error: `Pipeline not found: ${args.pipeline_id}`,
      };
    }

    try {
      const updatedPipeline = await this.executor.resume(pipeline, args.action);
      this.pipelines.set(updatedPipeline.id, updatedPipeline);

      return {
        content: [
          {
            type: 'text',
            text: `Pipeline '${updatedPipeline.id}' resumed with action '${args.action}'. New status: ${updatedPipeline.status}`,
          },
        ],
        success: true,
        pipeline_id: updatedPipeline.id,
        status: updatedPipeline.status,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to resume pipeline: ${(error as Error).message}` }],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private handleListTemplates(): any {
    const templates = [
      {
        id: 'product-photo',
        name: 'Product Photo Pipeline',
        description: 'Generate product photo → upscale → remove background',
      },
      {
        id: 'social-media-kit',
        name: 'Social Media Kit',
        description: 'Generate image → resize to multiple aspect ratios',
      },
      {
        id: 'podcast-clip',
        name: 'Podcast Clip',
        description: 'Audio extract → STT → summarize → TTS voiceover',
      },
      {
        id: 'document-intake',
        name: 'Document Intake',
        description: 'OCR → extract fields → validate → summarize',
      },
      {
        id: 'video-thumbnail',
        name: 'Video Thumbnail',
        description: 'Extract frames → describe → select best → upscale',
      },
    ];

    return {
      content: [
        {
          type: 'text',
          text: `Available pipeline templates:\n\n${templates.map((t) => `- ${t.id}: ${t.name}\n  ${t.description}`).join('\n')}`,
        },
      ],
      success: true,
      templates,
    };
  }

  private async handleGetArtifact(args: { artifact_id: string }): Promise<any> {
    try {
      const result = await this.storage.get(args.artifact_id);
      return {
        content: [
          {
            type: 'text',
            text: `Artifact '${args.artifact_id}' retrieved successfully.\nType: ${result.meta.type}\nMIME: ${result.meta.mimeType}`,
          },
        ],
        success: true,
        artifact: result.meta,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Artifact not found: ${args.artifact_id}` }],
        success: false,
        error: `Artifact not found: ${args.artifact_id}`,
      };
    }
  }

  private async handleListArtifacts(args: { prefix?: string; limit?: number }): Promise<any> {
    const artifacts = await this.storage.list(args.prefix);
    const limited = args.limit ? artifacts.slice(0, args.limit) : artifacts;

    return {
      content: [
        {
          type: 'text',
          text: `Found ${limited.length} artifacts${args.prefix ? ` with prefix '${args.prefix}'` : ''}:\n\n${limited.map((a) => `- ${a.id} (${a.type}, ${a.mimeType})`).join('\n')}`,
        },
      ],
      success: true,
      artifacts: limited,
      total: artifacts.length,
    };
  }

  private async handleDeleteArtifact(args: { artifact_id: string }): Promise<any> {
    try {
      await this.storage.delete(args.artifact_id);
      return {
        content: [{ type: 'text', text: `Artifact '${args.artifact_id}' deleted successfully.` }],
        success: true,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Failed to delete artifact: ${args.artifact_id}` }],
        success: false,
        error: `Failed to delete artifact: ${args.artifact_id}`,
      };
    }
  }

  private handleListProviders(): any {
    const providers = this.providerRegistry.getHealthStatus();

    return {
      content: [
        {
          type: 'text',
          text: `Configured providers (${providers.length}):\n\n${providers
            .map(
              (p) =>
                `- ${p.name}: ${p.healthy ? '✓ Healthy' : '✗ Unhealthy'}\n  Operations: ${p.operations.join(', ')}\n${p.error ? `  Error: ${p.error}` : ''}`,
            )
            .join('\n')}`,
        },
      ],
      success: true,
      providers,
    };
  }

  private async handleCheckProviderHealth(args: { provider_id: string }): Promise<any> {
    try {
      const status = await this.providerRegistry.checkHealth(args.provider_id);
      return {
        content: [
          {
            type: 'text',
            text: `Provider '${args.provider_id}' health: ${status.healthy ? 'Healthy' : 'Unhealthy'}`,
          },
        ],
        success: true,
        status,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Provider not found: ${args.provider_id}` }],
        success: false,
        error: `Provider not found: ${args.provider_id}`,
      };
    }
  }

  private handleCostSummary(): any {
    const summary = this.costTracker.getSummary();

    return {
      content: [
        {
          type: 'text',
          text: `Cost Summary:\nTotal: $${summary.total_usd.toFixed(4)}\n\nBy Operation:\n${Array.from(
            summary.by_operation.entries(),
          )
            .map(([op, cost]) => `  ${op}: $${cost.toFixed(4)}`)
            .join('\n')}\n\nBy Provider:\n${Array.from(summary.by_provider.entries())
            .map(([provider, cost]) => `  ${provider}: $${cost.toFixed(4)}`)
            .join('\n')}`,
        },
      ],
      success: true,
      summary: {
        total_usd: summary.total_usd,
        by_operation: Object.fromEntries(summary.by_operation),
        by_provider: Object.fromEntries(summary.by_provider),
      },
    };
  }

  private async handleQualityGateEvaluate(args: { artifact_id: string; gate: any }): Promise<any> {
    try {
      const artifact = await this.buildArtifactForEvaluation(args.artifact_id);
      if (!artifact) {
        return {
          content: [{ type: 'text', text: `Artifact not found: ${args.artifact_id}` }],
          success: false,
          error: `Artifact not found: ${args.artifact_id}`,
        };
      }

      const evaluator = createQualityGateEvaluator(
        args.gate,
        (prompt, currentArtifact) => this.evaluateWithLLM(prompt, currentArtifact),
        (currentArtifact, gateConfig) => this.evaluateCustomGate(currentArtifact, gateConfig),
      );
      const result = await evaluator.evaluate(args.gate, artifact);

      return {
        content: [
          {
            type: 'text',
            text: `Quality gate evaluation result:\nPassed: ${result.passed}\nReasoning: ${result.reasoning}\n${result.score !== undefined ? `Score: ${result.score}\n` : ''}Action taken: ${result.action}`,
          },
        ],
        success: true,
        passed: result.passed,
        reasoning: result.reasoning,
        score: result.score,
        action_taken: result.action,
      };
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Quality gate evaluation failed: ${(error as Error).message}` },
        ],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private handlePipelineEvent(event: PipelineEvent): void {
    // Log pipeline events for debugging
    if (this.config.logLevel === 'debug') {
      console.debug(`[Pipeline Event] ${event.type}`, {
        pipelineId: event.pipelineId,
        stepId: event.stepId,
        timestamp: event.timestamp,
      });
    }
  }

  async start(): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await this.server.connect(transport);

    this.httpServer = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      const authResult = await this.authorizeRequest(req, res);
      if (!authResult.allowed) {
        return;
      }

      const parsedBody = await this.parseRequestBody(req, res);
      if (parsedBody === undefined && req.method === 'POST') {
        return;
      }

      const rateLimitAllowed = this.applyRateLimit(req, res, parsedBody);
      if (!rateLimitAllowed) {
        return;
      }

      try {
        await transport.handleRequest(req as any, res, parsedBody);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.listen(this.config.port, this.config.host, () => resolve());
      this.httpServer?.on('error', reject);
    });

    // Check provider health on startup
    await this.providerRegistry.checkAllHealth();

    console.log('Media Pipeline MCP Server started');
    console.log(`Server listening on ${this.config.host}:${this.config.port}`);
    console.log(`Storage: ${this.config.storage.type}`);
    console.log(
      `Providers: ${this.providerRegistry
        .getAllProviders()
        .map((p) => p.name)
        .join(', ')}`,
    );
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = null;
    }
    if (this.storage && typeof (this.storage as any).destroy === 'function') {
      (this.storage as any).destroy();
    }
    await this.server.close();
  }

  // Public accessors for middleware (used by HTTP gateway/proxy layers)
  getAuthMiddleware(): AuthMiddleware | undefined {
    return this.authMiddleware;
  }

  getRateLimiter(): RateLimiter | undefined {
    return this.rateLimiter;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  private async authorizeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<{ allowed: boolean }> {
    if (!this.authMiddleware) {
      return { allowed: true };
    }

    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    const context = await this.authMiddleware.authenticate(headers);

    if (!context.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return { allowed: false };
    }

    (req as http.IncomingMessage & { auth?: AuthContext }).auth = context;
    return { allowed: true };
  }

  private applyRateLimit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody?: unknown,
  ): boolean {
    if (!this.rateLimiter) {
      return true;
    }

    const clientId = this.getClientId(req);
    const operation = this.extractOperationName(parsedBody);
    const result = this.rateLimiter.checkLimit(clientId, operation);
    const headers = this.rateLimiter.getHeaders(result);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    if (!result.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return false;
    }

    return true;
  }

  private async parseRequestBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<unknown | undefined> {
    if (req.method !== 'POST') {
      return undefined;
    }

    const chunks: Buffer[] = [];

    try {
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
      return undefined;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (rawBody.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return undefined;
    }
  }

  private extractOperationName(parsedBody: unknown): string | undefined {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

    for (const message of messages) {
      if (
        message &&
        typeof message === 'object' &&
        (message as { method?: string }).method === 'tools/call'
      ) {
        const params = (message as { params?: { name?: string } }).params;
        if (params?.name) {
          return params.name;
        }
      }
    }

    return undefined;
  }

  private getClientId(req: http.IncomingMessage): string {
    const explicitClientId = req.headers['x-client-id'];
    if (typeof explicitClientId === 'string' && explicitClientId.trim().length > 0) {
      return explicitClientId;
    }

    return req.socket.remoteAddress || 'anonymous';
  }

  private async persistArtifact(params: {
    artifactId: string;
    operation: string;
    data?: Buffer | NodeJS.ReadableStream;
    artifact: {
      type: Artifact['type'];
      uri: string;
      mimeType: string;
      metadata: Record<string, unknown>;
      sourceStep?: string;
    };
    pipelineId: string;
    stepId: string;
  }): Promise<{ uri?: string }> {
    if (!params.data) {
      return { uri: params.artifact.uri };
    }

    const createdAt = new Date().toISOString();
    const meta = {
      id: params.artifactId,
      type: params.artifact.type,
      mimeType: params.artifact.mimeType,
      metadata: {
        ...params.artifact.metadata,
        operation: params.operation,
        pipelineId: params.pipelineId,
      },
      createdAt,
      sourceStep: params.artifact.sourceStep || params.stepId,
    };

    const uri = await this.storage.put(params.artifactId, params.data, meta);
    return { uri };
  }

  private async prepareProviderInputs(
    operation: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const prepared: Record<string, unknown> = { ...inputs };

    for (const [key, value] of Object.entries(inputs)) {
      if (!key.endsWith('artifact_id')) {
        continue;
      }
      if (typeof value !== 'string' || value.length === 0) {
        continue;
      }

      const artifactData = await this.storage.get(value);
      const buffer = await this.toBuffer(artifactData.data);
      this.attachArtifactPayload(prepared, key, value, buffer, artifactData.meta.mimeType);
    }

    // Provider-specific aliases used across the provider packages.
    if (typeof prepared.artifact_id === 'string' && prepared.artifact_data instanceof Buffer) {
      const artifactMime = typeof prepared.mime_type === 'string' ? prepared.mime_type : undefined;
      if (
        artifactMime?.startsWith('image/') ||
        operation.startsWith('document.') ||
        operation === 'image.describe'
      ) {
        prepared.image_data ??= prepared.artifact_data;
      }
      if (artifactMime?.startsWith('audio/') || operation.startsWith('audio.')) {
        prepared.audio_data ??= prepared.artifact_data;
      }
    }

    return prepared;
  }

  private attachArtifactPayload(
    target: Record<string, unknown>,
    inputKey: string,
    artifactId: string,
    data: Buffer,
    mimeType: string,
  ): void {
    const baseName =
      inputKey === 'artifact_id' ? 'artifact' : inputKey.replace(/_artifact_id$/, '');
    target[inputKey] = artifactId;
    target[`${baseName}_data`] = data;

    if (baseName === 'artifact') {
      target.artifact_data = data;
      target.mime_type ??= mimeType;
    }

    if (mimeType.startsWith('image/')) {
      target.image_data ??= data;
      target.mime_type ??= mimeType;
    } else if (mimeType.startsWith('audio/')) {
      target.audio_data ??= data;
      target.mime_type ??= mimeType;
    } else if (mimeType.startsWith('video/')) {
      target.video_data ??= data;
      target.mime_type ??= mimeType;
    } else {
      target.mime_type ??= mimeType;
    }
  }

  private async toBuffer(data: Buffer | NodeJS.ReadableStream | unknown): Promise<Buffer> {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (!data || typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
      throw new Error('Unsupported artifact payload type');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error('Unsupported stream chunk type');
      }
    }

    return Buffer.concat(chunks);
  }

  private async buildArtifactForEvaluation(artifactId: string): Promise<Artifact | null> {
    const registeredArtifact = this.executor.getRegistry().get(artifactId);
    if (registeredArtifact) {
      return registeredArtifact;
    }

    try {
      const stored = await this.storage.get(artifactId);
      return {
        id: artifactId,
        type: stored.meta.type,
        uri: await this.storage.getSignedUrl(artifactId),
        mimeType: stored.meta.mimeType,
        metadata: stored.meta.metadata || {},
        sourceStep: stored.meta.sourceStep,
        createdAt: stored.meta.createdAt,
      };
    } catch {
      return null;
    }
  }

  private async evaluateWithLLM(
    prompt: string,
    artifact: Artifact,
  ): Promise<{ pass: boolean; reasoning: string; score?: number }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const width = Number(artifact.metadata.width || 0);
      const height = Number(artifact.metadata.height || 0);
      const score = width > 0 && height > 0 ? 7 : 6;
      return {
        pass: score >= 7,
        reasoning: 'OpenAI API key not configured; used metadata-based fallback evaluation.',
        score,
      };
    }

    const model =
      typeof artifact.metadata.model === 'string' ? artifact.metadata.model : 'gpt-4o-mini';
    const artifactSummary = JSON.stringify({
      type: artifact.type,
      mimeType: artifact.mimeType,
      metadata: artifact.metadata,
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Evaluate the artifact and return strict JSON: {"pass":boolean,"reasoning":string,"score":number}.',
          },
          {
            role: 'user',
            content: `Prompt:\n${prompt}\n\nArtifact:\n${artifactSummary}`,
          },
        ],
        response_format: {
          type: 'json_object',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM-judge request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error('LLM-judge response did not include content');
    }

    const parsed = JSON.parse(raw) as { pass?: boolean; reasoning?: string; score?: number };
    return {
      pass: Boolean(parsed.pass),
      reasoning: parsed.reasoning || 'No reasoning provided',
      score: typeof parsed.score === 'number' ? parsed.score : undefined,
    };
  }

  private async evaluateCustomGate(
    artifact: Artifact,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const customCheckFn = config.customCheckFn;
    if (typeof customCheckFn === 'function') {
      return await Promise.resolve(customCheckFn(artifact, config));
    }

    if (typeof customCheckFn === 'string') {
      const compiled = new Function(
        'artifact',
        'context',
        `"use strict"; return (${customCheckFn})(artifact, context);`,
      ) as (
        artifactArg: Artifact,
        contextArg: Record<string, unknown>,
      ) => boolean | Promise<boolean>;
      return await Promise.resolve(compiled(artifact, config));
    }

    throw new Error('customCheckFn must be a function or string');
  }
}
