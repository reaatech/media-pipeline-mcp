import { SafetyProviderUnavailableError } from '@reaatech/media-pipeline-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafetyGateEvaluator } from '../gates/safety.js';
import type { SafetyArtifact, SafetyCategory, SafetyClassifier } from '../gates/safety.js';

/**
 * Test helper: a stub classifier whose scores are controlled per-test.
 * Returns the configured scores for any artifact passed in.
 */
function stubClassifier(
  scores: Partial<Record<SafetyCategory, number>>,
  opts: { model?: string; costUsd?: number } = {},
): SafetyClassifier {
  return {
    classify: vi.fn(async (_artifact: SafetyArtifact) => ({
      perCategoryScores: scores,
      costUsd: opts.costUsd ?? 0,
      model: opts.model ?? 'stub-model',
    })),
  };
}

/** Build an evaluator pre-wired with classifiers for the providers a test exercises. */
function evaluatorWith(classifiers: Record<string, SafetyClassifier>): SafetyGateEvaluator {
  const map = new Map<string, SafetyClassifier>();
  for (const [provider, c] of Object.entries(classifiers)) map.set(provider, c);
  return new SafetyGateEvaluator({ classifiers: map });
}

describe('SafetyGateEvaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('safe content passes — blocked = false', async () => {
    const evaluator = evaluatorWith({
      openai: stubClassifier({}, { model: 'omni-moderation-latest' }),
    });

    const result = await evaluator.evaluate({ id: 'test-1', type: 'text' }, { type: 'safety' });

    expect(result.blocked).toBe(false);
    expect(result.perCategoryScores).toEqual({});
    expect(result.category).toBeUndefined();
  });

  it('throws SafetyProviderUnavailableError when no classifier is registered for the provider', async () => {
    const evaluator = new SafetyGateEvaluator();
    await expect(evaluator.evaluate({ id: 'x', type: 'text' }, { type: 'safety' })).rejects.toThrow(
      SafetyProviderUnavailableError,
    );
  });

  it('blocked text: hate speech → blocked with category=hate', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ hate: 0.92, violence: 0.1 }) });

    const result = await evaluator.evaluate(
      { id: 'test-2', type: 'text' },
      { type: 'safety', block: ['hate', 'violence'] },
    );

    expect(result.blocked).toBe(true);
    expect(result.category).toBe('hate');
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  it('CSAM unconditional fail: csam > 0 always fails even with action=warn', async () => {
    const evaluator = evaluatorWith({ replicate: stubClassifier({ csam: 0.6 }) });

    const result = await evaluator.evaluate(
      { id: 'test-3', type: 'image' },
      { type: 'safety', action: 'warn' },
    );

    expect(result.blocked).toBe(true);
    expect(result.category).toBe('csam');
    expect(result.action).toBe('fail');
  });

  it('action=warn: borderline content → flagged but action is warn', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ violence: 0.75 }) });

    const result = await evaluator.evaluate(
      { id: 'test-4', type: 'text' },
      { type: 'safety', block: ['violence'], action: 'warn' },
    );

    expect(result.blocked).toBe(true);
    expect(result.action).toBe('warn');
    expect(result.category).toBe('violence');
  });

  it('default thresholds: category above 0.5 (default) → blocked', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ harassment: 0.6 }) });

    const result = await evaluator.evaluate(
      { id: 'test-5', type: 'text' },
      { type: 'safety', block: ['harassment'] },
    );

    expect(result.blocked).toBe(true);
    expect(result.category).toBe('harassment');
  });

  it('per-provider defaults: text→openai, image→replicate, audio→google', async () => {
    const evaluator = evaluatorWith({
      openai: stubClassifier({}, { model: 'omni-moderation-latest' }),
      replicate: stubClassifier({}, { model: 'falcons-ai/nsfw_image_detection' }),
      google: stubClassifier({}, { model: 'cnl-moderation' }),
    });

    const textResult = await evaluator.evaluate({ id: 't1', type: 'text' }, { type: 'safety' });
    expect(textResult.provider).toBe('openai');
    expect(textResult.model).toBe('omni-moderation-latest');

    const imageResult = await evaluator.evaluate({ id: 'i1', type: 'image' }, { type: 'safety' });
    expect(imageResult.provider).toBe('replicate');
    expect(imageResult.model).toBe('falcons-ai/nsfw_image_detection');

    const audioResult = await evaluator.evaluate({ id: 'a1', type: 'audio' }, { type: 'safety' });
    expect(audioResult.provider).toBe('google');

    const videoResult = await evaluator.evaluate({ id: 'v1', type: 'video' }, { type: 'safety' });
    expect(videoResult.provider).toBe('replicate');
  });

  it('cost recorded: any verdict has costUsd >= 0', async () => {
    const evaluator = evaluatorWith({
      openai: stubClassifier({}, { costUsd: 0.0001 }),
    });

    const result = await evaluator.evaluate({ id: 'test-7', type: 'text' }, { type: 'safety' });

    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('block=all: all default categories checked', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ violence: 0.9 }) });

    const result = await evaluator.evaluate(
      { id: 'test-all', type: 'text' },
      { type: 'safety', block: 'all' },
    );

    expect(result.blocked).toBe(true);
    expect(result.category).toBe('violence');
  });

  it('threshold overrides: custom threshold bypasses default 0.5', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ hate: 0.6, violence: 0.4 }) });

    const result = await evaluator.evaluate(
      { id: 'test-threshold', type: 'text' },
      { type: 'safety', block: ['hate', 'violence'], thresholds: { hate: 0.7, violence: 0.3 } },
    );

    // hate 0.6 < threshold 0.7 → not blocked
    // violence 0.4 > threshold 0.3 → blocked as violence
    expect(result.blocked).toBe(true);
    expect(result.category).toBe('violence');
  });

  it('action=redact: flagged content uses redact action', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({ hate: 0.8 }) });

    const result = await evaluator.evaluate(
      { id: 'test-redact', type: 'text' },
      { type: 'safety', block: ['hate'], action: 'redact' },
    );

    expect(result.blocked).toBe(true);
    expect(result.action).toBe('redact');
  });

  it('skipDownstreamOfModeratedText flag is accepted in gate config', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({}) });

    const result = await evaluator.evaluate(
      { id: 'test-skip', type: 'text' },
      { type: 'safety', skipDownstreamOfModeratedText: true },
    );

    expect(result.blocked).toBe(false);
  });

  it('provider override: explicit provider used instead of default', async () => {
    const evaluator = evaluatorWith({ google: stubClassifier({}, { model: 'cnl-moderation' }) });

    const result = await evaluator.evaluate(
      { id: 'test-provider', type: 'text' },
      { type: 'safety', provider: 'google' },
    );

    expect(result.provider).toBe('google');
  });

  it('each safety category can be checked individually', async () => {
    const categories: SafetyCategory[] = [
      'sexual',
      'sexual/minors',
      'hate',
      'harassment',
      'self-harm',
      'violence',
      'graphic-violence',
      'illegal',
      'pii',
      'misinformation',
    ];

    for (const cat of categories) {
      const evaluator = evaluatorWith({ openai: stubClassifier({ [cat]: 0.95 }) });

      const result = await evaluator.evaluate(
        { id: `test-${cat}`, type: 'text' },
        { type: 'safety', block: [cat] },
      );

      expect(result.blocked).toBe(true);
      expect(result.category).toBe(cat);
    }
  });

  it('model override: classifier model is reported in the verdict', async () => {
    const evaluator = evaluatorWith({
      openai: stubClassifier({}, { model: 'omni-moderation-latest' }),
    });

    const result = await evaluator.evaluate({ id: 'test-model', type: 'text' }, { type: 'safety' });

    // The verdict reports the model the classifier returned, not the gate config's
    // requested model. Gate `model` is a hint to the classifier; the classifier's
    // returned model is the source of truth for audit.
    expect(result.model).toBe('omni-moderation-latest');
  });

  it('default provider for unknown type uses openai', async () => {
    const evaluator = evaluatorWith({ openai: stubClassifier({}) });
    const defaultProvider = (
      evaluator as unknown as { defaultProvider(type: string): string }
    ).defaultProvider('unknown-type');
    expect(defaultProvider).toBe('openai');
  });

  it('audit hook fires on every verdict', async () => {
    const auditLog = vi.fn();
    const evaluator = new SafetyGateEvaluator({
      classifiers: new Map([['openai', stubClassifier({})]]),
      auditLog,
    });

    await evaluator.evaluate({ id: 'audit-1', type: 'text' }, { type: 'safety' });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false, provider: 'openai' }),
      'audit-1',
    );
  });

  it('classifier failure surfaces as SafetyProviderUnavailableError', async () => {
    const evaluator = evaluatorWith({
      openai: {
        classify: vi.fn(async () => {
          throw new Error('API quota exhausted');
        }),
      },
    });

    await expect(
      evaluator.evaluate({ id: 'fail', type: 'text' }, { type: 'safety' }),
    ).rejects.toThrow(SafetyProviderUnavailableError);
  });
});
