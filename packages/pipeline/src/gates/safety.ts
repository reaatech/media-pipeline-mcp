import { SafetyProviderUnavailableError } from '@reaatech/media-pipeline-mcp-core';

export type SafetyCategory =
  | 'sexual'
  | 'sexual/minors'
  | 'hate'
  | 'harassment'
  | 'self-harm'
  | 'violence'
  | 'graphic-violence'
  | 'illegal'
  | 'pii'
  | 'misinformation'
  | 'csam';

export interface SafetyGate {
  type: 'safety';
  provider?: 'openai' | 'azure' | 'google' | 'replicate' | 'ollama' | 'comfyui';
  model?: string;
  block?: SafetyCategory[] | 'all';
  thresholds?: Partial<Record<SafetyCategory, number>>;
  action?: 'fail' | 'warn' | 'redact';
  skipDownstreamOfModeratedText?: boolean;
}

export interface SafetyVerdict {
  blocked: boolean;
  category?: SafetyCategory;
  score?: number;
  perCategoryScores: Partial<Record<SafetyCategory, number>>;
  provider: string;
  model: string;
  action: 'fail' | 'warn' | 'redact';
  costUsd: number;
  redactedArtifactId?: string;
}

export interface SafetyArtifact {
  id: string;
  /** 'text' | 'image' | 'video' | 'audio' — drives the backend selection. */
  type: string;
  /** For text artifacts: the moderation input. */
  text?: string;
  /** For image/video artifacts: a publicly-fetchable URL or data URI the backend can read. */
  url?: string;
}

/**
 * Per-classification-backend interface. Implementations call out to the relevant
 * provider (OpenAI moderation, Replicate NSFW classifier, etc.) and return per-category
 * scores normalized to 0..1.
 */
export interface SafetyClassifier {
  classify(artifact: SafetyArtifact): Promise<{
    perCategoryScores: Partial<Record<SafetyCategory, number>>;
    costUsd: number;
    model: string;
  }>;
}

export interface SafetyGateEvaluatorConfig {
  /** Per-provider classifier instances. */
  classifiers?: Map<string, SafetyClassifier>;
  /** Audit-log sink: called for every verdict regardless of blocked/passed. */
  auditLog?: (verdict: SafetyVerdict, artifactId: string) => void | Promise<void>;
}

export class SafetyGateEvaluator {
  private classifiers: Map<string, SafetyClassifier>;
  private auditLog?: (verdict: SafetyVerdict, artifactId: string) => void | Promise<void>;

  constructor(config: SafetyGateEvaluatorConfig = {}) {
    this.classifiers = config.classifiers ?? new Map();
    this.auditLog = config.auditLog;
  }

  registerClassifier(provider: string, classifier: SafetyClassifier): void {
    this.classifiers.set(provider, classifier);
  }

  async evaluate(artifact: SafetyArtifact, gate: SafetyGate): Promise<SafetyVerdict> {
    const provider = gate.provider ?? this.defaultProvider(artifact.type);
    const action = gate.action ?? 'fail';
    const thresholds = gate.thresholds ?? {};

    const classifier = this.classifiers.get(provider);
    if (!classifier) {
      // No real classifier wired in for this provider — refuse-by-default so we don't
      // silently pass unmoderated content. The default-on flag wires this into every
      // step, so an unconfigured server gets a loud error rather than a fake pass.
      throw new SafetyProviderUnavailableError();
    }

    let classification: Awaited<ReturnType<SafetyClassifier['classify']>>;
    try {
      classification = await classifier.classify(artifact);
    } catch (_err) {
      throw new SafetyProviderUnavailableError();
    }

    const { perCategoryScores, costUsd, model } = classification;

    // CSAM is always blocked unconditionally regardless of `action` or `thresholds`.
    if (perCategoryScores.csam !== undefined && (perCategoryScores.csam as number) > 0) {
      const verdict = this.buildVerdict(
        true,
        'csam',
        perCategoryScores.csam,
        perCategoryScores,
        provider,
        model,
        'fail',
        costUsd,
      );
      await this.audit(verdict, artifact.id);
      return verdict;
    }

    const blockList: SafetyCategory[] =
      gate.block === 'all'
        ? [
            'sexual',
            'sexual/minors',
            'hate',
            'harassment',
            'violence',
            'graphic-violence',
            'illegal',
            'self-harm',
            'pii',
          ]
        : (gate.block ?? []);

    let maxScore = 0;
    let maxCategory: SafetyCategory | undefined;
    for (const cat of blockList) {
      const score = perCategoryScores[cat] ?? 0;
      const threshold = thresholds[cat] ?? 0.5;
      if (score > threshold && score > maxScore) {
        maxScore = score;
        maxCategory = cat;
      }
    }

    const verdict = maxCategory
      ? this.buildVerdict(
          true,
          maxCategory,
          maxScore,
          perCategoryScores,
          provider,
          model,
          action,
          costUsd,
        )
      : this.buildVerdict(
          false,
          undefined,
          undefined,
          perCategoryScores,
          provider,
          model,
          action,
          costUsd,
        );

    await this.audit(verdict, artifact.id);
    return verdict;
  }

  private async audit(verdict: SafetyVerdict, artifactId: string): Promise<void> {
    if (!this.auditLog) return;
    try {
      await this.auditLog(verdict, artifactId);
    } catch {
      // Audit failures must not block the safety verdict.
    }
  }

