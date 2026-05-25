import { describe, expect, it, vi } from 'vitest';

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockLoadConfig = vi.fn(() => ({
  port: 0,
  host: '127.0.0.1',
  logLevel: 'info' as const,
  storage: { type: 'local' as const, config: { basePath: './test-artifacts' } },
  providers: [],
}));

vi.mock('../config.js', () => ({
  loadConfig: mockLoadConfig,
}));

vi.mock('../mcp-server.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must use function expression for `new` constructor mock
  MCPServer: vi.fn().mockImplementation(function () {
    return { start: mockStart, stop: mockStop };
  }),
}));

describe('CLI', () => {
  it('should load config and start server on runMain', async () => {
    const { main } = await import('../cli.js');
    await main();

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it('isMainModule should detect cli.js', async () => {
    const { isMainModule } = await import('../cli.js');
    const original = process.argv[1];
    process.argv[1] = '/path/to/cli.js';
    expect(isMainModule()).toBe(true);
    process.argv[1] = original;
  });

  it('isMainModule should detect cli.ts', async () => {
    const { isMainModule } = await import('../cli.js');
    const original = process.argv[1];
    process.argv[1] = '/path/to/cli.ts';
    expect(isMainModule()).toBe(true);
    process.argv[1] = original;
  });

  it('isMainModule should return false for other files', async () => {
    const { isMainModule } = await import('../cli.js');
    const original = process.argv[1];
    process.argv[1] = '/path/to/other.js';
    expect(isMainModule()).toBe(false);
    process.argv[1] = original;
  });
});
