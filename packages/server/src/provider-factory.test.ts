import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctorSpy = vi.fn();

vi.mock('@media-pipeline/openai', () => ({
  OpenAIProvider: class {
    name = 'openai';
    supportedOperations = ['image.generate'];
    constructor(config: Record<string, unknown>) {
      ctorSpy(config);
    }
    execute = vi.fn();
    healthCheck = vi.fn().mockResolvedValue({ healthy: true });
  },
}));

vi.mock('@media-pipeline/google', () => ({
  GoogleProvider: class {
    name = 'google';
    supportedOperations = ['document.ocr'];
    constructor(config: Record<string, unknown>) {
      ctorSpy(config);
    }
    execute = vi.fn();
    healthCheck = vi.fn().mockResolvedValue({ healthy: true });
  },
}));

vi.mock('@media-pipeline/stability', () => ({ StabilityProvider: class {} }));
vi.mock('@media-pipeline/replicate', () => ({ ReplicateProvider: class {} }));
vi.mock('@media-pipeline/fal', () => ({ FalProvider: class {} }));
vi.mock('@media-pipeline/elevenlabs', () => ({ ElevenLabsProvider: class {} }));
vi.mock('@media-pipeline/deepgram', () => ({ DeepgramProvider: class {} }));
vi.mock('@media-pipeline/anthropic', () => ({ AnthropicProvider: class {} }));

import { createProvider } from './provider-factory.js';

describe('createProvider', () => {
  beforeEach(() => {
    ctorSpy.mockReset();
  });

  it('should inject API keys for providers that require them', () => {
    process.env.OPENAI_API_KEY = 'openai-key';

    const provider = createProvider({
      name: 'openai',
      operations: ['image.generate'],
    });

    expect(provider).toBeTruthy();
    expect(ctorSpy).toHaveBeenCalledWith({ apiKey: 'openai-key' });

    delete process.env.OPENAI_API_KEY;
  });

  it('should create google provider without requiring GOOGLE_API_KEY', () => {
    const provider = createProvider({
      name: 'google',
      operations: ['document.ocr'],
      config: { projectId: 'test-project' },
    });

    expect(provider).toBeTruthy();
    expect(ctorSpy).toHaveBeenCalledWith({ projectId: 'test-project' });
  });
});