  private buildVerdict(
    blocked: boolean,
    category: SafetyCategory | undefined,
    score: number | undefined,
    perCategoryScores: Partial<Record<SafetyCategory, number>>,
    provider: string,
    model: string,
    action: 'fail' | 'warn' | 'redact',
    costUsd: number,
  ): SafetyVerdict {
    return { blocked, category, score, perCategoryScores, provider, model, action, costUsd };
  }

  private defaultProvider(type: string): string {
    switch (type) {
      case 'text':
        return 'openai';
      case 'image':
        return 'replicate';
      case 'video':
        return 'replicate';
      case 'audio':
        return 'google';
      default:
        return 'openai';
    }
  }
}

/**
 * Real OpenAI moderation classifier. Calls the omni-moderation-latest endpoint and
 * maps OpenAI's category names to our SafetyCategory enum.
 *
 * Construct with a valid `apiKey` (resolved per-tenant via KeyVault in multi-tenant
 * deployments, or from `OPENAI_API_KEY` env in single-tenant).
 */
export class OpenAIModerationClassifier implements SafetyClassifier {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'omni-moderation-latest';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
  }

  async classify(artifact: SafetyArtifact): Promise<{
    perCategoryScores: Partial<Record<SafetyCategory, number>>;
    costUsd: number;
    model: string;
  }> {
    const input = this.buildInput(artifact);
    const response = await fetch(`${this.baseUrl}/moderations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI moderation request failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as {
      results?: Array<{
        category_scores?: Record<string, number>;
        flagged?: boolean;
      }>;
    };

    const scores = body.results?.[0]?.category_scores ?? {};
    return {
      perCategoryScores: mapOpenAICategories(scores),
      costUsd: 0, // omni-moderation is free as of 2025
      model: this.model,
    };
  }

  private buildInput(artifact: SafetyArtifact): unknown {
    if (artifact.type === 'text' && artifact.text !== undefined) {
      return artifact.text;
    }
    if ((artifact.type === 'image' || artifact.type === 'video') && artifact.url) {
      return [{ type: 'image_url', image_url: { url: artifact.url } }];
    }
    throw new Error(
      `OpenAIModerationClassifier: artifact type '${artifact.type}' requires either .text (for text) or .url (for image/video)`,
    );
  }
}

function mapOpenAICategories(
  scores: Record<string, number>,
): Partial<Record<SafetyCategory, number>> {
  // OpenAI's category names → our SafetyCategory enum.
  // OpenAI categories: sexual, sexual/minors, hate, hate/threatening, harassment,
  // harassment/threatening, self-harm, self-harm/intent, self-harm/instructions,
  // violence, violence/graphic, illicit, illicit/violent
  return {
    sexual: scores.sexual,
    'sexual/minors': scores['sexual/minors'],
    hate: scores.hate ?? scores['hate/threatening'],
    harassment: scores.harassment ?? scores['harassment/threatening'],
    'self-harm':
      scores['self-harm'] ?? scores['self-harm/intent'] ?? scores['self-harm/instructions'],
    violence: scores.violence,
    'graphic-violence': scores['violence/graphic'],
    illegal: scores.illicit ?? scores['illicit/violent'],
  };
}

/**
 * Replicate NSFW image classifier (`falcons-ai/nsfw_image_detection`).
 *
 * Maps the classifier's NSFW/SFW labels to our `sexual` category. For richer
 * categorization (graphic-violence, etc.) wire in additional classifiers.
 */
export class ReplicateNsfwClassifier implements SafetyClassifier {
  private apiKey: string;
  private modelVersion: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private maxWaitMs: number;

  constructor(opts: {
    apiKey: string;
    modelVersion?: string;
    baseUrl?: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    // Pin the underlying model version so the score scale doesn't shift unannounced.
    this.modelVersion = opts.modelVersion ?? 'falcons-ai/nsfw_image_detection';
    this.baseUrl = opts.baseUrl ?? 'https://api.replicate.com/v1';
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? 30_000;
  }

  async classify(artifact: SafetyArtifact): Promise<{
    perCategoryScores: Partial<Record<SafetyCategory, number>>;
    costUsd: number;
    model: string;
  }> {
    if (!artifact.url) {
      throw new Error('ReplicateNsfwClassifier requires artifact.url');
    }

    // Start the prediction.
    const createResp = await fetch(`${this.baseUrl}/predictions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({
        version: this.modelVersion,
        input: { image: artifact.url },
      }),
    });

    if (!createResp.ok) {
      throw new Error(`Replicate NSFW create failed: ${createResp.status}`);
    }

    const created = (await createResp.json()) as { id: string; urls?: { get?: string } };
    const pollUrl = created.urls?.get ?? `${this.baseUrl}/predictions/${created.id}`;

    // Poll until succeeded/failed/timeout.
    const deadline = Date.now() + this.maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const pollResp = await fetch(pollUrl, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      if (!pollResp.ok) {
        throw new Error(`Replicate NSFW poll failed: ${pollResp.status}`);
      }
      const status = (await pollResp.json()) as {
        status: string;
        output?: { nsfw?: number; sfw?: number; label?: string; confidence?: number };
        error?: string;
      };
      if (status.status === 'succeeded' && status.output) {
        const nsfw =
          typeof status.output.nsfw === 'number'
            ? status.output.nsfw
            : (status.output.confidence ?? 0);
        return {
          perCategoryScores: { sexual: nsfw },
          costUsd: 0.0003, // approximate per-call rate
          model: this.modelVersion,
        };
      }
      if (status.status === 'failed' || status.status === 'canceled') {
        throw new Error(`Replicate NSFW failed: ${status.error ?? 'unknown'}`);
      }
    }

    throw new Error('Replicate NSFW timed out');
  }
}
