import type { CostLedger, PipelineEvent } from '@reaatech/media-pipeline-mcp-core';
import type { ProvenanceConfig } from '@reaatech/media-pipeline-mcp-provenance';
import type { StorageConfig } from '@reaatech/media-pipeline-mcp-storage';
import { z } from 'zod';
import type { MultiTenantConfig } from './tenant-context.js';

export type { MultiTenantConfig } from './tenant-context.js';

// ─── Runtime-only interfaces (not serialized) ───────────────────────────────

/**
 * Backing store for the idempotency cache (F1). Generic key/value with optional
 * findByExternalJobId for webhook lookup. This is NOT the pipeline run state store —
 * for that, see `PipelineStateStore` from `@reaatech/media-pipeline-mcp-persistence`.
 *
 * Renamed from the previous `PipelineStateStore` (which conflicted with the canonical
 * type from persistence). The `pipelineStateStore` config slot below remains for
 * backwards compatibility but accepts this idempotency-shaped store.
 */
export interface IdempotencyKVStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  findByExternalJobId(externalJobId: string): Promise<Array<{ id: string; state: unknown }>>;
}

/** @deprecated Renamed to IdempotencyKVStore. The pipeline run state store lives in @reaatech/media-pipeline-mcp-persistence. */
export type PipelineStateStore = IdempotencyKVStore;

export interface EventBus<T> {
  subscribe(pattern: string, handler: (event: T) => void): () => void;
  publish(event: T): void;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface FeaturesConfig {
  idempotency: boolean;
  contentCache: boolean;
  resumablePipelines: boolean;
  budgetCaps: boolean;
  dryRun: boolean;
  streaming: boolean;
  webhooks: boolean;
  routing: boolean;
  variants: boolean;
  subtitles: boolean;
  runContext: boolean;
  batch: boolean;
  safetyGate: boolean;
  provenance: boolean;
  multiTenant: boolean;
  mcpResources: boolean;
  sttStream: boolean;
}

const FeaturesConfigSchema = z.object({
  idempotency: z.boolean().default(true),
  contentCache: z.boolean().default(false),
  resumablePipelines: z.boolean().default(false),
  budgetCaps: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  streaming: z.boolean().default(false),
  webhooks: z.boolean().default(false),
  routing: z.boolean().default(false),
  variants: z.boolean().default(false),
  subtitles: z.boolean().default(false),
  runContext: z.boolean().default(true),
  batch: z.boolean().default(false),
  // Default OFF until operators register a classifier — the gate now throws when
  // enabled but no SafetyClassifier is wired (was a silent no-op before). Flip to
  // true after wiring OpenAIModerationClassifier (or another) via SafetyGateEvaluator.
  safetyGate: z.boolean().default(false),
  provenance: z.boolean().default(false),
  mcpResources: z.boolean().default(false),
  multiTenant: z.boolean().default(false),
  sttStream: z.boolean().default(false),
});

// Configuration schema
const StorageConfigSchema: z.ZodType<StorageConfig> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    config: z.object({
      basePath: z
        .string()
        .refine((val) => !val.includes('..') && !val.includes('\\') && !val.startsWith('/'), {
          message: 'basePath cannot contain path traversal characters or be absolute',
        }),
      ttl: z.number().optional(),
      serveHttp: z.boolean().optional(),
      httpPort: z.number().optional(),
      httpHost: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('s3'),
    config: z.object({
      bucket: z.string(),
      region: z.string(),
      prefix: z.string().optional(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      endpoint: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('gcs'),
    config: z.object({
      bucket: z.string(),
      prefix: z.string().optional(),
      projectId: z.string().optional(),
      keyFilename: z.string().optional(),
    }),
  }),
]);

const AuthConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    jwtSecret: z.string().min(32).optional(),
    apiKeys: z
      .array(
        z.object({
          key: z.string(),
          userId: z.string(),
          permissions: z.array(z.string()),
        }),
      )
      .optional(),
  })
  .refine(
    (config) =>
      !config.enabled ||
      (config.jwtSecret && config.jwtSecret.length >= 32) ||
      (config.apiKeys && config.apiKeys.length > 0),
    { message: 'When auth is enabled, either jwtSecret (min 32 chars) or apiKeys is required' },
  );

