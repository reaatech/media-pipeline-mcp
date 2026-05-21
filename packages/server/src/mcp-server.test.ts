import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from './config.js';
import { MCPServer } from './mcp-server.js';

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
    StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {},
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

vi.mock('@reaatech/media-pipeline-mcp-storage', () => ({
  createStorage: () => ({
    put: vi.fn().mockResolvedValue('uri'),
    get: vi.fn().mockResolvedValue({
      data: Buffer.from('test'),
      meta: { type: 'image', mimeType: 'image/png' },
    }),
    getSignedUrl: vi.fn().mockResolvedValue('signed-url'),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
  }),
}));

describe('MCPServer', () => {
  let server: MCPServer;

  const config: ServerConfig = {
    port: 18080,
    host: '0.0.0.0',
    logLevel: 'info',
    storage: {
      type: 'local',
      config: {
        basePath: './artifacts',
      },
    },
    providers: [],
  };

  beforeEach(() => {
    setRequestHandlerMock.mockClear();
    server = new MCPServer(config);
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('start', () => {
    it('should start the server without errors', async () => {
      await expect(server.start()).resolves.not.toThrow();
    });
  });

  describe('stop', () => {
    it('should stop the server without errors', async () => {
      await server.start();
      await expect(server.stop()).resolves.not.toThrow();
    });
  });

  describe('tool authorization', () => {
    it('should reject tools when authenticated user lacks permission', async () => {
      const securedServer = new MCPServer({
        ...config,
        auth: {
          enabled: true,
          apiKeys: [
            {
              key: 'test-key',
              userId: 'user-1',
              permissions: ['artifact:read'],
            },
          ],
        },
      });

      const securedCallHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await securedCallHandler(
        {
          params: {
            name: 'media.artifact.delete',
            arguments: { artifact_id: 'artifact-1' },
          },
        },
        {
          authInfo: {
            authenticated: true,
            permissions: ['artifact:read'],
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Forbidden');

      await securedServer.stop();
    });
  });

  describe('rate limiting', () => {
    it('should pass operation name into rate limiter checks', () => {
      const limitedServer = new MCPServer({
        ...config,
        rateLimit: {
          enabled: true,
          clientRequestsPerMinute: 60,
          clientBurstSize: 10,
          expensiveOperationsPerMinute: 5,
        },
      });

      const checkLimitSpy = vi.spyOn(limitedServer.getRateLimiter()!, 'checkLimit');
      const req = {
        headers: { 'x-client-id': 'client-1' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as {
        headers: Record<string, string | undefined>;
        socket: { remoteAddress: string };
      };
      const res = {
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end: vi.fn(),
      } as unknown as {
        setHeader: ReturnType<typeof vi.fn>;
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };

      (
        limitedServer as unknown as {
          applyRateLimit(
            req: unknown,
            res: unknown,
            body: { method: string; params: { name: string } },
          ): void;
        }
      ).applyRateLimit(req, res, {
        method: 'tools/call',
        params: { name: 'image.generate' },
      });

      expect(checkLimitSpy).toHaveBeenCalledWith('client-1', 'image.generate');
    });
  });

  describe('pipeline.cancel', () => {
    it('should return error for non-existent pipeline', async () => {
      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        { params: { name: 'media.pipeline.cancel', arguments: { pipeline_id: 'nonexistent' } } },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('pipeline.estimate', () => {
    it('should return disabled when dryRun feature is off', async () => {
      const disabledConfig: ServerConfig = {
        ...config,
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
      };

      new MCPServer(disabledConfig);

      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'media.pipeline.estimate',
            arguments: {
              pipeline: {
                id: 'test-pipeline',
                steps: [{ id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' } }],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should return estimate when dryRun feature is on', async () => {
      const estimateConfig: ServerConfig = {
        ...config,
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
      };

      const estimateServer = new MCPServer(estimateConfig);

      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'media.pipeline.estimate',
            arguments: {
              pipeline: {
                id: 'test-pipeline',
                steps: [{ id: 'step1', operation: 'image.generate', inputs: { prompt: 'test' } }],
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.estimate).toBeDefined();
      expect(result.estimate.totalUsdLow).toBeGreaterThanOrEqual(0);
      expect(result.estimate.totalUsdHigh).toBeGreaterThanOrEqual(result.estimate.totalUsdLow);
      expect(result.estimate.perStep).toHaveLength(1);
      expect(result.estimate.warnings).toBeDefined();

      await estimateServer.stop();
    });
  });

  describe('pipeline.subscribe', () => {
    it('should return disabled when webhooks feature is off', async () => {
      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'media.pipeline.subscribe',
            arguments: {
              pipeline_id: 'pipeline-1',
              url: 'https://example.com/webhook',
              events: ['pipeline:complete'],
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should create subscription when webhooks feature is on', async () => {
      const webhookConfig: ServerConfig = {
        ...config,
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
      };

      const webhookServer = new MCPServer(webhookConfig);

      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'media.pipeline.subscribe',
            arguments: {
              pipeline_id: 'pipeline-1',
              url: 'https://example.com/webhook',
              events: ['pipeline:complete'],
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(result.subscription_id).toBeDefined();
      expect(result.pipeline_id).toBe('pipeline-1');
      expect(result.events).toEqual(['pipeline:complete']);

      await webhookServer.stop();
    });
  });

  describe('audio.transcribeStream', () => {
    it('should return disabled when sttStream feature is off', async () => {
      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: {
                kind: 'inline',
                data: 'dGVzdA==',
                encoding: 'linear16',
                sampleRateHz: 16000,
              },
            },
          },
        },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should return mock transcript with expected shape when enabled', async () => {
      const sttConfig: ServerConfig = {
        ...config,
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
      };

      const sttServer = new MCPServer(sttConfig);

      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        {
          params: {
            name: 'audio.transcribeStream',
            arguments: {
              source: {
                kind: 'inline',
                data: 'dGhpcyBpcyBhdWRpbw==',
                encoding: 'linear16',
                sampleRateHz: 16000,
              },
              language: 'en-US',
              provider: 'deepgram',
              model: 'nova-2',
            },
          },
        },
        {},
      );

      expect(result.success).toBe(true);
      expect(typeof result.transcript).toBe('string');
      expect(result.transcript.length).toBeGreaterThan(0);
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThan(0);
      expect(Array.isArray(result.segments)).toBe(true);
      expect(result.segments.length).toBeGreaterThan(0);
      expect(typeof result.provider).toBe('string');
      expect(typeof result.model).toBe('string');
      expect(typeof result.language).toBe('string');
      expect(typeof result.audioDuration).toBe('number');
      expect(result.provider).toBe('deepgram');
      expect(result.model).toBe('nova-2');
      expect(result.language).toBe('en-US');

      await sttServer.stop();
    });

    it('should require source configuration', async () => {
      const sttConfig: ServerConfig = {
        ...config,
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
      };

      const sttServer = new MCPServer(sttConfig);

      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        { params: { name: 'audio.transcribeStream', arguments: {} } },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing source');

      await sttServer.stop();
    });

    it('should reject mic mode in non-local deployments', async () => {
      const sttConfig: ServerConfig = {
        ...config,
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
      };

      const sttServer = new MCPServer(sttConfig);
      const callHandler = setRequestHandlerMock.mock.calls
        .filter(([schema]) => schema === CallToolRequestSchema)
        .at(-1)?.[1];

      const result = await callHandler(
        { params: { name: 'audio.transcribeStream', arguments: { source: { kind: 'mic' } } } },
        {},
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('MIC_NOT_AVAILABLE');

      await sttServer.stop();
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
