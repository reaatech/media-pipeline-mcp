import type { ContextRef, RunContext } from '@reaatech/media-pipeline-mcp-core';
import { ContextRefTypeError, ContextRefUnknownError } from '@reaatech/media-pipeline-mcp-core';

/**
 * Expected ref kind by input key. Plan §F13 table:
 *   - `voice` in `audio.tts`        → kind 'voice'
 *   - `style` in `image.generate`   → kind 'style'
 *   - `brand.<key>` inline          → kind 'brand'
 *
 * Resolution time enforcement: a `style` ref used in a `voice` input position (or
 * vice versa) throws `ContextRefTypeError` with the offending op + ref kind.
 */
const INPUT_KEY_EXPECTED_REF_KIND: Record<string, ContextRef['kind']> = {
  voice: 'voice',
  style: 'style',
  negative_style: 'style',
};

export class ContextResolver {
  resolve(context: RunContext, ref: ContextRef, provider: string): unknown {
    switch (ref.kind) {
      case 'voice': {
        const voice = context.voices?.[ref.name];
        if (!voice) throw new ContextRefUnknownError('voice', ref.name);
        return { provider: voice.provider, voiceId: voice.voiceId, settings: voice.settings };
      }
      case 'style': {
        const style = context.styles?.[ref.name];
        if (!style) throw new ContextRefUnknownError('style', ref.name);
        const perProvider = style.perProvider?.[provider];
        return {
          description: perProvider?.description ?? style.description,
          negative: perProvider?.negative ?? style.negative,
        };
      }
      case 'brand': {
        return (context.brandKit as Record<string, unknown>)?.[ref.key];
      }
    }
  }

  /**
   * Resolve top-level `$ref` values in step inputs. When `operation` is provided
   * and a specific input key has a declared expected ref kind (e.g., `voice` must
   * carry a voice ref), a mismatch throws `ContextRefTypeError(operation, refKind)`
   * before the value reaches the provider.
   */
  resolveInputs(
    inputs: Record<string, unknown>,
    context: RunContext,
    provider: string,
    operation?: string,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputs)) {
      if (value && typeof value === 'object' && '$ref' in (value as Record<string, unknown>)) {
        const ref = (value as { $ref: ContextRef }).$ref;
        const expected = INPUT_KEY_EXPECTED_REF_KIND[key];
        if (expected && ref.kind !== expected) {
          throw new ContextRefTypeError(operation ?? '<unknown-op>', ref.kind);
        }
        resolved[key] = this.resolve(context, ref, provider);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