export const ServerConfigSchema = z.object({
  port: z.number().default(8080),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  storage: StorageConfigSchema,
  providers: z
    .array(
      z.object({
        name: z.string(),
        operations: z.array(z.string()),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  auth: AuthConfigSchema.optional(),
  rateLimit: z
    .object({
      enabled: z.boolean().default(true),
      clientRequestsPerMinute: z.number().default(60),
      clientBurstSize: z.number().default(10),
      expensiveOperationsPerMinute: z.number().default(10),
    })
    .optional(),
  budget: z
    .object({
      dailyLimit: z.number().optional(),
      monthlyLimit: z.number().optional(),
      perPipelineLimit: z.number().optional(),
      alertThreshold: z.number().min(0).max(1).default(0.9),
    })
    .optional(),
  features: FeaturesConfigSchema.optional(),
  webhookBaseUrl: z.string().url().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema> & {
  pipelineStateStore?: PipelineStateStore;
  costLedger?: CostLedger;
  eventBus?: EventBus<PipelineEvent>;
  provenanceConfig?: ProvenanceConfig;
  /** F18: multi-tenant key vault + tenant resolver. When enabled, every request resolves
   *  a TenantContext before tool dispatch and the resolved context flows through
   *  AsyncLocalStorage to the provider factory, cost ledger, resource handler, etc. */
  multiTenant?: MultiTenantConfig;
};

export function loadConfig(env?: NodeJS.ProcessEnv): ServerConfig {
  const environment = env || process.env;

  // Build storage config from environment
  const storageType = (environment.STORAGE_TYPE as 'local' | 's3' | 'gcs') || 'local';

  let storageConfig: StorageConfig;

  switch (storageType) {
    case 's3':
      storageConfig = {
        type: 's3',
        config: {
          bucket: environment.S3_BUCKET || 'media-artifacts',
          region: environment.S3_REGION || 'us-east-1',
          prefix: environment.S3_PREFIX || 'artifacts/',
        },
      };
      break;

    case 'gcs':
      storageConfig = {
        type: 'gcs',
        config: {
          bucket: environment.GCS_BUCKET || 'media-artifacts',
          prefix: environment.GCS_PREFIX || 'artifacts/',
        },
      };
      break;
    default:
      storageConfig = {
        type: 'local',
        config: {
          basePath: environment.STORAGE_PATH || './artifacts',
          ttl: environment.STORAGE_TTL
            ? Number.parseInt(environment.STORAGE_TTL, 10) * 1000
            : undefined,
          serveHttp: environment.STORAGE_SERVE_HTTP === 'true',
        },
      };
      break;
  }

  const features: FeaturesConfig = {
    idempotency: environment.FEATURE_IDEMPOTENCY !== 'false',
    contentCache: environment.FEATURE_CONTENT_CACHE === 'true',
    resumablePipelines: environment.FEATURE_RESUMABLE_PIPELINES === 'true',
    budgetCaps: environment.FEATURE_BUDGET_CAPS !== 'false',
    dryRun: environment.FEATURE_DRY_RUN !== 'false',
    streaming: environment.FEATURE_STREAMING === 'true',
    webhooks: environment.FEATURE_WEBHOOKS === 'true',
    routing: environment.FEATURE_ROUTING === 'true',
    variants: environment.FEATURE_VARIANTS === 'true',
    subtitles: environment.FEATURE_SUBTITLES === 'true',
    runContext: environment.FEATURE_RUN_CONTEXT !== 'false',
    batch: environment.FEATURE_BATCH === 'true',
    safetyGate: environment.FEATURE_SAFETY_GATE !== 'false',
    provenance: environment.FEATURE_PROVENANCE === 'true',
    mcpResources: environment.FEATURE_MCP_RESOURCES === 'true',
    multiTenant: environment.FEATURE_MULTI_TENANT === 'true',
    sttStream: environment.FEATURE_STT_STREAM === 'true',
  };

  const config: ServerConfig = {
    port: Number.parseInt(environment.PORT || '8080', 10),
    host: environment.HOST || '0.0.0.0',
    logLevel: (environment.LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug') || 'info',
    storage: storageConfig,
    features: Object.values(features).some(Boolean) ? features : undefined,
    webhookBaseUrl: environment.WEBHOOK_BASE_URL || undefined,
    providers: [
      ...(environment.OPENAI_API_KEY
        ? [
            {
              name: 'openai',
              operations: ['image.generate', 'audio.tts', 'audio.stt', 'image.describe'],
            },
          ]
        : []),
      ...(environment.STABILITY_API_KEY
        ? [{ name: 'stability', operations: ['image.generate', 'image.inpaint'] }]
        : []),
      ...(environment.REPLICATE_API_KEY
        ? [
            {
              name: 'replicate',
              operations: [
                'image.generate',
                'image.upscale',
                'image.remove_background',
                'video.generate',
              ],
            },
          ]
        : []),
      ...(environment.FAL_API_KEY
        ? [
            {
              name: 'fal',
              operations: ['image.generate', 'image.upscale', 'image.remove_background'],
            },
          ]
        : []),
      ...(environment.ELEVENLABS_API_KEY
        ? [{ name: 'elevenlabs', operations: ['audio.tts'] }]
        : []),
      ...(environment.DEEPGRAM_API_KEY
        ? [{ name: 'deepgram', operations: ['audio.stt', 'audio.diarize'] }]
        : []),
      ...(environment.ANTHROPIC_API_KEY
        ? [
            {
              name: 'anthropic',
              operations: [
                'image.describe',
                'document.ocr',
                'document.extract_tables',
                'document.extract_fields',
                'document.summarize',
              ],
            },
          ]
        : []),
      ...(environment.GOOGLE_PROJECT_ID
        ? [
            {
              name: 'google',
              operations: [
                'document.ocr',
                'document.extract_tables',
                'document.extract_fields',
                'image.describe',
              ],
              config: {
                projectId: environment.GOOGLE_PROJECT_ID,
                location: environment.GOOGLE_LOCATION,
                documentAiProcessorId: environment.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
                geminiModel: environment.GOOGLE_GEMINI_MODEL,
                keyFile: environment.GOOGLE_KEY_FILE || environment.GOOGLE_APPLICATION_CREDENTIALS,
              },
            },
          ]
        : []),
    ],
    auth:
      environment.AUTH_ENABLED === 'true'
        ? {
            enabled: true,
            jwtSecret: environment.JWT_SECRET,
            apiKeys: environment.API_KEYS?.split(',').map((key) => ({
              key,
              userId: `user-${key.substring(0, 8)}`,
              permissions: ['pipeline:run', 'artifact:read', 'artifact:write', 'cost:read'],
            })),
          }
        : undefined,
    rateLimit:
      environment.RATE_LIMIT_ENABLED !== 'false'
        ? {
            enabled: true,
            clientRequestsPerMinute: Number.parseInt(environment.RATE_LIMIT_RPM || '60', 10),
            clientBurstSize: Number.parseInt(environment.RATE_LIMIT_BURST || '10', 10),
            expensiveOperationsPerMinute: Number.parseInt(
              environment.EXPENSIVE_OPS_RPM || '10',
              10,
            ),
          }
        : undefined,
    budget:
      environment.BUDGET_DAILY_LIMIT || environment.BUDGET_MONTHLY_LIMIT
        ? {
            dailyLimit: environment.BUDGET_DAILY_LIMIT
              ? Number.parseFloat(environment.BUDGET_DAILY_LIMIT)
              : undefined,
            monthlyLimit: environment.BUDGET_MONTHLY_LIMIT
              ? Number.parseFloat(environment.BUDGET_MONTHLY_LIMIT)
              : undefined,
            perPipelineLimit: environment.BUDGET_PER_PIPELINE_LIMIT
              ? Number.parseFloat(environment.BUDGET_PER_PIPELINE_LIMIT)
              : undefined,
            alertThreshold: environment.BUDGET_ALERT_THRESHOLD
              ? Number.parseFloat(environment.BUDGET_ALERT_THRESHOLD)
              : 0.9,
          }
        : undefined,
  };

  return ServerConfigSchema.parse(config);
}

export function validateConfig(config: unknown): ServerConfig {
  return ServerConfigSchema.parse(config);
}
