import type { RunContext } from '@reaatech/media-pipeline-mcp-core';
import { ContextRefTypeError, ContextRefUnknownError } from '@reaatech/media-pipeline-mcp-core';
import { describe, expect, it } from 'vitest';
import { ContextResolver } from '../run-context.js';

describe('ContextResolver', () => {
  const resolver = new ContextResolver();

  const context: RunContext = {
    voices: {
      narrator: {
        provider: 'elevenlabs',
        voiceId: 'voice-abc-123',
        settings: { speed: 1.0, stability: 0.7 },
      },
    },
    styles: {
      cinematic: {
        description: 'Cinematic, dramatic lighting, shallow depth of field',
        negative: 'flat, dull, boring',
        perProvider: {
          'stability-ai': {
            description: 'Epic cinematic shot, dramatic lighting',
            negative: 'dull',
          },
        },
      },
    },
    brandKit: {
      primaryColor: '#FF5500',
      secondaryColor: '#00AAFF',
      fontFamily: 'Inter',
      logoArtifactId: 'logo-xyz',
    },
  };

  // ─── 1. Voice ref resolution ─────────────────────────────────────────

  it('voice ref resolution: voice.$ref → resolves to voiceId+settings', () => {
    const result = resolver.resolve(context, { kind: 'voice', name: 'narrator' }, 'elevenlabs');

    expect(result).toEqual({
      provider: 'elevenlabs',
      voiceId: 'voice-abc-123',
      settings: { speed: 1.0, stability: 0.7 },
    });
  });

  // ─── 2. Style ref resolution ─────────────────────────────────────────

  it('style ref resolution: style.$ref → description + negative returned', () => {
    const result = resolver.resolve(context, { kind: 'style', name: 'cinematic' }, 'stability-ai');

    expect(result).toEqual({
      description: 'Epic cinematic shot, dramatic lighting',
      negative: 'dull',
    });
  });

  it('style ref with no perProvider override falls back to top-level', () => {
    const result = resolver.resolve(
      context,
      { kind: 'style', name: 'cinematic' },
      'unknown-provider',
    );

    expect(result).toEqual({
      description: 'Cinematic, dramatic lighting, shallow depth of field',
      negative: 'flat, dull, boring',
    });
  });

  // ─── 3. Brand color ref ──────────────────────────────────────────────

  it('brand key ref: resolves to hex value', () => {
    const result = resolver.resolve(context, { kind: 'brand', key: 'primaryColor' }, '');

    expect(result).toBe('#FF5500');
  });

  it('brand key ref: unknown key returns undefined', () => {
    const result = resolver.resolve(context, { kind: 'brand', key: 'logoArtifactId' }, '');

    expect(result).toBe('logo-xyz');
  });

  // ─── 4. Unknown ref name → ContextRefUnknownError ────────────────────

  it('unknown voice ref name → ContextRefUnknownError', () => {
    expect(() =>
      resolver.resolve(context, { kind: 'voice', name: 'nonexistent' }, 'elevenlabs'),
    ).toThrow(ContextRefUnknownError);

    expect(() =>
      resolver.resolve(context, { kind: 'style', name: 'nope' }, 'stability-ai'),
    ).toThrow(ContextRefUnknownError);
  });

  // ─── 5. Type mismatch: style ref in audio.tts ────────────────────────

  it('ContextRefTypeError class exists and has correct shape', () => {
    const err = new ContextRefTypeError('audio.tts', 'style');

    expect(err).toBeInstanceOf(ContextRefTypeError);
    expect(err.code).toBe('CONTEXT_REF_TYPE_MISMATCH');
    expect(err.stepOp).toBe('audio.tts');
    expect(err.refKind).toBe('style');
  });

  it('ContextRefUnknownError class exists and has correct shape', () => {
    const err = new ContextRefUnknownError('style', 'nope');

    expect(err).toBeInstanceOf(ContextRefUnknownError);
    expect(err.code).toBe('CONTEXT_REF_UNKNOWN');
    expect(err.kind).toBe('style');
    expect(err.name).toBe('nope');
  });

  // ─── 6. No ref returns original inputs ───────────────────────────────

  it('no $ref in inputs → inputs returned unchanged', () => {
    const inputs = { prompt: 'hello', steps: 20, seed: 42 };
    const resolved = resolver.resolveInputs(inputs, context, 'stability-ai');

    expect(resolved).toEqual(inputs);
    expect(resolved).not.toBe(inputs); // should be a new object
  });

  it('mixed inputs with some $ref → refs resolved, literals unchanged', () => {
    const inputs = {
      prompt: 'A majestic mountain',
      style: { $ref: { kind: 'style', name: 'cinematic' } },
      seed: 42,
    };

    const resolved = resolver.resolveInputs(inputs, context, 'stability-ai');

    expect(resolved.prompt).toBe('A majestic mountain');
    expect(resolved.seed).toBe(42);
    expect(resolved.style).toEqual({
      description: 'Epic cinematic shot, dramatic lighting',
      negative: 'dull',
    });
  });

  it('brand ref in prompt → inline-replaced', () => {
    const inputs = {
      prompt: { $ref: { kind: 'brand', key: 'primaryColor' as const } },
    };

    const resolved = resolver.resolveInputs(inputs, context, '');
    expect(resolved.prompt).toBe('#FF5500');
  });

  // ─── 7. Plan F13 type-mismatch enforcement ───────────────────────────

  it('throws ContextRefTypeError when style ref appears in voice input position', () => {
    const inputs = {
      // wrong: style ref bound to the `voice` input key (an audio.tts input position).
      voice: { $ref: { kind: 'style', name: 'cinematic' } },
    };
    expect(() => resolver.resolveInputs(inputs, context, 'elevenlabs', 'audio.tts')).toThrow(
      ContextRefTypeError,
    );
  });

  it('throws ContextRefTypeError when voice ref appears in style input position', () => {
    const inputs = {
      style: { $ref: { kind: 'voice', name: 'narrator' } },
    };
    expect(() => resolver.resolveInputs(inputs, context, 'stability-ai', 'image.generate')).toThrow(
      ContextRefTypeError,
    );
  });

  it('accepts a correctly-typed voice ref in the voice input position', () => {
    const inputs = {
      voice: { $ref: { kind: 'voice', name: 'narrator' } },
    };
    const resolved = resolver.resolveInputs(inputs, context, 'elevenlabs', 'audio.tts');
    expect(resolved.voice).toMatchObject({ provider: 'elevenlabs', voiceId: 'voice-abc-123' });
  });
});
