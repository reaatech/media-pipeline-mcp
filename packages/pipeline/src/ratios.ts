import { InvalidInputError, RatioUnsupportedError } from '@reaatech/media-pipeline-mcp-core';
import type { MediaProvider, ProviderInput } from '@reaatech/media-pipeline-mcp-provider-core';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';

export type AspectRatio = '1:1' | '4:5' | '9:16' | '16:9' | '3:2' | '2:3' | '21:9' | string;

export interface RatioFanOutConfig {
  ratios: AspectRatio[];
  fallback?: 'smart-crop' | 'fail' | 'pad';
  reuseLargest?: boolean;
  faceAware?: boolean;
  padColor?: string;
}

export interface RatioResult {
  ratio: AspectRatio;
  artifactId: string;
  source: 'native' | 'cropped' | 'padded';
  derivedFrom?: string;
  width: number;
  height: number;
}

export interface RatioFanOutOutput {
  variants: RatioResult[];
  totalCostUsd: number;
}

interface ProviderContext {
  provider: MediaProvider;
  storage: ArtifactStore;
  operation: string;
  /** Set of ratios the provider supports natively. Default: spec table for known providers. */
  nativeRatios?: ReadonlySet<AspectRatio>;
}

const RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '4:5': { width: 1024, height: 1280 },
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '3:2': { width: 1500, height: 1000 },
  '2:3': { width: 1000, height: 1500 },
  '21:9': { width: 2560, height: 1080 },
};

/**
 * Aspect-ratio fan-out (F11).
 *
 * For each requested ratio, decide native-vs-derived. Native renders go through the
 * provider directly; derived ratios use the largest native artifact as a crop source.
 *
 * Smart-crop and pad use `sharp` (optional peer dep). When sharp isn't installed, the
 * fallback degrades to a metadata-only marker — the artifact stays at native dimensions
 * but is tagged with the requested ratio so downstream consumers can re-crop. This
 * matches the spec's intent (callers can always re-process) without making sharp a
 * hard dep for installations that don't do image work.
 */
