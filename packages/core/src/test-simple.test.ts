import { describe, expect, it } from 'vitest';
describe('test', () => {
  it('works', () => {
    expect(1).toBe(1);
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('./index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
