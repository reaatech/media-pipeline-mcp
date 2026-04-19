import { z } from 'zod';
import type { StorageConfig } from '@media-pipeline/storage';

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
        })
      )
      .optional(),
  })
  .refine(
    (config) =>
      !config.enabled ||
      (config.jwtSecret && config.jwtSecret.length >= 32) ||
      (config.apiKeys && config.apiKeys.length > 0),
    { message: 'When auth is enabled, either jwtSecret (min 32 chars) or apiKeys is required' }
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
      })
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
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

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

    case 'local':
    default:
      storageConfig = {
        type: 'local',
        config: {
          basePath: environment.STORAGE_PATH || './artifacts',
          ttl: environment.STORAGE_TTL ? parseInt(environment.STORAGE_TTL) * 1000 : undefined,
          serveHttp: environment.STORAGE_SERVE_HTTP === 'true',
        },
      };
      break;
  }

  const config: ServerConfig = {
    port: parseInt(environment.PORT || '8080'),
    host: environment.HOST || '0.0.0.0',
    logLevel: (environment.LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug') || 'info',
    storage: storageConfig,
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
            clientRequestsPerMinute: parseInt(environment.RATE_LIMIT_RPM || '60'),
            clientBurstSize: parseInt(environment.RATE_LIMIT_BURST || '10'),
            expensiveOperationsPerMinute: parseInt(environment.EXPENSIVE_OPS_RPM || '10'),
          }
        : undefined,
    budget:
      environment.BUDGET_DAILY_LIMIT || environment.BUDGET_MONTHLY_LIMIT
        ? {
            dailyLimit: environment.BUDGET_DAILY_LIMIT
              ? parseFloat(environment.BUDGET_DAILY_LIMIT)
              : undefined,
            monthlyLimit: environment.BUDGET_MONTHLY_LIMIT
              ? parseFloat(environment.BUDGET_MONTHLY_LIMIT)
              : undefined,
            perPipelineLimit: environment.BUDGET_PER_PIPELINE_LIMIT
              ? parseFloat(environment.BUDGET_PER_PIPELINE_LIMIT)
              : undefined,
            alertThreshold: environment.BUDGET_ALERT_THRESHOLD
              ? parseFloat(environment.BUDGET_ALERT_THRESHOLD)
              : 0.9,
          }
        : undefined,
  };

  return ServerConfigSchema.parse(config);
}

export function validateConfig(config: unknown): ServerConfig {
  return ServerConfigSchema.parse(config);
}