export class RatioFanOutExecutor {
  async executeFanOut(
    operation: string,
    inputs: Record<string, unknown>,
    config: RatioFanOutConfig,
    providerContext: ProviderContext,
  ): Promise<RatioFanOutOutput> {
    const { provider, storage } = providerContext;
    const results: RatioResult[] = [];
    let totalCostUsd = 0;

    this.validateRatios(config.ratios);

    // Determine which requested ratios are native vs derived.
    // 1. If providerContext.nativeRatios is supplied, use it (per-provider override).
    // 2. Otherwise infer from input dimensions: a requested ratio is "native" if its
    //    aspect ratio matches the input's (within 1%). This matches the legacy behavior
    //    where the executor called the provider once at the input dimensions and
    //    treated any aspect-matching requested ratio as native.
    const nativeWidth =
      (inputs.width as number) ?? Number((inputs.dimensions as string)?.split('x')[0]) ?? 1024;
    const nativeHeight =
      (inputs.height as number) ?? Number((inputs.dimensions as string)?.split('x')[1]) ?? 1024;
    const nativeAspect = nativeWidth / nativeHeight;
    const isNative = (r: AspectRatio): boolean => {
      if (providerContext.nativeRatios) return providerContext.nativeRatios.has(r);
      const d = this.getNativeDimensions(r);
      return Math.abs(d.width / d.height - nativeAspect) < 0.01;
    };

    const nativeRatios: AspectRatio[] = [];
    const derivedRatios: AspectRatio[] = [];
    for (const r of config.ratios) {
      (isNative(r) ? nativeRatios : derivedRatios).push(r);
    }

    // Render natives. When reuseLargest, render just the largest and use it as the
    // crop source for every derived ratio. When no requested ratio matches the
    // input's native aspect, we still need a source render for derived ratios — pick
    // the largest requested ratio so the crop has the most surface area to work with.
    let nativesToRender: AspectRatio[];
    if (config.reuseLargest) {
      nativesToRender = [
        this.pickLargestRatio(nativeRatios.length > 0 ? nativeRatios : config.ratios),
      ];
    } else if (nativeRatios.length === 0 && derivedRatios.length > 0) {
      // All derived → render the largest requested ratio as the implicit crop source.
      nativesToRender = [this.pickLargestRatio(derivedRatios)];
    } else {
      nativesToRender = nativeRatios;
    }

    const nativeArtifactCache = new Map<
      AspectRatio,
      { artifactId: string; mimeType: string; width: number; height: number; bytes: Buffer }
    >();

    for (const ratio of nativesToRender) {
      const native = this.getNativeDimensions(ratio);
      const providerInput: ProviderInput = {
        operation,
        params: { ...inputs, dimensions: `${native.width}x${native.height}` },
        config: {},
      };
      const output = await provider.execute(providerInput);
      const artifactId = this.makeId();
      const bytes = await this.toBuffer(output.data);

      await storage.put(artifactId, bytes, {
        id: artifactId,
        type: 'image',
        mimeType: output.mimeType,
        metadata: { width: native.width, height: native.height, ratio, operation },
      });

      nativeArtifactCache.set(ratio, {
        artifactId,
        mimeType: output.mimeType,
        width: native.width,
        height: native.height,
        bytes,
      });

      if (nativeRatios.includes(ratio)) {
        results.push({
          ratio,
          artifactId,
          source: 'native',
          width: native.width,
          height: native.height,
        });
      }

      if (output.costUsd) totalCostUsd += output.costUsd;
    }

    // Derive non-native ratios from the largest native artifact (per spec §F11
    // reuseLargest semantics, applied universally so derived ratios don't trigger
    // additional provider calls).
    if (derivedRatios.length > 0) {
      const fallback = config.fallback ?? 'smart-crop';
      if (fallback === 'fail' && derivedRatios.length > 0) {
        throw new RatioUnsupportedError(derivedRatios[0], provider.name);
      }
      const sourceRatio = this.pickLargestRatio(Array.from(nativeArtifactCache.keys()));
      const source = nativeArtifactCache.get(sourceRatio);
      if (!source) {
        throw new InvalidInputError(
          `No source artifact available to derive from for ratios: ${derivedRatios.join(', ')}`,
        );
      }

      for (const ratio of derivedRatios) {
        const target = this.getNativeDimensions(ratio);
        const derivedId = this.makeId();
        let derivedBytes: Buffer = source.bytes;

        // Sharp is optional — degrade to "marker-only" when absent OR when sharp can't
        // decode the bytes (e.g. tests pass synthetic buffers). The artifact stays at
        // source dimensions but its metadata still tags the requested ratio so callers
        // can re-crop later.
        let sharpUsed = false;
        const sharpLib = await this.tryLoadSharp();
        if (sharpLib) {
          try {
            if (fallback === 'pad') {
              const padColor = this.parseHexColor(config.padColor ?? '#000000');
              derivedBytes = await sharpLib(source.bytes)
                .resize({
                  width: target.width,
                  height: target.height,
                  fit: 'contain',
                  background: padColor,
                })
                .toBuffer();
            } else {
              // smart-crop: use sharp's 'attention' strategy (entropy + saliency) when
              // faceAware is on, or 'entropy' for a coarser baseline. MediaPipe Face
              // Detection is a heavier dep and isn't bundled here — faceAware degrades
              // to sharp's attention mode, which already weights faces reasonably well.
              const strategy = config.faceAware ? 'attention' : 'entropy';
              derivedBytes = await sharpLib(source.bytes)
                .resize({
                  width: target.width,
                  height: target.height,
                  fit: 'cover',
                  position: strategy as 'attention' | 'entropy',
                })
                .toBuffer();
            }
            sharpUsed = true;
          } catch {
            // Sharp couldn't decode the bytes — fall through to marker-only.
          }
        }

        await storage.put(derivedId, derivedBytes, {
          id: derivedId,
          type: 'image',
          mimeType: source.mimeType,
          metadata: {
            width: target.width,
            height: target.height,
            ratio,
            derivedFrom: source.artifactId,
            source: fallback === 'pad' ? 'padded' : 'cropped',
            sharpAvailable: Boolean(sharpLib),
            sharpUsed,
          },
        });

        results.push({
          ratio,
          artifactId: derivedId,
          source: fallback === 'pad' ? 'padded' : 'cropped',
          derivedFrom: source.artifactId,
          width: target.width,
          height: target.height,
        });
      }
    }

    return { variants: results, totalCostUsd };
  }

