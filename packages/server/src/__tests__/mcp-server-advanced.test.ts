import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { PipelineEvent } from '@reaatech/media-pipeline-mcp-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, ServerConfig } from '../config.js';
import { MCPServer } from '../mcp-server.js';

const listenMock = vi.fn((_: number, __: string, cb?: () => void) => cb?.());
const onMock = vi.fn();
const closeMock = vi.fn((cb?: (err?: Error) => void) => cb?.());
const setRequestHandlerMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  return {
    Server: class MockServer {
      setRequestHandler = setRequestHandlerMock;
      connect = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      /** F19: declared so the resource-list-changed wiring assertion can spy on it. */
      sendResourceListChanged = vi.fn().mockResolvedValue(undefined);
      notification = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('http', () => {
  return {
    default: {
      createServer: vi.fn(() => ({
        listen: listenMock,
        on: onMock,
        close: closeMock,
      })),
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  return {
    StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {
      handleRequest = vi.fn();
    },
  };
});

vi.mock('@reaatech/media-pipeline-mcp-fal', () => ({ FalProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-google', () => ({ GoogleProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-anthropic', () => ({ AnthropicProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-deepgram', () => ({ DeepgramProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-elevenlabs', () => ({ ElevenLabsProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-openai', () => ({ OpenAIProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-replicate', () => ({ ReplicateProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-stability', () => ({ StabilityProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-luma', () => ({ LumaProvider: class {} }));
vi.mock('@reaatech/media-pipeline-mcp-meshy', () => ({ MeshyProvider: class {} }));

// Mock core: keep MockProvider real, mock PipelineExecutor/PipelineValidator
const mockExecutorExecute = vi.fn();
const mockExecutorResume = vi.fn();
const mockRegistryGet = vi.fn();
const mockRegistryRegisterWithId = vi.fn().mockReturnValue({
  id: 'mock-id',
  type: 'image',
  uri: 'mock-uri',
  mimeType: 'image/png',
  metadata: { width: 1024, height: 1024 },
  sourceStep: 'step1',
});
const mockValidatorValidate = vi.fn();

vi.mock('@reaatech/media-pipeline-mcp-core', async () => {
  const actual = await vi.importActual<typeof import('@reaatech/media-pipeline-mcp-core')>(
    '@reaatech/media-pipeline-mcp-core',
  );

  return {
    ...actual,
    PipelineExecutor: class MockPipelineExecutor {
      execute = mockExecutorExecute;
      resume = mockExecutorResume;
      getRegistry = vi.fn().mockReturnValue({
        get: mockRegistryGet,
        registerWithId: mockRegistryRegisterWithId,
      });
      // F5: stand-in for the real estimator. The advanced test for
      // "warnings when some operations have no provider" expects a populated
      // warnings array with code='no-estimator'; the unit tests don't verify
      // estimate values precisely.
      estimate = vi
        .fn()
        .mockImplementation(async (def: { steps: Array<{ id: string; operation: string }> }) => ({
          totalUsdLow: 0,
          totalUsdHigh: 0.01 * def.steps.length,
          perStep: def.steps.map((s) => ({
            stepId: s.id,
            operation: s.operation,
            provider: 'unknown',
            modelId: 'default',
            usdLow: 0,
            usdHigh: 0.01,
            estimable: false,
            fallbackUsed: 'default-bound' as const,
          })),
          warnings: def.steps.map((s) => ({
            stepId: s.id,
            code: 'no-estimator' as const,
            message: `No provider available for operation '${s.operation}'`,
          })),
        }));
    },
    PipelineValidator: class MockPipelineValidator {
      validate = mockValidatorValidate;
    },
  };
});

const mockStoragePut = vi.fn().mockResolvedValue('stored-uri');
const mockStorageGet = vi.fn().mockResolvedValue({
  data: Buffer.from('image-data'),
  meta: {
    type: 'image',
    mimeType: 'image/png',
    metadata: { width: 1024 },
    sourceStep: 'step1',
    createdAt: '2026-01-01T00:00:00Z',
  },
});
const mockStorageGetSignedUrl = vi.fn().mockResolvedValue('signed-url');
const mockStorageDelete = vi.fn().mockResolvedValue(undefined);
const mockStorageList = vi.fn().mockResolvedValue([
  { id: 'art-1', type: 'image', mimeType: 'image/png' },
  { id: 'art-2', type: 'audio', mimeType: 'audio/mp3' },
]);

vi.mock('@reaatech/media-pipeline-mcp-storage', () => ({
  createStorage: () => ({
    put: mockStoragePut,
    get: mockStorageGet,
    getSignedUrl: mockStorageGetSignedUrl,
    delete: mockStorageDelete,
    list: mockStorageList,
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
}));

const mockSubtitleGenerate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    language: 'en',
    segments: [{ start: 0, end: 10, text: 'Hello' }],
    subtitleArtifactId: 'sub-1',
    burnedArtifactId: 'burned-1',
    totalCostUsd: 0.05,
  }),
);

vi.mock('@reaatech/media-pipeline-mcp-video-gen', () => ({
  createSubtitlePipeline: () => ({
    generate: mockSubtitleGenerate,
  }),
}));

const baseConfig: ServerConfig = {
  port: 18081,
  host: '0.0.0.0',
  logLevel: 'info',
  storage: {
    type: 'local',
    config: {
      basePath: './artifacts',
    },
  },
  providers: [
    {
      name: 'mock',
      operations: [
        'image.generate',
        'image.generate.batch',
        'image.upscale',
        'image.remove_background',
        'image.inpaint',
        'image.describe',
        'image.resize',
        'image.crop',
        'image.composite',
        'image.image_to_image',
        'audio.tts',
        'audio.stt',
        'audio.diarize',
        'audio.isolate',
        'audio.music',
        'audio.sound_effect',
        'video.generate',
        'video.image_to_video',
        'video.extract_frames',
        'video.extract_audio',
        'document.ocr',
        'document.extract_tables',
        'document.extract_fields',
        'document.summarize',
        'mesh.generate',
      ],
    },
  ],
};

function createServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return { ...baseConfig, ...overrides };
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: string };
}

interface TemplateInfo {
  id: string;
}

interface MCPServerPrivateAccess {
  initPromise: Promise<void>;
  pipelines: Map<string, Record<string, unknown>>;
  pipelineCancelControllers: Map<string, { abort: () => void }>;
  providerRegistry: Record<string, unknown>;
  artifactResourceHandler: { addResource: (...args: unknown[]) => Promise<void> };
  subscriptionManager: unknown;
  webhookDeliveryService: { deliverEvent: (...args: unknown[]) => unknown };
  storage: Record<string, unknown>;
  batchExecutor: {
    start: (...args: unknown[]) => Promise<unknown>;
    getStatus: (...args: unknown[]) => Promise<unknown>;
    retry: (...args: unknown[]) => Promise<unknown>;
    cancel: (...args: unknown[]) => Promise<unknown>;
  };
  idempotencyMiddleware: {
    store: {
      get: (key: string) => Promise<unknown>;
      set: (entry: unknown) => Promise<void>;
      delete: (key: string) => Promise<void>;
    };
  };
  server: Record<string, unknown>;
  streamingBridge: unknown;
  applyDefaultSafetyGate(p: Record<string, unknown>): Record<string, unknown>;
  applyRateLimit(req: unknown, res: unknown, body: unknown): boolean;
  authorizeRequest(req: unknown, res: unknown): Promise<Record<string, unknown>>;
  handlePipelineEvent(event: Record<string, unknown>): void;
  parseRequestBody(req: unknown, res: unknown): Promise<Record<string, unknown> | undefined>;
  toBuffer(data: unknown): Promise<Buffer>;
  persistArtifact(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  prepareProviderInputs(
    operation: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  evaluateCustomGate(
    artifact: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<boolean>;
  evaluateWithLLM(
    prompt: string,
    artifact: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  extractOperationName(req: unknown): string | undefined;
  getClientId(req: Record<string, unknown>): string;
  attachArtifactPayload(
    target: Record<string, unknown>,
    key: string,
    id: string,
    data: Buffer,
    mimeType: string,
  ): void;
  interpolateRowIntoPipeline(
    pipeline: Record<string, unknown>,
    row: Record<string, unknown>,
  ): Record<string, unknown>;
  interpolateString(template: string, vars: Record<string, unknown>): string;
}

// Handler results expose many dynamic fields (artifacts, summary, providers, etc.) that
// vary per tool — tests access them directly rather than via a discriminated union.
type CallHandler = (
  request: {
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
  },
  extra?: Record<string, unknown>,
) => Promise<Record<string, any>>;

type ListToolsHandler = () => Promise<{ tools: ToolInfo[] }>;

function getCallHandler(): CallHandler {
  return setRequestHandlerMock.mock.calls
    .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
    .at(-1)?.[1] as CallHandler;
}

function getListToolsHandler(): ListToolsHandler {
  return setRequestHandlerMock.mock.calls
    .filter((call: unknown[]) => call[0] === ListToolsRequestSchema)
    .at(-1)?.[1] as ListToolsHandler;
}

describe('MCPServer Advanced', () => {
  let server: MCPServer;

  beforeEach(() => {
    setRequestHandlerMock.mockClear();
    mockExecutorExecute.mockReset();
    mockExecutorResume.mockReset();
    mockValidatorValidate.mockReset();
    mockRegistryGet.mockReset();
    mockStorageGet.mockReset();
    mockStoragePut.mockReset();
    mockStorageDelete.mockClear();
    mockStorageList.mockClear();

    mockExecutorExecute.mockResolvedValue({
      id: 'pipeline-1',
      status: 'completed',
      steps: [{ id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
      completedSteps: ['step1'],
      artifacts: new Map([
        [
          'art-1',
          {
            id: 'art-1',
            type: 'image',
            uri: 'uri://art-1',
            sourceStep: 'step1',
            mimeType: 'image/png',
            metadata: {},
          },
        ],
      ]),
      failedStep: undefined,
      gatedStep: undefined,
    });

    mockValidatorValidate.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
      estimated_cost_usd: 0.01,
      estimated_duration_ms: 2000,
    });

    mockStorageGet.mockResolvedValue({
      data: Buffer.from('image-data'),
      meta: {
        type: 'image',
        mimeType: 'image/png',
        metadata: { width: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    });

    server = new MCPServer(baseConfig);
  });

  afterEach(async () => {
    mockSubtitleGenerate.mockReset();
    mockSubtitleGenerate.mockResolvedValue({
      language: 'en',
      segments: [{ start: 0, end: 10, text: 'Hello' }],
      subtitleArtifactId: 'sub-1',
      burnedArtifactId: 'burned-1',
      totalCostUsd: 0.05,
    });
    try {
      await server.stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Tool Registration (ListTools)', () => {
    it('should register pipeline, artifact, provider, cost, and quality_gate tools', async () => {
      const handler = getListToolsHandler();
      const result = await handler();
      const toolNames = result.tools.map((t) => t.name);

      expect(toolNames).toContain('media.pipeline.define');
      expect(toolNames).toContain('media.pipeline.run');
      expect(toolNames).toContain('media.pipeline.status');
      expect(toolNames).toContain('media.pipeline.resume');
      expect(toolNames).toContain('media.pipeline.cancel');
      expect(toolNames).toContain('media.pipeline.estimate');
      expect(toolNames).toContain('media.pipeline.subscribe');
      expect(toolNames).toContain('media.pipeline.templates');
      expect(toolNames).toContain('media.pipeline.batch');
      expect(toolNames).toContain('media.pipeline.batch.status');
      expect(toolNames).toContain('media.pipeline.batch.retry');
      expect(toolNames).toContain('media.pipeline.batch.cancel');
      expect(toolNames).toContain('media.artifact.get');
      expect(toolNames).toContain('media.artifact.list');
      expect(toolNames).toContain('media.artifact.delete');
      expect(toolNames).toContain('media.providers.list');
      expect(toolNames).toContain('media.providers.health');
      expect(toolNames).toContain('media.costs.summary');
      expect(toolNames).toContain('quality_gate.evaluate');
    });

    it('should include registry tools in the tool list', async () => {
      const handler = getListToolsHandler();
      const result = await handler();
      const toolNames = result.tools.map((t) => t.name);

      expect(toolNames).toContain('image.generate');
      expect(toolNames).toContain('audio.tts');
      expect(toolNames).toContain('video.generate');
      expect(toolNames).toContain('document.ocr');
    });

    it('should have proper schemas for all listed tools', async () => {
      const handler = getListToolsHandler();
      const result = await handler();

      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('handleDefinePipeline', () => {
    it('should return success for valid pipeline', async () => {
      mockValidatorValidate.mockReturnValue({
        valid: true,
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 2000,
        warnings: [],
        errors: [],
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'test-pipeline',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.estimated_cost_usd).toBe(0.05);
      expect(result.estimated_duration_ms).toBe(2000);
      expect(result.warnings).toEqual([]);
    });

    it('should return failure for invalid pipeline', async () => {
      mockValidatorValidate.mockReturnValue({
        valid: false,
        errors: ['Missing required field: prompt'],
        warnings: [],
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'invalid-pipeline',
                steps: [],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required field');
    });
  });

  describe('handleRunPipeline', () => {
    const completedPipeline = {
      id: 'run-1',
      status: 'completed',
      steps: [{ id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} }],
      completedSteps: ['step1'],
      artifacts: new Map([
        [
          'art-1',
          {
            id: 'art-1',
            type: 'image',
            uri: 'uri://art-1',
            sourceStep: 'step1',
            mimeType: 'image/png',
            metadata: {},
          },
        ],
      ]),
      failedStep: undefined,
      gatedStep: undefined,
    };

    it('should execute a pipeline successfully', async () => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockResolvedValue(completedPipeline);

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'test-run',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.pipeline_id).toBe('run-1');
      expect(result.status).toBe('completed');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].id).toBe('art-1');
      expect(result.cost_usd).toBeDefined();
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should return validation failure for invalid pipeline', async () => {
      mockValidatorValidate.mockReturnValue({
        valid: false,
        errors: ['No provider for operation: unknown.op'],
        warnings: [],
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'invalid-run',
                steps: [
                  { id: 'step1', operation: 'unknown.op', inputs: { prompt: 'test' }, config: {} },
                ],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('validation_failed');
      expect(result.error).toContain('No provider');
    });

    it('should handle pipeline execution error', async () => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockRejectedValue(new Error('Provider unavailable'));

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'failing-run',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Provider unavailable');
    });

    it('should cap pipeline history at MAX_PIPELINE_HISTORY', async () => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockResolvedValue(completedPipeline);

      const maxHistory = (MCPServer as unknown as { MAX_PIPELINE_HISTORY: number })
        .MAX_PIPELINE_HISTORY;
      const pipelinesMap = (server as unknown as MCPServerPrivateAccess).pipelines;
      for (let i = 0; i < maxHistory; i++) {
        pipelinesMap.set(`pipeline-${i}`, { id: `pipeline-${i}` });
      }

      const handler = getCallHandler();
      await handler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'new-pipeline',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      expect(pipelinesMap.has('pipeline-0')).toBe(false);
      expect(pipelinesMap.has('run-1')).toBe(true);
    });

    it('F16: applyDefaultSafetyGate appends an implicit gate when features.safetyGate=true', () => {
      // Direct test of the private helper. Avoids the full handler round-trip and
      // exercises exactly the default-on injection rule from plan §F16.
      const safeServer = new MCPServer(
        createServerConfig({
          features: {
            ...(baseConfig.features ?? {}),
            safetyGate: true,
          } as ServerConfig['features'],
        }),
      );
      const out = (
        safeServer as unknown as {
          applyDefaultSafetyGate: (p: Record<string, unknown>) => Record<string, unknown>;
        }
      ).applyDefaultSafetyGate({
        id: 'p',
        steps: [
          { id: 's1', operation: 'image.generate', inputs: { prompt: 'a' }, config: {} },
          { id: 's2', operation: 'image.describe', inputs: {}, config: {} },
          { id: 's3', operation: 'unrelated.op', inputs: {}, config: {} },
        ],
      });
      const steps = (
        out as { steps: Array<{ id: string; gates?: Array<{ type: string; action: string }> }> }
      ).steps;
      expect(steps[0]!.gates).toEqual([{ type: 'safety', action: 'fail' }]);
      expect(steps[1]!.gates).toEqual([{ type: 'safety', action: 'fail' }]);
      // Non-moderable operations don't get an implicit gate.
      expect(steps[2]!.gates).toBeUndefined();
    });

    it('F16: does not override a step that already declares its own safety gate', () => {
      const safeServer = new MCPServer(
        createServerConfig({
          features: {
            ...(baseConfig.features ?? {}),
            safetyGate: true,
          } as ServerConfig['features'],
        }),
      );
      const out = (
        safeServer as unknown as {
          applyDefaultSafetyGate: (p: Record<string, unknown>) => Record<string, unknown>;
        }
      ).applyDefaultSafetyGate({
        id: 'p',
        steps: [
          {
            id: 's1',
            operation: 'image.generate',
            inputs: { prompt: 'a' },
            config: {},
            gates: [{ type: 'safety', action: 'warn' }],
          },
        ],
      });
      const steps = (out as { steps: Array<{ gates: Array<{ type: string; action: string }> }> })
        .steps;
      expect(steps[0]!.gates).toEqual([{ type: 'safety', action: 'warn' }]);
    });

    it('F16: no injection when features.safetyGate=false (explicit opt-out)', () => {
      const offServer = new MCPServer(
        createServerConfig({
          features: {
            ...(baseConfig.features ?? {}),
            safetyGate: false,
          } as ServerConfig['features'],
        }),
      );
      const out = (
        offServer as unknown as {
          applyDefaultSafetyGate: (p: Record<string, unknown>) => Record<string, unknown>;
        }
      ).applyDefaultSafetyGate({
        id: 'p',
        steps: [{ id: 's1', operation: 'image.generate', inputs: { prompt: 'a' }, config: {} }],
      });
      const steps = (out as { steps: Array<{ gates?: unknown[] }> }).steps;
      expect(steps[0]!.gates).toBeUndefined();
    });
  });

  describe('handlePipelineStatus', () => {
    it('should return pipeline status when found', async () => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockResolvedValue({
        id: 'status-test-1',
        status: 'running',
        steps: [
          { id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} },
        ],
        completedSteps: [],
        artifacts: new Map([
          ['art-1', { id: 'art-1', type: 'image', uri: 'uri://art-1', sourceStep: 'step1' }],
        ]),
      });

      const runHandler = getCallHandler();
      await runHandler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'status-test',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.status',
            arguments: { pipeline_id: 'status-test-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.pipeline_id).toBe('status-test-1');
      expect(result.status).toBe('running');
      expect(result.completedSteps).toEqual([]);
      expect(result.totalSteps).toBe(1);
      expect(result.artifacts).toHaveLength(1);
    });

    it('should return not found for unknown pipeline', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.status',
            arguments: { pipeline_id: 'nonexistent' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleResumePipeline', () => {
    it('should resume a pipeline successfully', async () => {
      mockExecutorResume.mockResolvedValue({
        id: 'resumed-1',
        status: 'running',
        steps: [
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
        completedSteps: ['step1'],
        artifacts: new Map(),
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.resume',
            arguments: { runId: 'run-to-resume', fromStepId: 'step2' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.pipeline_id).toBe('resumed-1');
      expect(result.runId).toBe('run-to-resume');
      expect(result.status).toBe('running');
    });

    it('should return error when resume fails', async () => {
      mockExecutorResume.mockRejectedValue(new Error('Pipeline state not found'));

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.resume',
            arguments: { runId: 'nonexistent' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pipeline state not found');
    });
  });

  describe('handleCancelPipeline', () => {
    beforeEach(() => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockResolvedValue({
        id: 'running-pipeline',
        status: 'running',
        steps: [
          { id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} },
        ],
        completedSteps: [],
        artifacts: new Map(),
      });
    });

    it('should cancel a running pipeline', async () => {
      const runHandler = getCallHandler();
      await runHandler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'cancel-me',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.cancel',
            arguments: { pipeline_id: 'running-pipeline' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.pipeline_id).toBe('running-pipeline');
      expect(result.status).toBe('cancelled');
    });

    it('should return error for non-existent pipeline', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.cancel',
            arguments: { pipeline_id: 'nonexistent' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when pipeline is not running', async () => {
      mockValidatorValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
      mockExecutorExecute.mockResolvedValue({
        id: 'completed-pipeline',
        status: 'completed',
        steps: [],
        completedSteps: ['step1'],
        artifacts: new Map(),
      });

      const runHandler = getCallHandler();
      await runHandler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'already-done',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.cancel',
            arguments: { pipeline_id: 'completed-pipeline' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
      expect(result.status).toBe('completed');
    });
  });

  describe('handleListTemplates', () => {
    it('should return pipeline templates', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.templates',
            arguments: {},
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.templates).toBeDefined();
      const templates = result.templates as TemplateInfo[];
      expect(templates.length).toBeGreaterThan(0);
      expect(templates.find((t) => t.id === 'product-photo')).toBeDefined();
      expect(templates.find((t) => t.id === 'social-media-kit')).toBeDefined();
      expect(templates.find((t) => t.id === 'podcast-clip')).toBeDefined();
      expect(templates.find((t) => t.id === 'document-intake')).toBeDefined();
      expect(templates.find((t) => t.id === 'video-thumbnail')).toBeDefined();
    });
  });

  describe('Artifact tools', () => {
    describe('handleGetArtifact', () => {
      it('should return artifact when found', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.get',
              arguments: { artifact_id: 'art-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.artifact).toBeDefined();
        expect(result.artifact.type).toBe('image');
      });

      it('should return error for missing artifact', async () => {
        mockStorageGet.mockRejectedValue(new Error('Not found'));

        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.get',
              arguments: { artifact_id: 'nonexistent' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });

    describe('handleListArtifacts', () => {
      it('should list all artifacts', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.list',
              arguments: {},
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.artifacts).toHaveLength(2);
        expect(result.total).toBe(2);
      });

      it('should list artifacts with prefix filter', async () => {
        mockStorageList.mockResolvedValue([{ id: 'art-1', type: 'image', mimeType: 'image/png' }]);

        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.list',
              arguments: { prefix: 'art-', limit: 1 },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.artifacts).toHaveLength(1);
        expect(mockStorageList).toHaveBeenCalledWith('art-');
      });
    });

    describe('handleDeleteArtifact', () => {
      it('should delete an artifact successfully', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.delete',
              arguments: { artifact_id: 'art-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(mockStorageDelete).toHaveBeenCalledWith('art-1');
      });

      it('should return error when delete fails', async () => {
        mockStorageDelete.mockRejectedValue(new Error('Access denied'));

        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.artifact.delete',
              arguments: { artifact_id: 'art-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to delete');
      });
    });
  });

  describe('Provider tools', () => {
    describe('handleListProviders', () => {
      it('should list configured providers with health status', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.providers.list',
              arguments: {},
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.providers).toBeDefined();
        expect(result.providers.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('handleCheckProviderHealth', () => {
      it('should check health of a specific provider', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.providers.health',
              arguments: { provider_id: 'mock' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.status).toBeDefined();
      });

      it('should return error for unknown provider', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.providers.health',
              arguments: { provider_id: 'nonexistent' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });
  });

  describe('handleCostSummary', () => {
    it('should return cost summary', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.costs.summary',
            arguments: {},
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary.total_usd).toBe('number');
      expect(result.summary.by_operation).toBeDefined();
      expect(result.summary.by_provider).toBeDefined();
    });
  });

  describe('handleQualityGateEvaluate', () => {
    it('should evaluate a quality gate successfully when artifact is in registry', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-for-gate',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-for-gate',
              gate: {
                type: 'dimension-check',
                config: { expectedWidth: 1024, expectedHeight: 1024 },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('should return error for missing artifact', async () => {
      mockRegistryGet.mockReturnValue(undefined);
      mockStorageGet.mockRejectedValue(new Error('Not found'));

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'nonexistent',
              gate: {
                type: 'dimension-check',
                config: { expectedWidth: 1024, expectedHeight: 1024 },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle evaluation error for unknown gate type', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-err',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-err',
              gate: {
                type: 'nonexistent-gate-type',
                config: {},
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('handleOperation', () => {
    it('should execute an operation successfully', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.generate',
            arguments: { prompt: 'A beautiful sunset' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.artifact_id).toBeDefined();
      expect(result.uri).toBeDefined();
      expect(result.cost_usd).toBeDefined();
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should return validation error for missing required fields', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.upscale',
            arguments: {},
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
    });

    it('should propagate provider execution errors', async () => {
      const handler = getCallHandler();
      // image.upscale requires artifact_id and scale - we get validation error
      // Test with a valid operation but make provider throw after validation
      const result = await handler(
        {
          params: {
            name: 'image.upscale',
            arguments: { artifact_id: 'art-1', scale: '2x' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'completely.unknown.tool',
            arguments: {},
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('should handle missing arguments gracefully', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.generate',
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Validation failed');
    });
  });

  describe('Batch operations', () => {
    describe('handleBatchStart', () => {
      it('should start a batch pipeline', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.start = vi
          .fn()
          .mockResolvedValue({
            batchId: 'batch-1',
            status: 'running',
          });

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch',
              arguments: {
                pipeline: { id: 'batch-pipeline', steps: [] },
                source: { type: 'inline', rows: [{ prompt: 'test' }] },
              },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.batchId).toBe('batch-1');

        await batchServer.stop();
      });

      it('should return disabled when batch feature is off', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch',
              arguments: {
                pipeline: { id: 'batch-pipeline', steps: [] },
                source: { type: 'inline', rows: [{ prompt: 'test' }] },
              },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('handleBatchStatus', () => {
      it('should return batch status', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.getStatus = vi
          .fn()
          .mockResolvedValue({
            batchId: 'batch-1',
            status: 'completed',
            totalRows: 10,
            completed: 10,
            failed: 0,
            inFlight: 0,
            costUsd: 0.05,
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:01:00Z',
          });

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.status',
              arguments: { batchId: 'batch-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.batchId).toBe('batch-1');
        expect(result.status).toBe('completed');
        expect(result.totalRows).toBe(10);

        await batchServer.stop();
      });

      it('should return not found for missing batch', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.getStatus = vi
          .fn()
          .mockResolvedValue(null);

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.status',
              arguments: { batchId: 'nonexistent' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');

        await batchServer.stop();
      });

      it('should return disabled when batch feature is off', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.status',
              arguments: { batchId: 'batch-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('handleBatchRetry', () => {
      it('should retry a batch', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.retry = vi
          .fn()
          .mockResolvedValue({
            batchId: 'batch-retry-1',
            status: 'running',
          });

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.retry',
              arguments: { batchId: 'batch-retry-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.batchId).toBe('batch-retry-1');

        await batchServer.stop();
      });

      it('should return disabled when batch feature is off', async () => {
        const handler = getCallHandler();
        const result = await handler({
          params: {
            name: 'media.pipeline.batch.retry',
            arguments: { batchId: 'batch-1' },
          },
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('handleBatchCancel', () => {
      it('should cancel a batch', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.cancel = vi
          .fn()
          .mockResolvedValue(true);

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.cancel',
              arguments: { batchId: 'batch-cancel-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(true);
        expect(result.batchId).toBe('batch-cancel-1');
        expect(result.status).toBe('cancelled');

        await batchServer.stop();
      });

      it('should return error when batch not found', async () => {
        const config = createServerConfig({
          features: {
            idempotency: false,
            contentCache: false,
            resumablePipelines: false,
            budgetCaps: false,
            dryRun: false,
            streaming: false,
            webhooks: false,
            routing: false,
            variants: false,
            subtitles: false,
            runContext: false,
            batch: true,
            safetyGate: false,
            provenance: false,
            multiTenant: false,
            mcpResources: false,
            sttStream: false,
          },
        });
        const batchServer = new MCPServer(config);
        (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.cancel = vi
          .fn()
          .mockResolvedValue(false);

        const handler = setRequestHandlerMock.mock.calls
          .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
          .at(-1)?.[1];

        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.cancel',
              arguments: { batchId: 'nonexistent' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');

        await batchServer.stop();
      });

      it('should return disabled when batch feature is off', async () => {
        const handler = getCallHandler();
        const result = await handler(
          {
            params: {
              name: 'media.pipeline.batch.cancel',
              arguments: { batchId: 'batch-1' },
            },
          },
          {},
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });
  });

  describe('handleSubtitle', () => {
    it('should generate subtitles successfully', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.subtitle',
            arguments: {
              artifactId: 'video-1',
              language: 'en',
              format: 'srt',
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.subtitleArtifactId).toBe('sub-1');
      expect(result.burnedArtifactId).toBe('burned-1');
      expect(result.language).toBe('en');
      expect(result.segments).toBeGreaterThan(0);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('handleTranscribeStream edge cases', () => {
    it('should handle url source type', async () => {
      const originalFetch = globalThis.fetch;
      const mockArrayBuffer = new ArrayBuffer(8);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockArrayBuffer),
      }) as unknown as typeof globalThis.fetch;

      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: true,
        },
      });
      const sttServer = new MCPServer(config);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: { kind: 'url', url: 'https://example.com/audio.mp3' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.transcript).toBeDefined();

      globalThis.fetch = originalFetch;
      await sttServer.stop();
    });

    it('should handle unsupported source kind', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: true,
        },
      });
      const sttServer = new MCPServer(config);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: { kind: 'unknown-protocol' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported source kind');

      await sttServer.stop();
    });

    it('should handle missing audioData for inline-sample', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: true,
        },
      });
      const sttServer = new MCPServer(config);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: { kind: 'inline' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing inline audio payload');

      await sttServer.stop();
    });

    it('should handle url fetch failure', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as unknown as typeof globalThis.fetch;

      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: true,
        },
      });
      const sttServer = new MCPServer(config);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: { kind: 'url', url: 'https://example.com/missing.mp3' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to fetch audio');

      globalThis.fetch = originalFetch;
      await sttServer.stop();
    });

    it('should handle missing url for url source', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: true,
        },
      });
      const sttServer = new MCPServer(config);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: { kind: 'url' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing url');

      await sttServer.stop();
    });
  });

  describe('Authorization enforcement', () => {
    it('should allow authorized operations', async () => {
      const securedServer = new MCPServer({
        ...baseConfig,
        auth: {
          enabled: true,
          apiKeys: [
            {
              key: 'admin-key',
              userId: 'admin-1',
              permissions: [
                'pipeline:run',
                'artifact:read',
                'artifact:write',
                'cost:read',
                'provider:read',
              ],
            },
          ],
        },
      });

      const securedCallHandler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await securedCallHandler(
        {
          params: {
            name: 'media.costs.summary',
            arguments: {},
          },
        },
        {
          authInfo: {
            authenticated: true,
            permissions: ['cost:read'],
          },
        },
      );

      expect(result.success).toBe(true);

      await securedServer.stop();
    });

    it('should reject tools without auth context when auth is enabled', async () => {
      const securedServer = new MCPServer({
        ...baseConfig,
        auth: {
          enabled: true,
          apiKeys: [
            {
              key: 'admin-key',
              userId: 'admin-1',
              permissions: ['admin'],
            },
          ],
        },
      });

      const securedCallHandler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await securedCallHandler(
        {
          params: {
            name: 'media.costs.summary',
            arguments: {},
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Forbidden');

      await securedServer.stop();
    });
  });

  describe('Media operations dispatch', () => {
    it('should dispatch image.generate.batch', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.generate.batch',
            arguments: { prompts: ['test1', 'test2'] },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.upscale', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.upscale',
            arguments: { artifact_id: 'art-1', scale: '2x' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.remove_background', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.remove_background',
            arguments: { artifact_id: 'art-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.inpaint', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.inpaint',
            arguments: { artifact_id: 'art-1', prompt: 'fix it' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.describe', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.describe',
            arguments: { artifact_id: 'art-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.resize', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.resize',
            arguments: { artifact_id: 'art-1', dimensions: '800x600' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.crop', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.crop',
            arguments: { artifact_id: 'art-1', x: 0, y: 0, width: 100, height: 100 },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.composite', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.composite',
            arguments: {
              base_artifact_id: 'art-1',
              overlay_artifact_id: 'art-2',
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch image.image_to_image', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'image.image_to_image',
            arguments: { artifact_id: 'art-1', prompt: 'make it night' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.tts', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.tts',
            arguments: { text: 'Hello world' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.stt', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.stt',
            arguments: { artifact_id: 'audio-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.diarize', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.diarize',
            arguments: { artifact_id: 'audio-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.isolate', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.isolate',
            arguments: { artifact_id: 'audio-1', target: 'vocals' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.music', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.music',
            arguments: { prompt: 'upbeat pop' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch audio.sound_effect', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'audio.sound_effect',
            arguments: { prompt: 'thunder' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch video.generate', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.generate',
            arguments: { prompt: 'A test video' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch video.image_to_video', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.image_to_video',
            arguments: { artifact_id: 'art-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch video.extract_frames', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.extract_frames',
            arguments: { artifact_id: 'art-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch video.extract_audio', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.extract_audio',
            arguments: { artifact_id: 'art-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch document.ocr', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'document.ocr',
            arguments: { artifact_id: 'doc-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch document.extract_tables', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'document.extract_tables',
            arguments: { artifact_id: 'doc-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch document.extract_fields', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'document.extract_fields',
            arguments: { artifact_id: 'doc-1', field_schema: { name: 'string' } },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch document.summarize', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'document.summarize',
            arguments: { artifact_id: 'doc-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should dispatch mesh.generate', async () => {
      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'mesh.generate',
            arguments: { prompt: 'A 3D model of a chair' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Budget exceeded in handleOperation', () => {
    it('should return budget exceeded error when over daily limit', async () => {
      const config = createServerConfig({
        budget: { dailyLimit: 0.005, alertThreshold: 0.9 },
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: true,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const budgetServer = new MCPServer(config);
      await (budgetServer as unknown as MCPServerPrivateAccess).initPromise;

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: { name: 'image.generate', arguments: { prompt: 'test' } },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Budget exceeded');
      await budgetServer.stop();
    });
  });

  describe('handleOperation provider execution error', () => {
    it('should handle provider execution failure', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const opServer = new MCPServer(config);
      await (opServer as unknown as MCPServerPrivateAccess).initPromise;

      const mockProvider = {
        name: 'mock',
        supportedOperations: ['image.generate'],
        execute: vi.fn().mockRejectedValue(new Error('Provider execution failed')),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
      };
      (opServer as unknown as MCPServerPrivateAccess).providerRegistry.getProvider = vi
        .fn()
        .mockReturnValue(mockProvider);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: { name: 'image.generate', arguments: { prompt: 'test' } },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Provider execution failed');
      await opServer.stop();
    });
  });

  describe('Feature flags: streaming bridge', () => {
    it('should initialize streaming bridge and subscribe on pipeline run with progressToken', async () => {
      const mockEventBus = { subscribe: vi.fn().mockReturnValue(vi.fn()), publish: vi.fn() };
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: true,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
        eventBus: mockEventBus as unknown as EventBus<PipelineEvent>,
      });
      const streamServer = new MCPServer(config);
      await (streamServer as unknown as MCPServerPrivateAccess).initPromise;
      expect((streamServer as unknown as MCPServerPrivateAccess).streamingBridge).toBeDefined();

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.run',
            arguments: {
              pipeline: {
                id: 'stream-test',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
              _meta: { progressToken: 'token-123' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.pipeline_id).toBeDefined();
      await streamServer.stop();
    });
  });

  describe('Feature flags: webhooks', () => {
    it('should handle pipeline subscribe successfully', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: true,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const webhookServer = new MCPServer(config);
      await (webhookServer as unknown as MCPServerPrivateAccess).initPromise;
      expect(
        (webhookServer as unknown as MCPServerPrivateAccess).subscriptionManager,
      ).toBeDefined();
      expect(
        (webhookServer as unknown as MCPServerPrivateAccess).webhookDeliveryService,
      ).toBeDefined();

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.subscribe',
            arguments: {
              pipeline_id: 'pipeline-event-test',
              url: 'https://example.com/webhook',
              events: ['pipeline:complete', 'step:complete'],
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.subscription_id).toBeDefined();
      await webhookServer.stop();
    });
  });

  describe('Feature flags: mcpResources', () => {
    it('should register MCP resource handlers when feature enabled', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: true,
          sttStream: false,
        },
      });
      const resourceServer = new MCPServer(config);
      await (resourceServer as unknown as MCPServerPrivateAccess).initPromise;
      expect(
        (resourceServer as unknown as MCPServerPrivateAccess).artifactResourceHandler,
      ).toBeDefined();

      await resourceServer.stop();
    });

    it('F19: wires the resource handler onUpdate to MCP sendResourceListChanged', async () => {
      // Plan §F19: "every step-completed event with new artifactIds emits a
      // notifications/resources/list_changed". The wiring lives in MCPServer's
      // construction path — when artifactResourceHandler.addResource() fires onUpdate,
      // the server's sendResourceListChanged() must be invoked.
      //
      // We replace the SDK method with a vi.fn() directly (vi.spyOn can't see
      // prototype methods that aren't enumerable on the instance), then trigger
      // addResource and assert it fires.
      const config = createServerConfig({
        features: {
          ...(baseConfig.features ?? {}),
          mcpResources: true,
        } as ServerConfig['features'],
      });
      const wiringServer = new MCPServer(config);
      await (wiringServer as unknown as MCPServerPrivateAccess).initPromise;

      const handler = (wiringServer as unknown as MCPServerPrivateAccess).artifactResourceHandler;
      expect(handler).toBeDefined();

      const innerServer = (wiringServer as unknown as MCPServerPrivateAccess).server as Record<
        string,
        unknown
      >;
      // Sanity: the SDK method exists on the Server instance (prototype-bound).
      expect(typeof (innerServer.sendResourceListChanged as () => Promise<void>)).toBe('function');

      const sendSpy = vi.fn(async () => undefined);
      innerServer.sendResourceListChanged = sendSpy;

      const mockStorage = (wiringServer as unknown as MCPServerPrivateAccess).storage;
      mockStorage.get = vi
        .fn()
        .mockResolvedValue({ data: Buffer.from('x'), meta: { mimeType: 'image/png' } });

      await handler.addResource('art-1', 'run-1', 'step-1', 'mock', 'm');

      expect(sendSpy).toHaveBeenCalledTimes(1);

      await wiringServer.stop();
    });
  });

  describe('handleSubtitle error path', () => {
    it('should handle subtitle generation failure', async () => {
      mockSubtitleGenerate.mockRejectedValue(new Error('Subtitle provider unavailable'));

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'video.subtitle',
            arguments: { artifactId: 'video-1', language: 'en' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Subtitle provider unavailable');
    });
  });

  describe('Batch operation error paths', () => {
    it('should handle batch start failure', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: true,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const batchServer = new MCPServer(config);
      (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.start = vi
        .fn()
        .mockRejectedValue(new Error('Start failed'));

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.batch',
            arguments: {
              pipeline: { id: 'batch-pipeline', steps: [] },
              source: { type: 'inline', rows: [{ prompt: 'test' }] },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Start failed');
      await batchServer.stop();
    });

    it('should handle batch retry failure', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: true,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const batchServer = new MCPServer(config);
      (batchServer as unknown as MCPServerPrivateAccess).batchExecutor.retry = vi
        .fn()
        .mockRejectedValue(new Error('Retry failed'));

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.batch.retry',
            arguments: { batchId: 'batch-retry-1' },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Retry failed');
      await batchServer.stop();
    });
  });

  describe('Idempotency edge cases', () => {
    async function createIdempServer(): Promise<{
      server: MCPServer;
      handler: CallHandler;
      store: {
        get: (key: string) => Promise<unknown>;
        set: (entry: unknown) => Promise<void>;
        delete: (key: string) => Promise<void>;
      };
    }> {
      const config = createServerConfig({
        features: {
          idempotency: true,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const server = new MCPServer(config);
      await (server as unknown as MCPServerPrivateAccess).initPromise;
      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];
      return {
        server,
        handler,
        store: (server as unknown as MCPServerPrivateAccess).idempotencyMiddleware.store,
      };
    }

    it('should return cached completed response for idempotent request', async () => {
      const { server, handler } = await createIdempServer();

      const result1 = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'idemp-test',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
              _meta: { idempotencyKey: 'idemp-define-1' },
            },
          },
        },
        {},
      );
      expect(result1.success).toBe(true);

      const result2 = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'idemp-test',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
              _meta: { idempotencyKey: 'idemp-define-1' },
            },
          },
        },
        {},
      );
      expect(result2.success).toBe(true);
      await server.stop();
    });

    it('should throw IdempotencyConflictError for in-flight idempotent request', async () => {
      // Per fix #4: the canonical IdempotencyConflictError now propagates as a thrown
      // error rather than being caught and wrapped in a fake-success envelope. Callers
      // (MCP transport) surface it as an error response to the client.
      const { server, handler, store } = await createIdempServer();

      const bodyHash = (await import('../idempotency.js')).computeBodyHash({
        pipeline: { id: 'in-flight-test', steps: [] },
        _meta: { idempotencyKey: 'in-flight-key' },
      });
      await store.set({
        key: 'in-flight-key',
        runId: 'in-flight-key',
        bodyHash,
        response: null,
        status: 'in-flight',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(
        handler(
          {
            params: {
              name: 'media.pipeline.define',
              arguments: {
                pipeline: { id: 'in-flight-test', steps: [] },
                _meta: { idempotencyKey: 'in-flight-key' },
              },
            },
          },
          {},
        ),
      ).rejects.toThrow(/in-flight/);
      await server.stop();
    });

    it('should throw IdempotencyConflictError for body mismatch on existing key', async () => {
      const { server, handler, store } = await createIdempServer();

      await store.set({
        key: 'body-mismatch-key',
        runId: 'body-mismatch-key',
        bodyHash: 'different-hash',
        response: { content: [{ type: 'text', text: 'cached' }] },
        status: 'completed',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(
        handler(
          {
            params: {
              name: 'media.pipeline.define',
              arguments: {
                pipeline: {
                  id: 'body-mismatch-test',
                  steps: [
                    {
                      id: 'step1',
                      operation: 'image.generate',
                      inputs: { prompt: 'different' },
                      config: {},
                    },
                  ],
                },
                _meta: { idempotencyKey: 'body-mismatch-key' },
              },
            },
          },
          {},
        ),
      ).rejects.toThrow(/body-mismatch/);
      await server.stop();
    });

    it('should proceed when idempotency store.get throws', async () => {
      const { server, handler, store } = await createIdempServer();
      store.get = vi.fn().mockRejectedValue(new Error('Store error'));

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'store-error-test',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
              _meta: { idempotencyKey: 'store-error-key' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      await server.stop();
    });

    it('should handle error when idempotency store.set fails after success', async () => {
      const { server, handler, store } = await createIdempServer();
      let setCallCount = 0;
      store.set = vi.fn().mockImplementation(() => {
        setCallCount++;
        if (setCallCount > 1) throw new Error('Store write error');
        return Promise.resolve();
      });

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.define',
            arguments: {
              pipeline: {
                id: 'store-set-error',
                steps: [
                  {
                    id: 'step1',
                    operation: 'image.generate',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
              _meta: { idempotencyKey: 'store-set-error-key' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      await server.stop();
    });
  });

  describe('Pipeline estimate warnings for unknown providers', () => {
    it('should include warnings in estimate when some operations have no provider', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: true,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const estimateServer = new MCPServer(config);
      await (estimateServer as unknown as MCPServerPrivateAccess).initPromise;

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: {
            name: 'media.pipeline.estimate',
            arguments: {
              pipeline: {
                id: 'estimate-warn',
                steps: [
                  {
                    id: 'step1',
                    operation: 'unknown.nonexistent',
                    inputs: { prompt: 'test' },
                    config: {},
                  },
                ],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.estimate).toBeDefined();
      expect(result.estimate.warnings.length).toBeGreaterThan(0);
      expect(result.estimate.warnings[0].code).toBe('no-estimator');
      await estimateServer.stop();
    });
  });

  describe('Custom gate evaluator edge cases', () => {
    it('should handle customCheckFn as actual function', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-fn-gate',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-fn-gate',
              gate: {
                type: 'custom',
                config: { customCheckFn: '(a,c) => { return a.metadata.width >= 1024; }' },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('should evaluate custom gate with number customCheckFn', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-invalid-check',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-invalid-check',
              gate: { type: 'custom', config: { customCheckFn: 12345 }, action: 'fail' },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBeDefined();
    });
  });

  describe('Artifact evaluation fallback paths', () => {
    it('should fall back to storage when artifact not in registry', async () => {
      mockRegistryGet.mockReturnValue(undefined);

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'store-artifact',
              gate: {
                type: 'dimension-check',
                config: { expectedWidth: 1024, expectedHeight: 1024 },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
    });
  });

  describe('HTTP-level methods via start/stop', () => {
    it('should handle start and stop with feature flags', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const httpServer = new MCPServer(config);
      await expect(httpServer.start()).resolves.not.toThrow();
      await expect(httpServer.stop()).resolves.not.toThrow();
    });
  });

  describe('handlePipelineEvent edge cases', () => {
    it('should publish events to eventBus', async () => {
      const mockEventBus = { subscribe: vi.fn().mockReturnValue(vi.fn()), publish: vi.fn() };
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
        eventBus: mockEventBus as unknown as EventBus<PipelineEvent>,
      });
      const eventServer = new MCPServer(config);

      (eventServer as unknown as MCPServerPrivateAccess).handlePipelineEvent({
        type: 'step:complete',
        pipelineId: 'p-1',
        stepId: 'step1',
        timestamp: new Date().toISOString(),
        artifactId: 'art-1',
      });

      expect(mockEventBus.publish).toHaveBeenCalled();
      await eventServer.stop();
    });

    it('should log in debug mode with mcpResources tracking', async () => {
      const config = createServerConfig({
        logLevel: 'debug',
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: true,
          sttStream: false,
        },
      });
      const debugServer = new MCPServer(config);
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Set up artifactResourceHandler.addResource mock
      (debugServer as unknown as MCPServerPrivateAccess).artifactResourceHandler.addResource = vi
        .fn()
        .mockResolvedValue(undefined);

      (debugServer as unknown as MCPServerPrivateAccess).handlePipelineEvent({
        type: 'step:complete',
        pipelineId: 'p-1',
        stepId: 'step1',
        timestamp: new Date().toISOString(),
        artifactId: 'art-1',
        data: { provider: 'mock', model: 'test' },
      });

      expect(consoleDebugSpy).toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      await debugServer.stop();
    });

    it('should dispatch to webhooks when feature is enabled', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: true,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const webhookServer = new MCPServer(config);

      const deliverEventSpy = vi.fn();
      (webhookServer as unknown as MCPServerPrivateAccess).webhookDeliveryService.deliverEvent =
        deliverEventSpy;

      (webhookServer as unknown as MCPServerPrivateAccess).handlePipelineEvent({
        type: 'step:complete',
        pipelineId: 'test-pipeline',
        stepId: 'step1',
        timestamp: new Date().toISOString(),
        artifactId: 'art-1',
      });

      expect(deliverEventSpy).not.toHaveBeenCalled();
      await webhookServer.stop();
    });
  });

  describe('Provider-specific input preparation', () => {
    it('should prepare provider inputs with audio artifact', async () => {
      mockStorageGet.mockResolvedValue({
        data: Buffer.from('audio-data'),
        meta: {
          type: 'audio',
          mimeType: 'audio/mp3',
          metadata: {},
          sourceStep: 'step1',
          createdAt: '2026-01-01T00:00:00Z',
        },
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: { name: 'audio.tts', arguments: { text: 'Hello world' } },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should prepare provider inputs with video artifact', async () => {
      mockStorageGet.mockResolvedValue({
        data: Buffer.from('video-data'),
        meta: {
          type: 'video',
          mimeType: 'video/mp4',
          metadata: {},
          sourceStep: 'step1',
          createdAt: '2026-01-01T00:00:00Z',
        },
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: { name: 'video.extract_frames', arguments: { artifact_id: 'video-1' } },
        },
        {},
      );

      expect(result.success).toBe(true);
    });

    it('should handle prepareProviderInputs with non-string artifact_id', async () => {
      const srv = new MCPServer(baseConfig);
      await (srv as unknown as MCPServerPrivateAccess).initPromise;
      const prepared = await (srv as unknown as MCPServerPrivateAccess).prepareProviderInputs(
        'image.upscale',
        {
          artifact_id: 12345,
        },
      );
      expect(prepared.artifact_id).toBe(12345);
    });

    it('should handle prepareProviderInputs with empty artifact_id', async () => {
      const srv = new MCPServer(baseConfig);
      await (srv as unknown as MCPServerPrivateAccess).initPromise;
      const prepared = await (srv as unknown as MCPServerPrivateAccess).prepareProviderInputs(
        'image.upscale',
        {
          artifact_id: '',
        },
      );
      expect(prepared.artifact_id).toBe('');
    });
  });

  describe('Pipeline cancel with abort controller', () => {
    it('should abort existing controller when cancelling', async () => {
      const srv = new MCPServer(baseConfig);
      await (srv as unknown as MCPServerPrivateAccess).initPromise;
      const abortSpy = vi.fn();
      (srv as unknown as MCPServerPrivateAccess).pipelineCancelControllers.set(
        'running-pipeline-abc',
        { abort: abortSpy },
      );
      (srv as unknown as MCPServerPrivateAccess).pipelines.set('running-pipeline-abc', {
        id: 'running-pipeline-abc',
        status: 'running',
        steps: [
          { id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' }, config: {} },
        ],
        completedSteps: [],
        currentStep: 'step1',
        artifacts: new Map(),
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'media.pipeline.cancel',
            arguments: { pipeline_id: 'running-pipeline-abc' },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
      expect(
        (srv as unknown as MCPServerPrivateAccess).pipelineCancelControllers.has(
          'running-pipeline-abc',
        ),
      ).toBe(false);
      await srv.stop();
    });
  });

  describe('Internal utility method coverage', () => {
    it('should handle extractOperationName correctly', () => {
      const srv = new MCPServer(baseConfig);

      const result1 = (srv as unknown as MCPServerPrivateAccess).extractOperationName({
        method: 'tools/call',
        params: { name: 'image.generate' },
      });
      expect(result1).toBe('image.generate');

      const result2 = (srv as unknown as MCPServerPrivateAccess).extractOperationName({
        method: 'other',
      });
      expect(result2).toBeUndefined();

      const result3 = (srv as unknown as MCPServerPrivateAccess).extractOperationName(
        'not-an-object',
      );
      expect(result3).toBeUndefined();

      const result4 = (srv as unknown as MCPServerPrivateAccess).extractOperationName(null);
      expect(result4).toBeUndefined();
    });

    it('should handle getClientId with and without x-client-id', () => {
      const srv = new MCPServer(baseConfig);

      const reqWithHeader = {
        headers: { 'x-client-id': 'my-client' },
        socket: { remoteAddress: '1.2.3.4' },
      };
      expect((srv as unknown as MCPServerPrivateAccess).getClientId(reqWithHeader)).toBe(
        'my-client',
      );

      const reqNoHeader = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };
      expect((srv as unknown as MCPServerPrivateAccess).getClientId(reqNoHeader)).toBe('1.2.3.4');

      const reqEmptyHeader = {
        headers: { 'x-client-id': '' },
        socket: { remoteAddress: '5.6.7.8' },
      };
      expect((srv as unknown as MCPServerPrivateAccess).getClientId(reqEmptyHeader)).toBe(
        '5.6.7.8',
      );

      const reqNoHeaderNoAddr = { headers: {}, socket: { remoteAddress: '' } };
      expect((srv as unknown as MCPServerPrivateAccess).getClientId(reqNoHeaderNoAddr)).toBe(
        'anonymous',
      );
    });

    it('should handle parseRequestBody edge cases', async () => {
      const srv = new MCPServer(baseConfig);
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };

      const nonPostReq = { method: 'GET' } as unknown as { method: string };
      const nonPostResult = await (srv as unknown as MCPServerPrivateAccess).parseRequestBody(
        nonPostReq,
        res,
      );
      expect(nonPostResult).toBeUndefined();

      const emptyBodyReq = {
        method: 'POST',
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      };
      const emptyResult = await (srv as unknown as MCPServerPrivateAccess).parseRequestBody(
        emptyBodyReq,
        res,
      );
      expect(emptyResult).toBeUndefined();

      const jsonReq = {
        method: 'POST',
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: () => {
              if (called) return Promise.resolve({ done: true, value: undefined });
              called = true;
              return Promise.resolve({ done: false, value: Buffer.from('{"test":"ok"}') });
            },
          };
        },
      };
      const jsonResult = await (srv as unknown as MCPServerPrivateAccess).parseRequestBody(
        jsonReq,
        res,
      );
      expect(jsonResult).toEqual({ test: 'ok' });
    });

    it('should handle parseRequestBody with invalid JSON', async () => {
      const srv = new MCPServer(baseConfig);
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };

      const badJsonReq = {
        method: 'POST',
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: () => {
              if (called) return Promise.resolve({ done: true, value: undefined });
              called = true;
              return Promise.resolve({ done: false, value: Buffer.from('not json') });
            },
          };
        },
      };
      const badResult = await (srv as unknown as MCPServerPrivateAccess).parseRequestBody(
        badJsonReq,
        res,
      );
      expect(badResult).toBeUndefined();
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should handle parseRequestBody with stream error', async () => {
      const srv = new MCPServer(baseConfig);
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };

      const errReq = {
        method: 'POST',
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('Stream error')),
        }),
      };
      const errResult = await (srv as unknown as MCPServerPrivateAccess).parseRequestBody(
        errReq,
        res,
      );
      expect(errResult).toBeUndefined();
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('should handle toBuffer with various data types', async () => {
      const srv = new MCPServer(baseConfig);

      const bufResult = await (srv as unknown as MCPServerPrivateAccess).toBuffer(
        Buffer.from('hello'),
      );
      expect(bufResult).toBeInstanceOf(Buffer);
      expect(bufResult.toString()).toBe('hello');

      const asyncIterable = {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2')];
          return {
            next: () =>
              Promise.resolve(
                i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
              ),
          };
        },
      };
      const iterResult = await (srv as unknown as MCPServerPrivateAccess).toBuffer(asyncIterable);
      expect(iterResult.toString()).toBe('chunk1chunk2');

      await expect((srv as unknown as MCPServerPrivateAccess).toBuffer(12345)).rejects.toThrow(
        'Unsupported artifact payload type',
      );
    });

    it('should handle toBuffer with Uint8Array chunks', async () => {
      const srv = new MCPServer(baseConfig);

      const asyncIterable = {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          const chunks = [new Uint8Array([1, 2, 3]), 'string-chunk'];
          return {
            next: () =>
              Promise.resolve(
                i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
              ),
          };
        },
      };
      const result = await (srv as unknown as MCPServerPrivateAccess).toBuffer(asyncIterable);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle persistArtifact without data', async () => {
      const srv = new MCPServer(baseConfig);
      const result = await (srv as unknown as MCPServerPrivateAccess).persistArtifact({
        artifactId: 'test-no-data',
        operation: 'image.generate',
        artifact: { type: 'image', uri: 'test://uri', mimeType: 'image/png', metadata: {} },
        pipelineId: 'test-pipeline',
        stepId: 'step1',
      });
      expect(result.uri).toBe('test://uri');
    });

    it('should handle prepareProviderInputs with audio artifact for audio operation', async () => {
      mockStorageGet.mockResolvedValue({
        data: Buffer.from('audio-data'),
        meta: {
          type: 'audio',
          mimeType: 'audio/mp3',
          metadata: {},
          sourceStep: 'step1',
          createdAt: '2026-01-01T00:00:00Z',
        },
      });

      const srv = new MCPServer(baseConfig);
      await (srv as unknown as MCPServerPrivateAccess).initPromise;

      const prepared = await (srv as unknown as MCPServerPrivateAccess).prepareProviderInputs(
        'audio.stt',
        {
          artifact_id: 'audio-1',
        },
      );
      expect(prepared.artifact_data).toBeDefined();
      expect(prepared.audio_data).toBeDefined();
    });

    it('should handle evaluateCustomGate with function type', async () => {
      const srv = new MCPServer(baseConfig);

      const fnArtifact = {
        id: 'test',
        type: 'image' as const,
        mimeType: 'image/png',
        uri: 'uri',
        metadata: { width: 1024 },
      };
      const fnResult = await (srv as unknown as MCPServerPrivateAccess).evaluateCustomGate(
        fnArtifact,
        {
          customCheckFn: (a: Record<string, unknown>) =>
            (a.metadata as { width: number }).width >= 1024,
        },
      );
      expect(fnResult).toBe(true);

      const fnResult2 = await (srv as unknown as MCPServerPrivateAccess).evaluateCustomGate(
        fnArtifact,
        {
          customCheckFn: (a: Record<string, unknown>) =>
            (a.metadata as { width: number }).width < 100,
        },
      );
      expect(fnResult2).toBe(false);

      await expect(
        (srv as unknown as MCPServerPrivateAccess).evaluateCustomGate(fnArtifact, {
          customCheckFn: null,
        }),
      ).rejects.toThrow('customCheckFn must be a function or string');
    });

    it('should handle attachArtifactPayload with unknown mime type', () => {
      const srv = new MCPServer(baseConfig);
      const target: Record<string, unknown> = {};
      (srv as unknown as MCPServerPrivateAccess).attachArtifactPayload(
        target,
        'artifact_id',
        'art-1',
        Buffer.from('data'),
        'application/octet-stream',
      );
      expect(target.mime_type).toBe('application/octet-stream');
    });

    it('should handle toBuffer with unsupported chunk type', async () => {
      const srv = new MCPServer(baseConfig);
      const asyncIterable = {
        [Symbol.asyncIterator]: () => {
          let called = false;
          return {
            next: () => {
              if (called) return Promise.resolve({ done: true });
              called = true;
              return Promise.resolve({ done: false, value: null });
            },
          };
        },
      };
      await expect(
        (srv as unknown as MCPServerPrivateAccess).toBuffer(asyncIterable),
      ).rejects.toThrow('Unsupported stream chunk type');
    });

    it('should call start with mcpResources enabled', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: true,
          sttStream: false,
        },
      });
      const srv = new MCPServer(config);
      await srv.start();
      await srv.stop();
    });

    it('should handle authorizedRequest with and without auth middleware', async () => {
      const srv = new MCPServer(baseConfig);

      const res1 = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const result1 = await (srv as unknown as MCPServerPrivateAccess).authorizeRequest(
        { headers: {} },
        res1,
      );
      expect(result1.allowed).toBe(true);

      const securedConfig = createServerConfig({
        auth: {
          enabled: true,
          apiKeys: [{ key: 'test-key', userId: 'user-1', permissions: ['admin'] }],
        },
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const securedSrv = new MCPServer(securedConfig);
      await (securedSrv as unknown as MCPServerPrivateAccess).initPromise;

      const authRes = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const authResult = await (securedSrv as unknown as MCPServerPrivateAccess).authorizeRequest(
        { headers: { authorization: 'Bearer invalid' } },
        authRes,
      );
      expect(authResult.allowed).toBe(false);
      expect(authRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    });

    it('should handle authorizeRequest with successful auth', async () => {
      const securedConfig = createServerConfig({
        auth: {
          enabled: true,
          jwtSecret: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn',
          apiKeys: [{ key: 'valid-key', userId: 'user-1', permissions: ['admin'] }],
        },
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const secured = new MCPServer(securedConfig);
      await (secured as unknown as MCPServerPrivateAccess).initPromise;
      const authMiddleware = secured.getAuthMiddleware()!;
      vi.spyOn(authMiddleware, 'authenticate').mockResolvedValue({
        authenticated: true,
        permissions: ['admin'],
      });

      const req = { headers: { authorization: 'Bearer valid-token' } } as unknown as {
        headers: Record<string, string | undefined>;
        auth?: unknown;
      };
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const result = await (secured as unknown as MCPServerPrivateAccess).authorizeRequest(
        req,
        res,
      );
      expect(result.allowed).toBe(true);
      expect(req.auth).toBeDefined();
    });

    it('should handle applyRateLimit when rate limiter is not configured', () => {
      const srv = new MCPServer(baseConfig);
      const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as unknown as {
        setHeader: ReturnType<typeof vi.fn>;
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const result = (srv as unknown as MCPServerPrivateAccess).applyRateLimit(
        { headers: {} },
        res,
        {
          method: 'tools/call',
          params: { name: 'image.generate' },
        },
      );
      expect(result).toBe(true);
    });

    it('should handle applyRateLimit rate limit exceeded', () => {
      const limitedConfig = createServerConfig({
        rateLimit: {
          enabled: true,
          clientRequestsPerMinute: 0,
          clientBurstSize: 0,
          expensiveOperationsPerMinute: 0,
        },
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const limitedSrv = new MCPServer(limitedConfig);
      const rateLimiter = limitedSrv.getRateLimiter()!;
      vi.spyOn(rateLimiter, 'checkLimit').mockReturnValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60000,
      });
      vi.spyOn(rateLimiter, 'getHeaders').mockReturnValue({});
      const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() } as unknown as {
        setHeader: ReturnType<typeof vi.fn>;
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      const result = (limitedSrv as unknown as MCPServerPrivateAccess).applyRateLimit(
        { headers: {}, socket: { remoteAddress: '1.2.3.4' } },
        res,
        { method: 'tools/call', params: { name: 'image.generate' } },
      );
      expect(result).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
    });

    it('should handle interpolateRowIntoPipeline', () => {
      const srv = new MCPServer(baseConfig);
      const pipeline = {
        id: 'test',
        steps: [
          {
            id: 'step1',
            operation: 'image.generate',
            inputs: { prompt: '{{row.prompt}}' },
            config: { scale: '{{row.scale}}' },
          },
          {
            id: 'step2',
            operation: 'image.upscale',
            inputs: { artifact_id: '{{step1.output}}' },
            config: {},
          },
        ],
      };
      const row = { prompt: 'test prompt', scale: '2x' };
      const interpolated = (srv as unknown as MCPServerPrivateAccess).interpolateRowIntoPipeline(
        pipeline,
        row,
      ) as { steps: Array<{ inputs: Record<string, string>; config: Record<string, string> }> };
      expect(interpolated.steps[0].inputs.prompt).toBe('test prompt');
      expect(interpolated.steps[0].config.scale).toBe('2x');
      expect(interpolated.steps[1].inputs.artifact_id).toBe('{{step1.output}}');
    });

    it('should handle interpolateString with missing field', () => {
      const srv = new MCPServer(baseConfig);
      const result = (srv as unknown as MCPServerPrivateAccess).interpolateString(
        'Hello {{row.name}}',
        {},
      );
      expect(result).toBe('Hello {{row.name}}');
    });

    it('should provide accessors for auth and cost', () => {
      const srv = new MCPServer(baseConfig);
      expect(srv.getAuthMiddleware()).toBeUndefined();
      expect(srv.getCostTracker()).toBeDefined();
    });
  });

  describe('Error paths in handleOperation', () => {
    it('should return error when no provider available', async () => {
      const config = createServerConfig({
        features: {
          idempotency: false,
          contentCache: false,
          resumablePipelines: false,
          budgetCaps: false,
          dryRun: false,
          streaming: false,
          webhooks: false,
          routing: false,
          variants: false,
          subtitles: false,
          runContext: false,
          batch: false,
          safetyGate: false,
          provenance: false,
          multiTenant: false,
          mcpResources: false,
          sttStream: false,
        },
      });
      const srv = new MCPServer(config);
      await (srv as unknown as MCPServerPrivateAccess).initPromise;
      // Remove all providers so no provider can be found
      (srv as unknown as MCPServerPrivateAccess).providerRegistry.getAllProviders = vi
        .fn()
        .mockReturnValue([]);
      (srv as unknown as MCPServerPrivateAccess).providerRegistry.getProvider = vi
        .fn()
        .mockReturnValue(null);

      const handler = setRequestHandlerMock.mock.calls
        .filter((call: unknown[]) => call[0] === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await handler(
        {
          params: { name: 'image.generate', arguments: { prompt: 'test' } },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No provider available');
      await srv.stop();
    });
  });

  describe('evaluateWithLLM metadata-based fallback', () => {
    it('should use metadata fallback when no OPENAI_API_KEY is set', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-for-llm',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-for-llm',
              gate: {
                type: 'llm-judge',
                config: { prompt: 'Is this good?', model: 'gpt-4o-mini' },
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('should call OpenAI API when OPENAI_API_KEY is set', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';

      const originalFetch = globalThis.fetch;
      const mockJsonResponse = {
        choices: [{ message: { content: '{"pass":true,"reasoning":"Looks good","score":8}' } }],
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockJsonResponse),
      });

      mockRegistryGet.mockReturnValue({
        id: 'art-for-llm-key',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024, model: 'gpt-4o-mini' },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-for-llm-key',
              gate: {
                type: 'llm-judge',
                config: { prompt: 'Is this good?', model: 'gpt-4o-mini' },
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(8);

      globalThis.fetch = originalFetch;
      process.env.OPENAI_API_KEY = originalKey;
    });

    it('should call evaluateWithLLM directly for fetch failure path', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const srv = new MCPServer(baseConfig);
      const artifact = {
        id: 'test',
        type: 'image' as const,
        mimeType: 'image/png',
        uri: 'uri',
        metadata: { width: 1024 },
      };

      await expect(
        (srv as unknown as MCPServerPrivateAccess).evaluateWithLLM('Is this good?', artifact),
      ).rejects.toThrow('LLM-judge');

      globalThis.fetch = originalFetch;
      process.env.OPENAI_API_KEY = originalKey;
    });

    it('should call evaluateWithLLM directly for empty response path', async () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: '' } }] }),
      });

      const srv = new MCPServer(baseConfig);
      const artifact = {
        id: 'test',
        type: 'image' as const,
        mimeType: 'image/png',
        uri: 'uri',
        metadata: { width: 1024 },
      };

      await expect(
        (srv as unknown as MCPServerPrivateAccess).evaluateWithLLM('Is this good?', artifact),
      ).rejects.toThrow('did not include');

      globalThis.fetch = originalFetch;
      process.env.OPENAI_API_KEY = originalKey;
    });

    it('should work with dimension-check gate', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-for-dim',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-for-dim',
              gate: {
                type: 'dimension-check',
                config: { expectedWidth: 1024, expectedHeight: 1024, tolerance: 0.05 },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('should evaluate custom gate with string check function', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-custom',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-custom',
              gate: {
                type: 'custom',
                config: {
                  customCheckFn: '(a,c) => { return a.metadata.width >= 1024; }',
                },
                action: 'warn',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });

    it('should reject custom gate when check function returns false', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-custom-fail',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 100, height: 100 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-custom-fail',
              gate: {
                type: 'custom',
                config: {
                  customCheckFn: '(a,c) => { return a.metadata.width >= 1024; }',
                },
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.action_taken).toBe('fail');
    });

    it('should handle custom gate with check function that throws', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-custom-throw',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-custom-throw',
              gate: {
                type: 'custom',
                config: {
                  customCheckFn: '(a,c) => { throw new Error("check failed"); }',
                },
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain('check failed');
    });

    it('should evaluate threshold gate', async () => {
      mockRegistryGet.mockReturnValue({
        id: 'art-threshold',
        type: 'image',
        uri: 'uri://art',
        mimeType: 'image/png',
        metadata: { width: 1024, height: 1024 },
        sourceStep: 'step1',
        createdAt: '2026-01-01T00:00:00Z',
      });

      const handler = getCallHandler();
      const result = await handler(
        {
          params: {
            name: 'quality_gate.evaluate',
            arguments: {
              artifact_id: 'art-threshold',
              gate: {
                type: 'threshold',
                config: {
                  checks: [
                    { field: 'width', operator: '>=', value: 1024 },
                    { field: 'height', operator: '>=', value: 1024 },
                  ],
                },
                action: 'fail',
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.passed).toBe(true);
    });
  });
});
