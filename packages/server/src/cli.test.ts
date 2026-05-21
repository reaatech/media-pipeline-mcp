import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({
    port: 8080,
    host: '0.0.0.0',
    logLevel: 'info',
    storage: { type: 'local', config: { basePath: './artifacts' } },
    providers: [],
    features: { dryRun: true },
  })),
}));

const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('./mcp-server.js', () => ({
  MCPServer: vi.fn(() => ({
    start: mockStart,
    stop: mockStop,
  })),
}));

function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start the server successfully', async () => {
    mockStart.mockResolvedValueOnce(undefined);

    const { main } = await import('./cli.js');
    await main();

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('should exit with code 1 when server start fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStart.mockRejectedValueOnce(new Error('Port in use'));

    const { main } = await import('./cli.js');
    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Failed to start server:', expect.any(Error));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should stop server on SIGINT', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStart.mockResolvedValueOnce(undefined);

    const { main } = await import('./cli.js');
    const promise = main();

    process.emit('SIGINT');
    await promise;

    expect(mockStop).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('should stop server on SIGTERM', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockStart.mockResolvedValueOnce(undefined);

    const { main } = await import('./cli.js');
    const promise = main();

    process.emit('SIGTERM');
    await promise;

    expect(mockStop).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('runMain should handle fatal error when loadConfig throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { loadConfig: mockLoadConfig } = await import('./config.js');
    // The vi.mock factory wraps loadConfig in a Mock; cast to access mock methods.
    (
      mockLoadConfig as unknown as { mockImplementationOnce: (fn: () => never) => void }
    ).mockImplementationOnce(() => {
      throw new Error('config load failed');
    });

    const { runMain } = await import('./cli.js');
    runMain();
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith('Fatal error:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
