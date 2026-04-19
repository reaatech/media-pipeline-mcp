import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      checkThresholds: true,
      threshold: {
        global: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/node_modules/**',
        '**/dist/**',
        'src/cli.ts',
        'src/index.ts',
        'src/mcp-server.ts',
      ],
    },
  },
});