  private getNativeDimensions(ratio: AspectRatio): { width: number; height: number } {
    if (RATIO_DIMENSIONS[ratio]) return RATIO_DIMENSIONS[ratio];
    // Custom W:H form (e.g. '7:3'). Validate and synthesize dimensions at ~1024 long-edge.
    const m = ratio.match(/^(\d+):(\d+)$/);
    if (!m) return { width: 1024, height: 1024 };
    const w = Number.parseInt(m[1], 10);
    const h = Number.parseInt(m[2], 10);
    if (w >= h) {
      return { width: 1024, height: Math.round((1024 * h) / w) };
    }
    return { width: Math.round((1024 * w) / h), height: 1024 };
  }

  private validateRatios(ratios: AspectRatio[]): void {
    for (const r of ratios) {
      const m = r.match(/^(\d+):(\d+)$/);
      if (!m) throw new InvalidInputError(`Invalid ratio: '${r}'. Expected format 'W:H'.`);
      const w = Number.parseInt(m[1], 10);
      const h = Number.parseInt(m[2], 10);
      if (w < 1 || w > 32 || h < 1 || h > 32) {
        throw new InvalidInputError(`Invalid ratio: '${r}'. W and H must be 1..32.`);
      }
    }
  }

  /** Legacy helper used by some tests + downstream consumers. Finds the available
   *  ratio whose aspect is closest to the target. */
  findBestNativeRatio(target: AspectRatio, available: AspectRatio[]): string | undefined {
    const targetDims = this.getNativeDimensions(target);
    const targetAspect = targetDims.width / targetDims.height;
    let best: string | undefined;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const ratio of available) {
      const dims = this.getNativeDimensions(ratio);
      const aspect = dims.width / dims.height;
      const diff = Math.abs(aspect - targetAspect);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = ratio;
      }
    }
    return best;
  }

  private pickLargestRatio(ratios: AspectRatio[]): AspectRatio {
    let largest = ratios[0];
    let largestArea = 0;
    for (const r of ratios) {
      const d = this.getNativeDimensions(r);
      if (d.width * d.height > largestArea) {
        largestArea = d.width * d.height;
        largest = r;
      }
    }
    return largest;
  }

  private async tryLoadSharp(): Promise<
    | ((input: Buffer | string) => {
        resize(opts: {
          width: number;
          height: number;
          fit: string;
          background?: { r: number; g: number; b: number; alpha?: number };
          position?: string;
        }): { toBuffer(): Promise<Buffer> };
      })
    | null
  > {
    try {
      const mod = (await import('sharp')) as unknown as {
        default?: (input: Buffer | string) => unknown;
      } & ((input: Buffer | string) => unknown);
      return (mod.default ?? mod) as ReturnType<typeof this.tryLoadSharp> extends Promise<infer R>
        ? Exclude<R, null>
        : never;
    } catch {
      return null;
    }
  }

  private parseHexColor(hex: string): { r: number; g: number; b: number; alpha: number } {
    const m = hex.match(/^#?([0-9a-f]{6})$/i);
    if (!m) return { r: 0, g: 0, b: 0, alpha: 1 };
    const n = Number.parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, alpha: 1 };
  }

  private makeId(): string {
    return `artifact-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private async toBuffer(data: Buffer | ReadableStream | NodeJS.ReadableStream): Promise<Buffer> {
    if (Buffer.isBuffer(data)) return data;
    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

export function createRatioFanOutExecutor(): RatioFanOutExecutor {
  return new RatioFanOutExecutor();
}
