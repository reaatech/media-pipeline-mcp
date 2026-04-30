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
      } as any;
      const res = {
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end: vi.fn(),
      } as any;

      (limitedServer as any).applyRateLimit(req, res, {
        method: 'tools/call',
        params: { name: 'image.generate' },
      });

      expect(checkLimitSpy).toHaveBeenCalledWith('client-1', 'image.generate');
    });
  });
});
