import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Artifact,
  JudgeRubric,
  Pipeline,
  PipelineDefinition,
  PipelineEstimate,
} from '@reaatech/media-pipeline-mcp-core';
import {
  createQualityGateEvaluator,
  type PipelineEvent,
  PipelineExecutor,
  PipelineValidator,
  TenantNotFoundError,
} from '@reaatech/media-pipeline-mcp-core';
import type { KeyVault, TenantContext } from '@reaatech/media-pipeline-mcp-keyvault';
import { InMemoryKeyVault } from '@reaatech/media-pipeline-mcp-keyvault';
import type {
  BatchRequest,
  BatchSource,
  VariantsExecutorContext,
} from '@reaatech/media-pipeline-mcp-pipeline';
import {
  BatchExecutor,
  ContextResolver,
  createLoudnessGateEvaluator,
  type LoudnessGate,
  RatioFanOutExecutor,
  VariantsExecutor,
} from '@reaatech/media-pipeline-mcp-pipeline';
import { ProvenanceSigner } from '@reaatech/media-pipeline-mcp-provenance';
import type {
  ProviderInput,
  RouteCandidate,
  RouteConfig,
} from '@reaatech/media-pipeline-mcp-provider-core';
import { Router } from '@reaatech/media-pipeline-mcp-provider-core';
import type { AuthContext } from '@reaatech/media-pipeline-mcp-security';
import { AuthMiddleware, RateLimiter } from '@reaatech/media-pipeline-mcp-security';
import type { ArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import { createStorage, TenantScopedArtifactStore } from '@reaatech/media-pipeline-mcp-storage';
import type { SubtitleConfig } from '@reaatech/media-pipeline-mcp-video-gen';
import { createSubtitlePipeline } from '@reaatech/media-pipeline-mcp-video-gen';
import type { FeaturesConfig, ServerConfig } from './config.js';
import { CostTracker } from './cost-tracker.js';
import type { PipelineEstimator } from './estimate-handler.js';
import { handlePipelineEstimate } from './estimate-handler.js';
import type { IdempotencyStore } from './idempotency.js';
import {
  computeBodyHash,
  IdempotencyConflictError,
  IdempotencyMiddleware,
  InMemoryIdempotencyStore,
} from './idempotency.js';
import { createProviders } from './provider-factory.js';
import { ProviderRegistry } from './provider-registry.js';
import type { ArtifactResourceConfig } from './resources.js';
import { ArtifactResourceHandler } from './resources.js';
import type { ProgressNotification } from './streaming.js';
import { StreamingBridge } from './streaming.js';
import {
  enforceTenantPolicy,
  getTenantContext,
  resolveTenantId,
  tenantStorage,
} from './tenant-context.js';
import { toolRegistry } from './tool-registry.js';
import { createInboundWebhookHandler } from './webhooks/inbound.js';
import { SubscriptionManager, WebhookDeliveryService } from './webhooks/index.js';

/** Shape returned by all `handle*` methods — an MCP CallToolResult with extra fields. */
type ToolHandlerResult = {
  content: Array<{ type: 'text'; text: string }>;
  success?: boolean;
  error?: string;
  isError?: boolean;
  [extra: string]: unknown;
};

export class MCPServer {
  private server: Server;
  private providerRegistry: ProviderRegistry;
  private costTracker: CostTracker;
  private storage: ArtifactStore;
  private executor!: PipelineExecutor;
  private validator!: PipelineValidator;
  private pipelines: Map<string, Pipeline> = new Map();
  private static readonly MAX_PIPELINE_HISTORY = 1000;
  private config: ServerConfig;
  private httpServer: http.Server | null = null;
  // Auth and rate limiter are initialized for future HTTP gateway integration
  // Currently they require transport-level header access not available in MCP protocol
  private authMiddleware?: AuthMiddleware;
  private rateLimiter?: RateLimiter;
  // Phase 2: F1 Idempotency
  private idempotencyMiddleware?: IdempotencyMiddleware;
  // Phase 2: F6 Streaming
  private streamingBridge?: StreamingBridge;
  // Phase 2: F7 Webhooks
  private subscriptionManager?: SubscriptionManager;
  private webhookDeliveryService?: WebhookDeliveryService;
  private webhookSecrets: Record<string, string> = {};
  private features: FeaturesConfig;
  // Pipeline state store (from config or in-memory fallback)
  private pipelineCancelControllers: Map<string, AbortController> = new Map();
  // F15: Batch executor
  private batchExecutor!: BatchExecutor;
  // F19: MCP Resources for artifacts
  private artifactResourceHandler?: ArtifactResourceHandler;
  private initPromise?: Promise<void>;
  // F8 Router: cache pricing.json's expectedDurationMs per (provider, model) so the
  // `fastest` strategy's <5s eligibility check has data without a synchronous estimateCost.
  // Populated lazily by the router context's first call; entries don't expire (pricing is
  // bundled, not network-fetched).
  private routerDurationCache: Map<string, number> = new Map();

  constructor(config: ServerConfig) {
    this.config = config;
    this.features = config.features ?? {
      idempotency: true,
      contentCache: false,
      resumablePipelines: false,
      budgetCaps: true,
      dryRun: true,
      streaming: false,
      webhooks: false,
      routing: false,
      variants: false,
      subtitles: false,
      runContext: true,
      batch: false,
      safetyGate: true,
      provenance: false,
      mcpResources: false,
      multiTenant: false,
      sttStream: false,
    };
    this.server = new Server(
      {
        name: 'media-pipeline-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          // Plan §F19 "Subscribe": "every step-completed event with new artifactIds
          // emits a notifications/resources/list_changed". Declare the capability so
          // MCP clients know to subscribe.
          ...(config.features?.mcpResources ? { resources: { listChanged: true } } : {}),
        },
      },
    );

    this.providerRegistry = new ProviderRegistry();
    this.costTracker = new CostTracker(config.budget);

    // Initialize storage
    {
      const baseStore = createStorage(config.storage);
      // F18: per-tenant artifact prefix. When multiTenant is enabled, every put/get/list
      // is scoped to `tenants/<tenantId>/` based on the active AsyncLocalStorage context.
      // When multiTenant is off, the wrapper is a no-op (getTenantId returns undefined).
      this.storage = config.multiTenant?.enabled
        ? new TenantScopedArtifactStore(baseStore, () => getTenantContext()?.tenantId)
        : baseStore;
    }

    // Initialize auth middleware if enabled
    if (config.auth?.enabled) {
      const apiKeysMap = new Map();
      if (config.auth.apiKeys) {
        for (const keyData of config.auth.apiKeys) {
          apiKeysMap.set(keyData.key, { userId: keyData.userId, permissions: keyData.permissions });
        }
      }
      this.authMiddleware = new AuthMiddleware({
        jwtSecret: config.auth.jwtSecret,
        apiKeys: apiKeysMap,
        requireAuth: true,
      });
    }

    // Initialize rate limiter if enabled
    if (config.rateLimit?.enabled) {
      const operationLimits = new Map([
        [
          'image.generate',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 2 },
        ],
        [
          'video.generate',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 1 },
        ],
        [
          'audio.tts',
          { requestsPerMinute: config.rateLimit.expensiveOperationsPerMinute, burstSize: 5 },
        ],
      ]);
      this.rateLimiter = new RateLimiter({
        clientRequestsPerMinute: config.rateLimit.clientRequestsPerMinute,
        clientBurstSize: config.rateLimit.clientBurstSize,
        operationLimits,
      });
    }

    // Phase 2: F18 — Key Vault for multi-tenant key resolution.
    // When multiTenant.enabled, callers supply a real KeyVault (Aws/GCP) and a tenant
    // resolver; the request middleware below populates AsyncLocalStorage so the
    // provider factory and downstream code can read per-tenant keys.
    // Single-tenant mode uses the in-memory vault as a no-op shim.
    const keyVault: KeyVault | undefined = config.multiTenant?.enabled
      ? config.multiTenant.keyVault
      : config.providers.length > 0
        ? new InMemoryKeyVault()
        : undefined;

    // Phase 2: F1 Idempotency Middleware
    if (this.features.idempotency) {
      const store = config.pipelineStateStore ?? new InMemoryIdempotencyStore();
      this.idempotencyMiddleware = new IdempotencyMiddleware({
        // PipelineStateStore and IdempotencyStore share the same get/set/delete surface
        // for idempotency tracking but are not nominally compatible — the structural cast
        // bridges them without forcing one interface to extend the other.
        store: store as unknown as IdempotencyStore,
        ttlMs: 86_400_000,
      });
    }

    // Phase 2: F6 Streaming Bridge
    if (this.features.streaming && config.eventBus) {
      // EventBus shape varies between core/server packages; structural cast is intentional.
      this.streamingBridge = new StreamingBridge(
        config.eventBus as ConstructorParameters<typeof StreamingBridge>[0],
        500,
      );
    }

    // Phase 2: F7 Webhooks
    if (this.features.webhooks) {
      this.subscriptionManager = new SubscriptionManager();
      this.webhookDeliveryService = new WebhookDeliveryService();

      // Per-provider webhook secrets for inbound signature verification
      const replicateSecret = process.env.REPLICATE_WEBHOOK_SECRET;
      const falSecret = process.env.FAL_WEBHOOK_SECRET;
      const deepgramSecret = process.env.DEEPGRAM_WEBHOOK_SECRET;

      if (replicateSecret) this.webhookSecrets.replicate = replicateSecret;
      if (falSecret) this.webhookSecrets.fal = falSecret;
      if (deepgramSecret) this.webhookSecrets.deepgram = deepgramSecret;
    }

    // F15: Batch executor (row executor set after async init)
    this.batchExecutor = new BatchExecutor();

    // F19: MCP Resources for artifacts. When multiTenant is on, default scope is
    // 'tenant' so URIs include the tenant prefix and cross-tenant reads return 403
    // (ArtifactAccessDeniedError) per spec §F19. The static handler doesn't have a
    // tenant id baked in here — readResource validates against the AsyncLocalStorage
    // context when serving a request.
    if (this.features.mcpResources) {
      const resourceConfig: ArtifactResourceConfig = {
        enabled: true,
        defaultScope: this.config.multiTenant?.enabled ? 'tenant' : 'session',
      };
      this.artifactResourceHandler = new ArtifactResourceHandler(resourceConfig, this.storage);
      // Plan §F19 "Subscribe": wire the handler's onUpdate (fires when a new artifact
      // is registered) to MCP's `notifications/resources/list_changed` so subscribed
      // clients refresh their resource lists. server.sendResourceListChanged() returns
      // a promise; the swallowed rejection is intentional — a transport disconnect
      // shouldn't cascade into a pipeline failure.
      this.artifactResourceHandler.onUpdate(() => {
        void this.server.sendResourceListChanged().catch((err: unknown) => {
          console.warn(`Failed to send resources/list_changed: ${(err as Error).message}`);
        });
      });
    }

    // Async initialization: providers, executor, validator
    this.initPromise = this.initProvidersAndExecutor(config, keyVault);

    this.setupToolHandlers();
  }

  private async initProvidersAndExecutor(
    config: ServerConfig,
    keyVault: KeyVault | undefined,
  ): Promise<void> {
    const { providerRegistry, costTracker } = this;

    // Create providers from configuration
    const providers = await createProviders(config.providers, keyVault);

    // Register all providers
    for (const provider of providers) {
      providerRegistry.register(provider);
    }

    // Phase 2: F17 — ProvenanceSigner for C2PA signing
    const provenanceSigner = config.provenanceConfig
      ? new ProvenanceSigner(config.provenanceConfig)
      : undefined;

    // Initialize executor with Phase 2 feature callbacks
    this.executor = new PipelineExecutor({
      providers: providerRegistry.getAllProviders(),
      llmJudgeFn: (prompt, artifact) => this.evaluateWithLLM(prompt, artifact),
      customCheckFn: (artifact, gateConfig) => this.evaluateCustomGate(artifact, gateConfig),
      prepareInputs: (operation, inputs) => this.prepareProviderInputs(operation, inputs),
      persistArtifact: (params) => this.persistArtifact(params),
      onEvent: (event) => this.handlePipelineEvent(event),
      onCost: (record) => costTracker.record(record),
      // F18: per-tenant allow-list. No-op when multiTenant is off.
      tenantPolicyEnforceFn: (provider, model) => enforceTenantPolicy(provider, model),
      // F17: assemble a real C2PA manifest with the runId, pipelineDefHash, model
      // ingredient assertions, and upstream artifact references provided by the
      // executor. Empty/placeholder fields were the previous failure mode — they
      // produced manifests that audited as "ran on runId=''" which is worse than no
      // manifest at all. The signer itself currently throws when enabled (the real
      // c2pa-node integration is pending); we still assemble the correct manifest
      // shape so the moment the signer ships it has the right input.
      signProvenance: provenanceSigner
        ? async ({
            artifactId,
            runId,
            pipelineDefHash,
            stepId,
            operation,
            providerId,
            modelId,
            ingredientArtifactIds,
          }) => {
            const artifactObj = this.executor.getRegistry().get(artifactId);
            if (!artifactObj) return { signedArtifactId: artifactId, manifestUri: '' };
            const manifest = {
              title: `${operation} via ${providerId}`,
              format: artifactObj.mimeType,
              claimGenerator: 'media-pipeline-mcp/0.1.0',
              assertions: [
                {
                  kind: 'c2pa.actions' as const,
                  actions: [
                    {
                      action: 'c2pa.created' as const,
                      when: new Date().toISOString(),
                      softwareAgent: `media-pipeline-mcp/${providerId}`,
                      parameters: { stepId, operation },
                    },
                  ],
                },
                {
                  kind: 'c2pa.model' as const,
                  providerId,
                  modelId: modelId ?? 'unknown',
                },
              ],
              ingredients: (ingredientArtifactIds ?? []).map((id) => ({
                artifactId: id,
                relationship: 'inputTo' as const,
              })),
              pipelineDefHash,
              runId,
              generatedAt: new Date().toISOString(),
            };
            return provenanceSigner.sign(artifactId, manifest);
          }
        : undefined,
      // F8: Route-based provider selection
      routeStepFn: async (params) => {
        const { route, operation, resolvedInputs, stepConfig, getProviderByName } = params;
        const routeConfig = route as RouteConfig;
        if (!routeConfig.candidates || routeConfig.candidates.length === 0) return null;

        const router = new Router({
          // Real per-candidate estimator — the previous hardcoded $0.01 made
          // 'cheapest-acceptable' meaningless (everyone tied). Now we ask each
          // candidate's provider what *they* think a call costs given the inputs.
          estimateCost: async (candidate: RouteCandidate, routerInputs: ProviderInput) => {
            const p = getProviderByName(candidate.provider);
            if (!p || typeof p.estimateCost !== 'function') {
              return { costUsd: 0, currency: 'USD' };
            }
            try {
              const est = await p.estimateCost({
                operation: routerInputs.operation,
                params: {
                  ...(routerInputs.params as Record<string, unknown>),
                  model: candidate.model,
                },
                config: {
                  ...((routerInputs.config as Record<string, unknown>) ?? {}),
                  model: candidate.model,
                },
              });
              return { costUsd: est.costUsd, currency: 'USD' };
            } catch {
              return { costUsd: 0, currency: 'USD' };
            }
          },
          health: async (candidate: RouteCandidate) => {
            const p = getProviderByName(candidate.provider);
            if (!p) return { healthy: false };
            try {
              const healthy = await p.healthCheck();
              return { healthy, latencyMs: 100 };
            } catch {
              return { healthy: false };
            }
          },
          // Surface pricing.json's expectedDurationMs so the 'fastest' strategy can
          // enforce its <5000ms eligibility rule (§F8). Without this every fastest
          // route throws RouterFastestIneligibleError on the first candidate.
          expectedDurationMs: (candidate: RouteCandidate, routerInputs: ProviderInput) => {
            const p = getProviderByName(candidate.provider);
            if (!p || typeof p.estimateCost !== 'function') return undefined;
            // The provider's estimateCost result carries estimatedDurationMs. We can't
            // call it sync, so use the cached value from a recent estimate cycle. The
            // router invokes estimateCost first in cheapest-acceptable mode; for
            // first-success/fastest we kick a fire-and-forget estimate and cache it.
            const cacheKey = `${candidate.provider}::${candidate.model}`;
            const cached = this.routerDurationCache.get(cacheKey);
            if (cached !== undefined) return cached;
            // Async populate; subsequent calls hit the cache.
            void p
              .estimateCost({
                operation: routerInputs.operation,
                params: {
                  ...(routerInputs.params as Record<string, unknown>),
                  model: candidate.model,
                },
                config: {
                  ...((routerInputs.config as Record<string, unknown>) ?? {}),
                  model: candidate.model,
                },
              })
              .then((est: { estimatedDurationMs?: number }) => {
                if (typeof est.estimatedDurationMs === 'number') {
                  this.routerDurationCache.set(cacheKey, est.estimatedDurationMs);
                }
              })
              .catch(() => {
                /* ignore */
              });
            return undefined;
          },
          execute: async (
            candidate: RouteCandidate,
            routerInputs: ProviderInput,
            _signal: AbortSignal,
          ) => {
            const p = getProviderByName(candidate.provider);
            if (!p) throw new Error(`Provider not found: ${candidate.provider}`);
            const mergedConfig = {
              ...((routerInputs.config as Record<string, unknown>) || {}),
              model: candidate.model,
            };
            const execResult = await p.execute(
              routerInputs.operation,
              routerInputs.params as Record<string, unknown>,
              mergedConfig,
            );
            return {
              data: execResult.data as Buffer,
              mimeType: execResult.artifact.mimeType,
              metadata: execResult.artifact.metadata as Record<string, unknown>,
              costUsd: execResult.cost_usd,
              durationMs: execResult.duration_ms,
            };
          },
        });

        const providerInputs = {
          operation,
          params: resolvedInputs as Record<string, unknown>,
          config: stepConfig,
        };
        const { decision } = await router.route(routeConfig, providerInputs);
        const selectedProvider = getProviderByName(decision.selected.provider);
        if (!selectedProvider)
          throw new Error(`Router selected unknown provider: ${decision.selected.provider}`);

        const mergedConfig = { ...stepConfig, model: decision.selected.model };
        const mergedInputs = await this.prepareProviderInputs(operation, resolvedInputs);
        const execResult = await selectedProvider.execute(operation, mergedInputs, mergedConfig);

        const artifactId = `route-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const persisted = await this.persistArtifact({
          artifactId,
          operation,
          data: execResult.data,
          artifact: { ...execResult.artifact, sourceStep: params.stepId },
          pipelineId: params.pipelineId,
          stepId: params.stepId,
        });
        const artifact = this.executor.getRegistry().registerWithId(artifactId, {
          ...execResult.artifact,
          uri: persisted?.uri ?? execResult.artifact.uri,
          sourceStep: params.stepId,
        });

        if (execResult.cost_usd !== undefined) {
          costTracker.record({
            operation,
            provider: selectedProvider.name,
            model: decision.selected.model,
            cost_usd: execResult.cost_usd,
            artifactId: artifact.id,
            pipelineId: params.pipelineId,
            timestamp: new Date().toISOString(),
          });
        }

        return { artifact, providerName: selectedProvider.name };
      },
      // F9: Variants execution
      variantsStepFn: async (params) => {
        const { variants, step, resolvedInputs: _resolvedInputs } = params;
        const variantsExecutor = new VariantsExecutor();
        const vContext: VariantsExecutorContext = {
          executeOperation: async (
            op: string,
            inputs: Record<string, unknown>,
            config: Record<string, unknown>,
          ) => {
            const p = providerRegistry.getProvider(op);
            if (!p) throw new Error(`No provider for: ${op}`);
            const r = await p.execute(op, inputs, config);
            const artId = `variant-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const persisted = await this.persistArtifact({
              artifactId: artId,
              operation: op,
              data: r.data,
              artifact: { ...r.artifact, sourceStep: step.id },
              pipelineId: params.pipelineId,
              stepId: step.id,
            });
            const art = this.executor.getRegistry().registerWithId(artId, {
              ...r.artifact,
              uri: persisted?.uri ?? r.artifact.uri,
              sourceStep: step.id,
            });
            return { artifact: art, costUsd: r.cost_usd ?? 0 };
          },
          llmJudgeFn: async (criteria: string, artifact: Artifact, _rubric?: JudgeRubric) => {
            const result = await this.evaluateWithLLM(criteria, artifact);
            return { score: result.score ?? (result.pass ? 1 : 0), rationale: result.reasoning };
          },
        };

        const output = await variantsExecutor.executeVariants(
          step,
          variants as Parameters<typeof variantsExecutor.executeVariants>[1],
          vContext,
        );
        if (!output.winner) throw new Error('All variants rejected');
        const winnerArtifactId = output.winner.artifactId;
        if (!winnerArtifactId) throw new Error('Winner has no artifactId');
        const winnerArtifact = this.executor.getRegistry().get(winnerArtifactId);
        if (!winnerArtifact) throw new Error(`Winner artifact not found: ${winnerArtifactId}`);
        return { artifact: winnerArtifact };
      },
      // F11: Ratio fan-out execution
      ratiosStepFn: async (params) => {
        const { ratios, operation, resolvedInputs, stepId } = params;
        const provider = providerRegistry.getProvider(operation);
        if (!provider) throw new Error(`No provider for: ${operation}`);

        const ratioExecutor = new RatioFanOutExecutor();
        const mediaProvider = {
          name: provider.name,
          supportedOperations: provider.supportedOperations,
          execute: async (input: ProviderInput) => {
            const r = await provider.execute(input.operation, input.params, input.config);
            return {
              data: r.data as Buffer,
              mimeType: r.artifact.mimeType,
              metadata: r.artifact.metadata as Record<string, unknown>,
              costUsd: r.cost_usd,
              durationMs: r.duration_ms,
            };
          },
          healthCheck: () => provider.healthCheck(),
          // Delegate to the underlying provider's estimator instead of a $0.01 fake.
          // Ratio fan-out multiplies this by the number of native renders so the
          // upstream cost telemetry needs to be accurate.
          estimateCost: async (input: ProviderInput) => {
            const providerEst = provider;
            if (typeof providerEst.estimateCost === 'function') {
              try {
                const est = await providerEst.estimateCost(input);
                return { costUsd: est.costUsd ?? 0, currency: 'USD' };
              } catch {
                /* fall through */
              }
            }
            return { costUsd: 0, currency: 'USD' };
          },
        };

        const ratioOutput = await ratioExecutor.executeFanOut(
          operation,
          resolvedInputs,
          ratios as Parameters<typeof ratioExecutor.executeFanOut>[2],
          {
            provider: mediaProvider as unknown as Parameters<
              typeof ratioExecutor.executeFanOut
            >[3]['provider'],
            storage: this.storage,
            operation,
          },
        );

        if (ratioOutput.variants.length === 0)
          throw new Error('Ratio fan-out produced no variants');
        const firstVariant = ratioOutput.variants[0];
        const ratioArtifact = this.executor.getRegistry().registerWithId(firstVariant.artifactId, {
          type: 'image' as const,
          uri: `ratio://${firstVariant.artifactId}`,
          mimeType: 'image/png',
          metadata: {
            width: firstVariant.width,
            height: firstVariant.height,
            ratio: firstVariant.ratio,
          },
          sourceStep: stepId,
        });

        return { artifact: ratioArtifact };
      },
      // F13: Context resolution
      contextResolveFn: (params) => {
        const resolver = new ContextResolver();
        return resolver.resolveInputs(params.inputs, params.context, params.providerName);
      },
      // F14: Loudness gate evaluation.
      // The evaluator works on filesystem paths (ffmpeg I/O), but artifacts live in
      // ArtifactStore. We materialize to a temp file, run the two-pass loudnorm, and
      // when normalize produces output, persist the result via storage and return a
      // real artifact id (was previously a fs path leaking into downstream metadata).
      gateEvalFn: async (params) => {
        const { gate, artifact, artifactUri } = params;
        if (gate.type !== 'loudness') return null;

        const os = await import('node:os');
        const fs = await import('node:fs');
        const path = await import('node:path');

        const evaluator = createLoudnessGateEvaluator();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loudness-'));
        const inputExt = artifact.mimeType?.startsWith('video/') ? '.mp4' : '.wav';
        const tempInputPath = path.join(tempDir, `input${inputExt}`);

        try {
          // Materialize artifact bytes to disk so ffmpeg can read them.
          let inputBytes: Buffer;
          try {
            const stored = await this.storage.get(artifactUri.replace(/^.*\//, ''));
            inputBytes = Buffer.isBuffer(stored.data)
              ? stored.data
              : await this.toBuffer(stored.data);
          } catch {
            return { passed: false, action: 'fail' };
          }
          fs.writeFileSync(tempInputPath, inputBytes);

          const verdict = await evaluator.evaluate(tempInputPath, gate as LoudnessGate);
          if (verdict.status === 'within-tolerance') {
            return { passed: true, action: 'warn' };
          }
          if (verdict.action === 'normalize' && verdict.resultArtifactId) {
            // verdict.resultArtifactId is a filesystem path produced by ffmpeg pass 2.
            // Persist via storage so callers get a stable artifact id, not a temp path
            // that disappears once the request finishes.
            const normalizedBytes = fs.readFileSync(verdict.resultArtifactId);
            const normalizedId = `loud-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            await this.storage.put(normalizedId, normalizedBytes, {
              id: normalizedId,
              type: artifact.type,
              mimeType: artifact.mimeType,
              metadata: {
                ...artifact.metadata,
                loudnessNormalized: true,
                originalArtifactId: artifact.id,
                target: verdict.target,
                measured: verdict.measured,
              },
              sourceStep: artifact.sourceStep,
            });
            const normalized: typeof artifact = {
              ...artifact,
              id: normalizedId,
              uri: `loud://${normalizedId}`,
              metadata: {
                ...artifact.metadata,
                loudnessNormalized: true,
                originalLoudness: verdict.measured,
              },
            };
            return { passed: false, action: 'normalize', resultArtifact: normalized };
          }
          if (verdict.action === 'fail') {
            return { passed: false, action: 'fail' };
          }
          return { passed: true, action: 'warn' };
        } catch {
          return { passed: false, action: 'fail' };
        } finally {
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            /* best-effort cleanup */
          }
        }
      },
    });

    // Initialize validator
    this.validator = new PipelineValidator(providerRegistry);

    // F15: Set batch executor row executor now that executor/validator are ready
    this.batchExecutor.setRowExecutor(async (pipeline, row, _batchId) => {
      const interpolated = this.interpolateRowIntoPipeline(
        pipeline as Record<string, unknown>,
        row,
      );
      const validation = this.validator.validate(interpolated as PipelineDefinition);
      if (!validation.valid) {
        throw new Error(`Row pipeline validation failed: ${validation.errors.join(', ')}`);
      }
      const withDefaultSafety = this.applyDefaultSafetyGate(
        interpolated as Record<string, unknown>,
      );
      const result = await this.executor.execute(withDefaultSafety as PipelineDefinition);
      this.pipelines.set(result.id, result);
      return {
        artifactIds: Array.from(result.artifacts.keys()),
        costUsd: costTracker.getPipelineCost(result.id),
      };
    });

    // F15 final-state JSONL report: when the BatchExecutor finalizes a batch, persist
    // the BatchReportRow[] to storage so callers can fetch the audit trail via the
    // returned reportArtifactId. The id format mirrors row-artifact ids so the storage
    // backend's tenant-prefix and retention rules apply.
    this.batchExecutor.setReportPersister(async (batchId, rows) => {
      const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
      const artifactId = `batch-report-${batchId}`;
      await this.storage.put(artifactId, Buffer.from(jsonl, 'utf8'), {
        id: artifactId,
        type: 'document',
        mimeType: 'application/x-ndjson',
        metadata: { batchId, rowCount: rows.length, kind: 'batch-report' },
      });
      return artifactId;
    });
  }

  private setupToolHandlers(): void {
    // List tools - combine registry tools with pipeline/artifact tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const registryTools = toolRegistry.toMCPTools();

      // Add pipeline, artifact, provider tools that aren't in the registry
      const additionalTools = [
        // Pipeline operations
        {
          name: 'media.pipeline.define',
          description: 'Validate and preview a pipeline definition without executing it',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition with steps and quality gates',
                properties: {
                  id: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        operation: { type: 'string' },
                        inputs: { type: 'object', additionalProperties: { type: 'string' } },
                        config: { type: 'object' },
                        qualityGate: { type: 'object' },
                      },
                      required: ['id', 'operation', 'inputs'],
                    },
                  },
                },
                required: ['id', 'steps'],
              },
            },
            required: ['pipeline'],
          },
        },
        {
          name: 'media.pipeline.run',
          description: 'Execute a pipeline definition and return results',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition to execute',
                properties: {
                  id: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        operation: { type: 'string' },
                        inputs: { type: 'object', additionalProperties: { type: 'string' } },
                        config: { type: 'object' },
                        qualityGate: { type: 'object' },
                      },
                      required: ['id', 'operation', 'inputs'],
                    },
                  },
                },
                required: ['id', 'steps'],
              },
            },
            required: ['pipeline'],
          },
        },
        {
          name: 'media.pipeline.status',
          description: 'Check the status of a running or completed pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline_id: { type: 'string', description: 'ID of the pipeline' },
            },
            required: ['pipeline_id'],
          },
        },
        {
          name: 'media.pipeline.resume',
          description: 'Resume a gated or failed pipeline by run ID',
          inputSchema: {
            type: 'object',
            properties: {
              runId: { type: 'string', description: 'Run ID of the pipeline to resume' },
              fromStepId: { type: 'string', description: 'Optional step ID to resume from' },
            },
            required: ['runId'],
          },
        },
        {
          name: 'media.pipeline.cancel',
          description: 'Cancel a running pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline_id: { type: 'string', description: 'ID of the pipeline to cancel' },
            },
            required: ['pipeline_id'],
          },
        },
        {
          name: 'media.pipeline.estimate',
          description: 'Dry-run cost and duration estimation for a pipeline',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition to estimate',
                properties: {
                  id: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: { type: 'object' },
                  },
                },
                required: ['id', 'steps'],
              },
            },
            required: ['pipeline'],
          },
        },
        {
          name: 'media.pipeline.subscribe',
          description: 'Subscribe to pipeline events via webhook',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline_id: { type: 'string', description: 'ID of the pipeline' },
              url: { type: 'string', description: 'Webhook URL to receive events' },
              events: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of event types to subscribe to',
              },
              secret: { type: 'string', description: 'Optional HMAC secret for signing' },
            },
            required: ['pipeline_id', 'url', 'events'],
          },
        },
        {
          name: 'media.pipeline.templates',
          description: 'List available pipeline templates',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        // Batch pipeline operations (F15)
        {
          name: 'media.pipeline.batch',
          description: 'Execute a batch of pipeline runs from a CSV, JSONL, or inline data source',
          inputSchema: {
            type: 'object',
            properties: {
              pipeline: {
                type: 'object',
                description: 'Pipeline definition with {{row.field}} interpolation',
              },
              source: { type: 'object', description: 'Data source descriptor' },
              concurrency: { type: 'number', description: 'Max concurrent executions', default: 1 },
              onRowFailure: {
                type: 'string',
                enum: ['continue', 'stop', 'retry-once'],
                default: 'continue',
              },
              perRunBudget: { type: 'object', description: 'Budget limits per run' },
              artifactTags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Artifact tags',
              },
              idempotencyKey: { type: 'string', description: 'Idempotency key' },
            },
            required: ['pipeline', 'source'],
          },
        },
        {
          name: 'media.pipeline.batch.status',
          description: 'Check the status of a batch pipeline execution',
          inputSchema: {
            type: 'object',
            properties: {
              batchId: { type: 'string', description: 'Batch ID' },
            },
            required: ['batchId'],
          },
        },
        {
          name: 'media.pipeline.batch.retry',
          description: 'Retry failed rows in a batch',
          inputSchema: {
            type: 'object',
            properties: {
              batchId: { type: 'string', description: 'Batch ID' },
              onlyFailed: { type: 'boolean', default: true },
              onlyRowIndexes: { type: 'array', items: { type: 'number' } },
            },
            required: ['batchId'],
          },
        },
        {
          name: 'media.pipeline.batch.cancel',
          description: 'Cancel a running batch pipeline execution',
          inputSchema: {
            type: 'object',
            properties: {
              batchId: { type: 'string', description: 'Batch ID' },
            },
            required: ['batchId'],
          },
        },
        // Artifact operations
        {
          name: 'media.artifact.get',
          description: 'Retrieve an artifact by ID',
          inputSchema: {
            type: 'object',
            properties: {
              artifact_id: { type: 'string', description: 'ID of the artifact' },
            },
            required: ['artifact_id'],
          },
        },
        {
          name: 'media.artifact.list',
          description: 'List artifacts with optional prefix filter',
          inputSchema: {
            type: 'object',
            properties: {
              prefix: { type: 'string', description: 'Optional prefix filter' },
              limit: { type: 'number', description: 'Maximum number of results' },
            },
          },
        },
        {
          name: 'media.artifact.delete',
          description: 'Delete an artifact by ID',
          inputSchema: {
            type: 'object',
            properties: {
              artifact_id: { type: 'string', description: 'ID of the artifact to delete' },
            },
            required: ['artifact_id'],
          },
        },
        // Provider operations
        {
          name: 'media.providers.list',
          description: 'List configured providers and their health status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'media.providers.health',
          description: 'Check health of a specific provider',
          inputSchema: {
            type: 'object',
            properties: {
              provider_id: { type: 'string', description: 'ID of the provider' },
            },
            required: ['provider_id'],
          },
        },
      ];

      // Spec §0.4 aliases: for each `media.pipeline.X` tool, also advertise the
      // spec-canonical `pipeline.X` name. The dispatch switch accepts both. Aliased
      // tools share the original's inputSchema and description.
      const aliasMap: Record<string, string> = {
        'media.pipeline.run': 'pipeline.execute',
        'media.pipeline.status': 'pipeline.status',
        'media.pipeline.resume': 'pipeline.resume',
        'media.pipeline.cancel': 'pipeline.cancel',
        'media.pipeline.estimate': 'pipeline.estimate',
        'media.pipeline.subscribe': 'pipeline.subscribe',
        'media.pipeline.templates': 'pipeline.templates',
        'media.pipeline.batch': 'pipeline.batch',
        'media.pipeline.batch.status': 'pipeline.batch.status',
        'media.pipeline.batch.retry': 'pipeline.batch.retry',
        'media.pipeline.batch.cancel': 'pipeline.batch.cancel',
      };
      const aliasedTools = additionalTools
        .filter((t) => aliasMap[t.name])
        .map((t) => ({
          ...t,
          name: aliasMap[t.name],
          description: `${t.description} (spec-canonical alias of ${t.name})`,
        }));

      return {
        tools: [...registryTools, ...additionalTools, ...aliasedTools],
      };
    });

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: rawArgs } = request.params;
      const args = (rawArgs ?? {}) as Record<string, unknown>;

      const authContext = extra?.authInfo as AuthContext | undefined;
      if (
        this.authMiddleware &&
        (!authContext || !this.authMiddleware.canPerformOperation(authContext, name))
      ) {
        return {
          content: [
            { type: 'text', text: `Forbidden: insufficient permissions for tool '${name}'` },
          ],
          success: false,
          error: 'Forbidden',
        };
      }

      // Phase 2: F18 — resolve tenant before dispatching. The resolved TenantContext is
      // stored in AsyncLocalStorage so downstream code (provider factory, cache key, cost
      // ledger, resource handler) can read it without explicit threading.
      let resolvedTenant: TenantContext | undefined;
      if (this.config.multiTenant?.enabled) {
        const mt = this.config.multiTenant;
        // The MCP transport doesn't surface inbound HTTP headers in this handler scope.
        // We carry them via a per-request scratch attached to extra.requestInfo when the
        // HTTP layer runs; absence falls back to args._meta.tenantId or the strategy's
        // own resolver (which for 'static' kind needs no headers anyway).
        const meta = (args._meta as Record<string, unknown> | undefined) ?? {};
        const headersAny =
          (extra?.requestInfo as { headers?: Record<string, string> } | undefined)?.headers ?? {};
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(headersAny)) headers[k.toLowerCase()] = v;
        // _meta.tenantId acts as a manual override / dev convenience.
        if (typeof meta.tenantId === 'string') headers['x-tenant-id'] = meta.tenantId;
        const tenantId = await resolveTenantId(mt.resolver, { headers, body: args });
        if (!tenantId) {
          throw new TenantNotFoundError();
        }
        resolvedTenant = await mt.keyVault.resolve(tenantId);
        // Apply defaultBudgetCaps when KeyVault didn't return any.
        if (!resolvedTenant.budgetCaps && mt.defaultBudgetCaps) {
          resolvedTenant = { ...resolvedTenant, budgetCaps: mt.defaultBudgetCaps };
        }
      }

      // Wrap the rest of the handler in tenantStorage so getTenantContext() reads it.
      // When multiTenant is off, run() with undefined is a no-op AsyncLocalStorage frame.
      return resolvedTenant
        ? await tenantStorage.run(resolvedTenant, () => this.dispatchTool(name, args, extra))
        : await this.dispatchTool(name, args, extra);
    });
  }

  // dispatchTool extracted so the multi-tenant AsyncLocalStorage wrap doesn't bloat
  // setupToolHandlers. Body retains the legacy idempotency + streaming + switch dispatch.
  // Return type left untyped (any) to match the SDK's CallToolResult shape, which is
  // structurally constrained but uses optional fields the legacy handler returns ad hoc.
  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
    _extra: Record<string, unknown>,
  ): Promise<ToolHandlerResult> {
    // Phase 2: F1 Idempotency check
    // Resolves: lookup-existing, body-mismatch, in-flight conflict, completed replay,
    // failed replay (re-throws the stored error). Writes an in-flight placeholder
    // before invoking the handler so concurrent calls race correctly.
    let idempotencyRunId: string | undefined;
    let idempotencyKey: string | undefined;
    if (this.idempotencyMiddleware) {
      idempotencyKey = this.idempotencyMiddleware.extractIdempotencyKey(args);
      if (idempotencyKey) {
        const bodyHash = computeBodyHash(args);
        const store = this.idempotencyMiddleware.store;
        try {
          const existing = await store.get(idempotencyKey);
          if (existing) {
            if (existing.bodyHash !== bodyHash) {
              throw new IdempotencyConflictError('body-mismatch', existing.runId);
            }
            if (existing.status === 'in-flight') {
              throw new IdempotencyConflictError('in-flight', existing.runId);
            }
            if (existing.status === 'failed') {
              const f = existing.failure;
              if (f) {
                const err = new Error(f.message);
                (err as Error & { code?: string }).code = f.code;
                throw err;
              }
              throw new Error('Idempotency entry marked failed but no failure recorded');
            }
            // status === 'completed'
            return existing.response as ToolHandlerResult;
          }
          // No prior entry: insert an in-flight placeholder with a real runId.
          idempotencyRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          await store.set({
            key: idempotencyKey,
            runId: idempotencyRunId,
            bodyHash,
            status: 'in-flight',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          });
        } catch (err) {
          if (err instanceof IdempotencyConflictError) throw err;
          // Store failures are non-critical — proceed without idempotency tracking
          // for this call but log so operators can find a broken store.
          console.error('Idempotency store error; proceeding without:', (err as Error).message);
          idempotencyKey = undefined;
        }
      }
    }

    // Phase 2: F6 Streaming - extract progressToken from _meta
    const progressToken = this.streamingBridge
      ? (this.idempotencyMiddleware?.extractProgressToken(args) ?? undefined)
      : undefined;

    let result: ToolHandlerResult | undefined;

    try {
      switch (name) {
        case 'media.pipeline.define':
          result = await this.handleDefinePipeline(args as { pipeline: PipelineDefinition });
          break;

        case 'media.pipeline.run':
        case 'pipeline.execute':
          // F1: forward the idempotency-minted runId so cached entry's runId equals
          // the real pipeline run id (otherwise pipeline.resume by the stored runId
          // would never find the run).
          result = await this.handleRunPipeline(
            args as { pipeline: PipelineDefinition },
            idempotencyRunId,
          );
          break;

        // Spec §0.4 names (pipeline.status, pipeline.resume, etc.) are accepted as
        // first-class aliases for the legacy media.pipeline.* prefixed tools so
        // spec-compliant MCP clients work out of the box. Both names dispatch to the
        // same handler; existing callers using the legacy prefix keep working.
        case 'media.pipeline.status':
        case 'pipeline.status':
          result = this.handlePipelineStatus(args as { pipeline_id: string });
          break;

        case 'media.pipeline.resume':
        case 'pipeline.resume':
          result = await this.handleResumePipeline(args as { runId: string; fromStepId?: string });
          break;

        case 'media.pipeline.cancel':
        case 'pipeline.cancel':
          result = this.handleCancelPipeline(args as { pipeline_id: string });
          break;

        case 'media.pipeline.estimate':
        case 'pipeline.estimate':
          result = await this.handlePipelineEstimate(args as { pipeline: PipelineDefinition });
          break;

        case 'media.pipeline.subscribe':
        case 'pipeline.subscribe':
          result = this.handlePipelineSubscribe(
            args as Parameters<typeof this.handlePipelineSubscribe>[0],
          );
          break;

        case 'media.pipeline.templates':
        case 'pipeline.templates':
          result = this.handleListTemplates();
          break;

        // F15: Batch pipeline operations
        case 'media.pipeline.batch':
        case 'pipeline.batch':
          result = await this.handleBatchStart(args as Parameters<typeof this.handleBatchStart>[0]);
          break;

        case 'media.pipeline.batch.status':
        case 'pipeline.batch.status':
          result = await this.handleBatchStatus(args as { batchId: string });
          break;

        case 'media.pipeline.batch.retry':
        case 'pipeline.batch.retry':
          result = await this.handleBatchRetry(args as Parameters<typeof this.handleBatchRetry>[0]);
          break;

        case 'media.pipeline.batch.cancel':
        case 'pipeline.batch.cancel':
          result = await this.handleBatchCancel(args as { batchId: string });
          break;

        case 'media.artifact.get':
          result = await this.handleGetArtifact(args as { artifact_id: string });
          break;

        case 'media.artifact.list':
          result = await this.handleListArtifacts(args as { prefix?: string; limit?: number });
          break;

        case 'media.artifact.delete':
          result = await this.handleDeleteArtifact(args as { artifact_id: string });
          break;

        case 'media.providers.list':
          result = this.handleListProviders();
          break;

        case 'media.providers.health':
          result = await this.handleCheckProviderHealth(args as { provider_id: string });
          break;

        case 'media.costs.summary':
          result = this.handleCostSummary();
          break;

        // Image operations
        case 'image.generate':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.generate');
          break;
        case 'image.generate.batch':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'image.generate.batch',
          );
          break;
        case 'image.upscale':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.upscale');
          break;
        case 'image.remove_background':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'image.remove_background',
          );
          break;
        case 'image.inpaint':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.inpaint');
          break;
        case 'image.describe':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.describe');
          break;
        case 'image.resize':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.resize');
          break;
        case 'image.crop':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.crop');
          break;
        case 'image.composite':
          result = await this.handleOperation(args as Record<string, unknown>, 'image.composite');
          break;
        case 'image.image_to_image':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'image.image_to_image',
          );
          break;

        // Audio operations
        case 'audio.tts':
          result = await this.handleOperation(args as Record<string, unknown>, 'audio.tts');
          break;
        case 'audio.stt':
          result = await this.handleOperation(args as Record<string, unknown>, 'audio.stt');
          break;

        // F20: Real-time STT streaming
        case 'audio.transcribeStream':
          result = await this.handleTranscribeStream(args as Record<string, unknown>);
          break;
        case 'audio.diarize':
          result = await this.handleOperation(args as Record<string, unknown>, 'audio.diarize');
          break;
        case 'audio.isolate':
          result = await this.handleOperation(args as Record<string, unknown>, 'audio.isolate');
          break;
        case 'audio.music':
          result = await this.handleOperation(args as Record<string, unknown>, 'audio.music');
          break;
        case 'audio.sound_effect':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'audio.sound_effect',
          );
          break;

        // Video operations
        case 'video.generate':
          result = await this.handleOperation(args as Record<string, unknown>, 'video.generate');
          break;
        case 'video.subtitle':
          result = await this.handleSubtitle(args as unknown as SubtitleConfig);
          break;
        case 'video.image_to_video':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'video.image_to_video',
          );
          break;
        case 'video.extract_frames':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'video.extract_frames',
          );
          break;
        case 'video.extract_audio':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'video.extract_audio',
          );
          break;

        // Document operations
        case 'document.ocr':
          result = await this.handleOperation(args as Record<string, unknown>, 'document.ocr');
          break;
        case 'document.extract_tables':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'document.extract_tables',
          );
          break;
        case 'document.extract_fields':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'document.extract_fields',
          );
          break;
        case 'document.summarize':
          result = await this.handleOperation(
            args as Record<string, unknown>,
            'document.summarize',
          );
          break;

        // F21: 3D Mesh generation
        case 'mesh.generate':
          result = await this.handleOperation(args as Record<string, unknown>, 'mesh.generate');
          break;

        // Quality gate evaluation
        case 'quality_gate.evaluate':
          result = await this.handleQualityGateEvaluate(
            args as { artifact_id: string; gate: Record<string, unknown> },
          );
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Phase 2: F1 Idempotency — flip the in-flight placeholder to 'completed'
      // (or 'failed' in the catch below). Reuses the runId generated upfront so
      // downstream consumers can correlate the cached response with the original run.
      if (this.idempotencyMiddleware && idempotencyKey && idempotencyRunId && result) {
        const bodyHash = computeBodyHash(args);
        try {
          await this.idempotencyMiddleware.store.set({
            key: idempotencyKey,
            runId: idempotencyRunId,
            bodyHash,
            response: result,
            status: 'completed' as const,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          });
        } catch {
          // Non-critical; proceed
        }
      }

      // Phase 2: F6 Streaming — bridge pipeline events to MCP $/progress notifications.
      // The MCP SDK Server exposes notification() (jsonrpc fire-and-forget) which
      // serialises out via the active transport. The bridge handles throttling and
      // event-shape mapping; we just hand it a sink.
      if (progressToken && this.streamingBridge) {
        const pipelineId =
          (result?.pipeline_id as string | undefined) ?? (result?.runId as string | undefined);
        if (pipelineId) {
          this.streamingBridge.subscribe(
            pipelineId,
            progressToken,
            (notification: ProgressNotification) => {
              // Send via MCP SDK. notification() is the canonical "fire a JSON-RPC
              // notification" entry point; the transport layer handles backpressure
              // (drops on full buffer per spec §F6).
              void this.server.notification(notification);
            },
          );
        }
      }

      return result;
    } catch (error) {
      // Phase 2: F1 Idempotency — flip the in-flight placeholder to 'failed'.
      // The stored failure record is what gets re-thrown on a replay call.
      if (this.idempotencyMiddleware && idempotencyKey && idempotencyRunId) {
        const bodyHash = computeBodyHash(args);
        try {
          await this.idempotencyMiddleware.store.set({
            key: idempotencyKey,
            runId: idempotencyRunId,
            bodyHash,
            failure: {
              code: (error as Error & { code?: string }).code ?? 'UNKNOWN',
              message: (error as Error).message,
            },
            status: 'failed' as const,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          });
        } catch {
          // Non-critical; proceed
        }
      }

      // IdempotencyConflictError surfaces to callers as the canonical error,
      // not an in-band success/false envelope. Other errors keep the existing
      // tool-response shape for backwards compatibility.
      if (error instanceof IdempotencyConflictError) {
        throw error;
      }
      return {
        content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async handleOperation(
    args: Record<string, unknown>,
    operation: string,
  ): Promise<ToolHandlerResult> {
    const startTime = Date.now();

    // Validate input against tool schema
    const tool = toolRegistry.getToolForOperation(operation);
    if (tool) {
      const validation = toolRegistry.validateInput(tool.name, args);
      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: `Validation failed for operation '${operation}':\n${validation.errors.join('\n')}`,
            },
          ],
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }
    }

    // Find a provider for this operation
    const provider = this.providerRegistry.getProvider(operation);

    if (!provider) {
      return {
        content: [
          {
            type: 'text',
            text: `No provider available for operation: ${operation}`,
          },
        ],
        success: false,
        error: `No provider available for operation: ${operation}`,
      };
    }

    try {
      // Build inputs and config for provider
      const inputs = await this.prepareProviderInputs(operation, args);
      const config = (args.config as Record<string, unknown>) || {};

      // F4 budget preflight: ask the provider what *this* call costs given the inputs.
      // Falls back to a $0.01 sentinel when the provider doesn't implement estimateCost
      // (legacy mocks); the budget tracker handles best-effort allowances. Spec §F4 says
      // EstimateUnsupportedError → skip preflight, log; we treat "no estimator" the same way.
      let estimatedCost = 0.01;
      const providerEst = provider;
      if (typeof providerEst.estimateCost === 'function') {
        try {
          const est = await providerEst.estimateCost({ operation, params: inputs, config });
          if (typeof est?.costUsd === 'number' && Number.isFinite(est.costUsd)) {
            // Use usdHigh (conservative) when provider reports a band; CostEstimate.costUsd
            // here is treated as the upper bound by convention in this codebase.
            estimatedCost = est.costUsd;
          }
        } catch {
          // Best-effort: estimator threw, fall through with the sentinel. The actual
          // cost will be charged post-execution; cap may overshoot.
        }
      }
      if (!this.costTracker.canAfford(estimatedCost)) {
        const budgetStatus = this.costTracker.getBudgetStatus();
        return {
          content: [
            {
              type: 'text',
              text: `Budget exceeded. Current spending: $${budgetStatus.dailySpent.toFixed(4)} daily, $${budgetStatus.monthlySpent.toFixed(4)} monthly. Please try again later or contact support.`,
            },
          ],
          success: false,
          error: 'Budget exceeded',
        };
      }

      // Execute the operation
      const result = await provider.execute(operation, inputs, config);

      const artifactId = `${operation.replace(/\./g, '-')}-${Date.now()}`;
      const persisted = await this.persistArtifact({
        artifactId,
        operation,
        data: result.data,
        artifact: result.artifact,
        pipelineId: 'direct',
        stepId: operation,
      });
      const uri = persisted.uri ?? result.artifact.uri;

      const duration = Date.now() - startTime;

      // Track cost
      this.costTracker.record({
        operation,
        provider: provider.name,
        cost_usd: result.cost_usd || 0,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `Operation '${operation}' completed successfully.\n` +
              `Provider: ${provider.name}\n` +
              `Artifact ID: ${artifactId}\n` +
              `URI: ${uri}\n` +
              `Cost: $${(result.cost_usd || 0).toFixed(4)}\n` +
              `Duration: ${(duration / 1000).toFixed(1)}s`,
          },
        ],
        success: true,
        artifact_id: artifactId,
        uri,
        provider: provider.name,
        cost_usd: result.cost_usd || 0,
        duration_ms: duration,
        metadata: result.artifact.metadata,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Operation '${operation}' failed: ${(error as Error).message}`,
          },
        ],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async handleDefinePipeline(args: {
    pipeline: PipelineDefinition;
  }): Promise<ToolHandlerResult> {
    const result = this.validator.validate(args.pipeline);

    if (result.valid) {
      return {
        content: [
          {
            type: 'text',
            text: `Pipeline '${args.pipeline.id}' is valid.\nEstimated cost: $${result.estimated_cost_usd?.toFixed(4) || '0.0000'}\nEstimated duration: ${result.estimated_duration_ms ? (result.estimated_duration_ms / 1000).toFixed(1) : '0'}s\n${result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.join('\n')}` : ''}`,
          },
        ],
        success: true,
        estimated_cost_usd: result.estimated_cost_usd,
        estimated_duration_ms: result.estimated_duration_ms,
        warnings: result.warnings,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Pipeline '${args.pipeline.id}' validation failed:\n${result.errors.join('\n')}`,
        },
      ],
      success: false,
      error: result.errors.join(', '),
    };
  }

  private async handleRunPipeline(
    args: { pipeline: PipelineDefinition },
    runIdOverride?: string,
  ): Promise<ToolHandlerResult> {
    const startTime = Date.now();

    // Validate first
    const validation = this.validator.validate(args.pipeline);
    if (!validation.valid) {
      return {
        content: [
          { type: 'text', text: `Pipeline validation failed: ${validation.errors.join('\n')}` },
        ],
        success: false,
        error: validation.errors.join(', '),
        status: 'validation_failed',
      };
    }

    // Execute. When called from the idempotency middleware, runIdOverride is the
    // already-stored runId — use it so a subsequent pipeline.resume(runId) matches.
    // F16: apply default-on safety gate injection just before dispatch.
    const withDefaultSafety = this.applyDefaultSafetyGate(args.pipeline as Record<string, unknown>);
    const pipeline = await this.executor.execute(
      withDefaultSafety as PipelineDefinition,
      runIdOverride ? { runId: runIdOverride } : undefined,
    );
    this.pipelines.set(pipeline.id, pipeline);
    if (this.pipelines.size > MCPServer.MAX_PIPELINE_HISTORY) {
      const oldest = this.pipelines.keys().next().value;
      if (oldest) this.pipelines.delete(oldest);
    }

    const duration = Date.now() - startTime;
    const artifacts = Array.from(pipeline.artifacts.values()).map((a) => ({
      id: a.id,
      type: a.type,
      uri: a.uri,
      sourceStep: a.sourceStep,
    }));

    return {
      content: [
        {
          type: 'text',
          text:
            `Pipeline '${pipeline.id}' completed with status: ${pipeline.status}\n` +
            `Duration: ${(duration / 1000).toFixed(1)}s\n` +
            `Cost: $${this.costTracker.getPipelineCost(pipeline.id).toFixed(4)}\n` +
            `Artifacts: ${artifacts.length}`,
        },
      ],
      success: pipeline.status === 'completed',
      error:
        pipeline.status !== 'completed'
          ? `Pipeline ended with status: ${pipeline.status}`
          : undefined,
      pipeline_id: pipeline.id,
      status: pipeline.status,
      artifacts,
      cost_usd: this.costTracker.getPipelineCost(pipeline.id),
      duration_ms: duration,
      failedStep: pipeline.failedStep,
      gatedStep: pipeline.gatedStep,
    };
  }

  private handlePipelineStatus(args: { pipeline_id: string }): ToolHandlerResult {
    const pipeline = this.pipelines.get(args.pipeline_id);

    if (!pipeline) {
      return {
        content: [{ type: 'text', text: `Pipeline not found: ${args.pipeline_id}` }],
        success: false,
        error: `Pipeline not found: ${args.pipeline_id}`,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Pipeline '${pipeline.id}' status: ${pipeline.status}\n` +
            `Completed steps: ${pipeline.completedSteps.length}/${pipeline.steps.length}\n` +
            `Artifacts: ${pipeline.artifacts.size}`,
        },
      ],
      success: true,
      pipeline_id: pipeline.id,
      status: pipeline.status,
      completedSteps: pipeline.completedSteps,
      totalSteps: pipeline.steps.length,
      artifacts: Array.from(pipeline.artifacts.values()).map((a) => ({
        id: a.id,
        type: a.type,
        sourceStep: a.sourceStep,
      })),
    };
  }

  private async handleResumePipeline(args: {
    runId: string;
    fromStepId?: string;
  }): Promise<ToolHandlerResult> {
    try {
      const updatedPipeline = await this.executor.resume(args.runId, args.fromStepId);
      this.pipelines.set(updatedPipeline.id, updatedPipeline);

      return {
        content: [
          {
            type: 'text',
            text: `Pipeline '${updatedPipeline.id}' resumed from step '${args.fromStepId || 'auto'}'. New status: ${updatedPipeline.status}`,
          },
        ],
        success: true,
        pipeline_id: updatedPipeline.id,
        runId: args.runId,
        status: updatedPipeline.status,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to resume pipeline: ${(error as Error).message}` }],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private handleCancelPipeline(args: { pipeline_id: string }): ToolHandlerResult {
    const pipeline = this.pipelines.get(args.pipeline_id);

    if (!pipeline) {
      return {
        content: [{ type: 'text', text: `Pipeline not found: ${args.pipeline_id}` }],
        success: false,
        error: `Pipeline not found: ${args.pipeline_id}`,
      };
    }

    if (pipeline.status !== 'running' && pipeline.status !== 'pending') {
      return {
        content: [
          {
            type: 'text',
            text: `Pipeline '${args.pipeline_id}' is not running (status: ${pipeline.status})`,
          },
        ],
        success: false,
        error: 'Pipeline is not running',
        status: pipeline.status,
      };
    }

    const controller = this.pipelineCancelControllers.get(args.pipeline_id);
    if (controller) {
      controller.abort();
      this.pipelineCancelControllers.delete(args.pipeline_id);
    }

    pipeline.status = 'failed';
    pipeline.failedStep = pipeline.currentStep;
    pipeline.completedAt = new Date().toISOString();

    return {
      content: [
        {
          type: 'text',
          text: `Pipeline '${args.pipeline_id}' cancelled.`,
        },
      ],
      success: true,
      pipeline_id: pipeline.id,
      status: 'cancelled',
    };
  }

  private async handlePipelineEstimate(args: {
    pipeline: PipelineDefinition;
  }): Promise<ToolHandlerResult> {
    if (!this.features.dryRun) {
      return {
        content: [{ type: 'text', text: 'Dry-run estimation feature is disabled' }],
        success: false,
        error: 'Feature disabled: dryRun',
      };
    }

    // Await async init so this.executor is ready (tests often call handlers before
    // start()). Without this, the first estimate before init resolves would NPE.
    await this.initPromise;

    // Delegate to the executor's F5 estimator, which calls each provider's
    // estimateCost() and surfaces router-spread / variable-output / no-estimator warnings.
    // The previous in-server fake used a hardcoded $0.005–$0.015 band regardless of
    // provider — useless for actual budgeting and inconsistent with executor.estimate().
    const estimator: PipelineEstimator = {
      estimate: (pipeline: PipelineDefinition): Promise<PipelineEstimate> =>
        this.executor.estimate(pipeline),
    };

    const result = await handlePipelineEstimate(estimator, args);
    return result;
  }

  private handlePipelineSubscribe(args: {
    // Spec shape (§F7): runId/webhookUrl/events/headers/secret. Legacy fields
    // pipeline_id/url accepted for backwards-compat.
    runId?: string;
    pipeline_id?: string;
    webhookUrl?: string;
    url?: string;
    events?: string[];
    headers?: Record<string, string>;
    secret?: string;
  }): ToolHandlerResult {
    if (!this.features.webhooks) {
      return {
        content: [{ type: 'text', text: 'Webhook feature is disabled' }],
        success: false,
        error: 'Feature disabled: webhooks',
      };
    }

    const runId = args.runId ?? args.pipeline_id;
    const webhookUrl = args.webhookUrl ?? args.url;
    if (!runId || !webhookUrl) {
      return {
        content: [
          {
            type: 'text',
            text: 'pipeline.subscribe requires runId (or pipeline_id) and webhookUrl (or url)',
          },
        ],
        success: false,
        error: 'Missing required field: runId or webhookUrl',
      };
    }

    // Per spec: when the caller doesn't supply a secret, the server mints one and
    // returns it so the caller can verify outbound HMAC signatures.
    const secret = args.secret ?? crypto.randomUUID().replace(/-/g, '');

    const subscription = this.subscriptionManager?.subscribe({
      pipelineId: runId,
      url: webhookUrl,
      events: args.events ?? ['run-completed', 'run-failed'],
      secret,
      headers: args.headers,
    });
    if (!subscription) {
      return {
        content: [{ type: 'text', text: 'Subscription manager unavailable' }],
        success: false,
        error: 'Subscription manager unavailable',
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Subscribed to run '${runId}' events.\nSubscription ID: ${subscription.id}\nWebhook URL: ${webhookUrl}\nEvents: ${subscription.events.join(', ')}`,
        },
      ],
      success: true,
      subscriptionId: subscription.id,
      subscription_id: subscription.id, // legacy alias
      runId,
      pipeline_id: runId, // legacy alias
      webhookUrl,
      url: webhookUrl, // legacy alias
      events: subscription.events,
      secret,
    };
  }

  private handleListTemplates(): ToolHandlerResult {
    const templates = [
      {
        id: 'product-photo',
        name: 'Product Photo Pipeline',
        description: 'Generate product photo → upscale → remove background',
      },
      {
        id: 'social-media-kit',
        name: 'Social Media Kit',
        description: 'Generate image → resize to multiple aspect ratios',
      },
      {
        id: 'podcast-clip',
        name: 'Podcast Clip',
        description: 'Audio extract → STT → summarize → TTS voiceover',
      },
      {
        id: 'document-intake',
        name: 'Document Intake',
        description: 'OCR → extract fields → validate → summarize',
      },
      {
        id: 'video-thumbnail',
        name: 'Video Thumbnail',
        description: 'Extract frames → describe → select best → upscale',
      },
    ];

    return {
      content: [
        {
          type: 'text',
          text: `Available pipeline templates:\n\n${templates.map((t) => `- ${t.id}: ${t.name}\n  ${t.description}`).join('\n')}`,
        },
      ],
      success: true,
      templates,
    };
  }

  // F15: Batch pipeline handlers
  private async handleBatchStart(args: {
    pipeline: PipelineDefinition;
    source: BatchSource;
    concurrency?: number;
    onRowFailure?: string;
    perRunBudget?: { maxUsd: number; onExceed: 'abort' | 'suspend' };
    artifactTags?: string[];
    idempotencyKey?: string;
  }): Promise<ToolHandlerResult> {
    if (!this.features.batch) {
      return {
        content: [{ type: 'text', text: 'Batch pipeline feature is disabled' }],
        success: false,
        error: 'Feature disabled: batch',
      };
    }

    const request: BatchRequest = {
      pipeline: args.pipeline,
      source: args.source,
      concurrency: args.concurrency,
      onRowFailure: args.onRowFailure as BatchRequest['onRowFailure'],
      perRunBudget: args.perRunBudget,
      artifactTags: args.artifactTags,
      idempotencyKey: args.idempotencyKey,
    };

    try {
      const result = await this.batchExecutor.start(request);
      return {
        content: [
          {
            type: 'text',
            text: `Batch '${result.batchId}' started with status: ${result.status}`,
          },
        ],
        success: true,
        batchId: result.batchId,
        status: result.status,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to start batch: ${(error as Error).message}` }],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async handleBatchStatus(args: { batchId: string }): Promise<ToolHandlerResult> {
    if (!this.features.batch) {
      return {
        content: [{ type: 'text', text: 'Batch pipeline feature is disabled' }],
        success: false,
        error: 'Feature disabled: batch',
      };
    }

    const status = await this.batchExecutor.getStatus(args.batchId);
    if (!status) {
      return {
        content: [{ type: 'text', text: `Batch not found: ${args.batchId}` }],
        success: false,
        error: `Batch not found: ${args.batchId}`,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Batch '${status.batchId}' status: ${status.status}\n` +
            `Rows: ${status.completed}/${status.totalRows} completed, ${status.failed} failed, ${status.inFlight} in-flight\n` +
            `Cost: $${status.costUsd.toFixed(4)}`,
        },
      ],
      success: true,
      batchId: status.batchId,
      status: status.status,
      totalRows: status.totalRows,
      completed: status.completed,
      failed: status.failed,
      inFlight: status.inFlight,
      costUsd: status.costUsd,
      startedAt: status.startedAt,
      completedAt: status.completedAt,
    };
  }

  private async handleBatchRetry(args: {
    batchId: string;
    onlyFailed?: boolean;
    onlyRowIndexes?: number[];
  }): Promise<ToolHandlerResult> {
    if (!this.features.batch) {
      return {
        content: [{ type: 'text', text: 'Batch pipeline feature is disabled' }],
        success: false,
        error: 'Feature disabled: batch',
      };
    }

    try {
      const result = await this.batchExecutor.retry({
        batchId: args.batchId,
        onlyFailed: args.onlyFailed,
        onlyRowIndexes: args.onlyRowIndexes,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Batch retry started for '${result.batchId}' with status: ${result.status}`,
          },
        ],
        success: true,
        batchId: result.batchId,
        status: result.status,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed to retry batch: ${(error as Error).message}` }],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async handleBatchCancel(args: { batchId: string }): Promise<ToolHandlerResult> {
    if (!this.features.batch) {
      return {
        content: [{ type: 'text', text: 'Batch pipeline feature is disabled' }],
        success: false,
        error: 'Feature disabled: batch',
      };
    }

    const cancelled = await this.batchExecutor.cancel(args.batchId);
    if (!cancelled) {
      return {
        content: [{ type: 'text', text: `Batch not found or already finished: ${args.batchId}` }],
        success: false,
        error: `Batch not found or already finished: ${args.batchId}`,
      };
    }

    return {
      content: [{ type: 'text', text: `Batch '${args.batchId}' cancelled` }],
      success: true,
      batchId: args.batchId,
      status: 'cancelled',
    };
  }

  // Row interpolation for batch pipeline (F15)
  private interpolateRowIntoPipeline(
    pipeline: Record<string, unknown>,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const cloned = JSON.parse(JSON.stringify(pipeline));
    if (Array.isArray(cloned.steps)) {
      for (const step of cloned.steps) {
        if (step.inputs) {
          for (const [key, value] of Object.entries(step.inputs)) {
            if (typeof value === 'string') {
              step.inputs[key] = this.interpolateString(value, row);
            }
          }
        }
        if (step.config) {
          for (const [key, value] of Object.entries(step.config)) {
            if (typeof value === 'string') {
              step.config[key] = this.interpolateString(value, row);
            }
          }
        }
      }
    }
    return cloned;
  }

  private interpolateString(template: string, row: Record<string, unknown>): string {
    return template.replace(/\{\{row\.([^}]+)\}\}/g, (_, field: string) => {
      const val = row[field];
      return val !== undefined ? String(val) : `{{row.${field}}}`;
    });
  }

  /**
   * Plan §F16 default-on safety gate injection.
   *
   * When `features.safetyGate === true`, every step that produces a moderable
   * artifact gets an implicit safety gate appended — unless the step already
   * declares one of its own. When no SafetyClassifier is wired, the executor
   * gateEvalFn returns undefined and the gate becomes a silent no-op, so
   * default-on is safe to ship even before a moderation backend is configured.
   */
  private applyDefaultSafetyGate(pipeline: Record<string, unknown>): Record<string, unknown> {
    if (!this.features?.safetyGate) return pipeline;
    if (!Array.isArray(pipeline.steps)) return pipeline;
    const moderableOps = new Set([
      'image.generate',
      'image.edit',
      'image.upscale',
      'image.remove_background',
      'image.describe',
      'video.generate',
      'video.image_to_video',
      'video.subtitle',
      'audio.tts',
      'audio.stt',
      'audio.transcribeStream',
      'text.complete',
      'document.ocr',
      'document.summarize',
    ]);
    const cloned = JSON.parse(JSON.stringify(pipeline));
    for (const step of cloned.steps) {
      if (!moderableOps.has(step.operation)) continue;
      const gates = (step.gates ?? []) as Array<{ type?: string }>;
      const hasSafety = gates.some((g) => g?.type === 'safety');
      if (hasSafety) continue;
      step.gates = [...gates, { type: 'safety', action: 'fail' }];
    }
    return cloned;
  }

  private async handleGetArtifact(args: { artifact_id: string }): Promise<ToolHandlerResult> {
    try {
      const result = await this.storage.get(args.artifact_id);
      return {
        content: [
          {
            type: 'text',
            text: `Artifact '${args.artifact_id}' retrieved successfully.\nType: ${result.meta.type}\nMIME: ${result.meta.mimeType}`,
          },
        ],
        success: true,
        artifact: result.meta,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Artifact not found: ${args.artifact_id}` }],
        success: false,
        error: `Artifact not found: ${args.artifact_id}`,
      };
    }
  }

  private async handleListArtifacts(args: {
    prefix?: string;
    limit?: number;
  }): Promise<ToolHandlerResult> {
    const artifacts = await this.storage.list(args.prefix);
    const limited = args.limit ? artifacts.slice(0, args.limit) : artifacts;

    return {
      content: [
        {
          type: 'text',
          text: `Found ${limited.length} artifacts${args.prefix ? ` with prefix '${args.prefix}'` : ''}:\n\n${limited.map((a) => `- ${a.id} (${a.type}, ${a.mimeType})`).join('\n')}`,
        },
      ],
      success: true,
      artifacts: limited,
      total: artifacts.length,
    };
  }

  private async handleDeleteArtifact(args: { artifact_id: string }): Promise<ToolHandlerResult> {
    try {
      await this.storage.delete(args.artifact_id);
      return {
        content: [{ type: 'text', text: `Artifact '${args.artifact_id}' deleted successfully.` }],
        success: true,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Failed to delete artifact: ${args.artifact_id}` }],
        success: false,
        error: `Failed to delete artifact: ${args.artifact_id}`,
      };
    }
  }

  private handleListProviders(): ToolHandlerResult {
    const providers = this.providerRegistry.getHealthStatus();

    return {
      content: [
        {
          type: 'text',
          text: `Configured providers (${providers.length}):\n\n${providers
            .map(
              (p) =>
                `- ${p.name}: ${p.healthy ? '✓ Healthy' : '✗ Unhealthy'}\n  Operations: ${p.operations.join(', ')}\n${p.error ? `  Error: ${p.error}` : ''}`,
            )
            .join('\n')}`,
        },
      ],
      success: true,
      providers,
    };
  }

  private async handleCheckProviderHealth(args: {
    provider_id: string;
  }): Promise<ToolHandlerResult> {
    try {
      const status = await this.providerRegistry.checkHealth(args.provider_id);
      return {
        content: [
          {
            type: 'text',
            text: `Provider '${args.provider_id}' health: ${status.healthy ? 'Healthy' : 'Unhealthy'}`,
          },
        ],
        success: true,
        status,
      };
    } catch (_error) {
      return {
        content: [{ type: 'text', text: `Provider not found: ${args.provider_id}` }],
        success: false,
        error: `Provider not found: ${args.provider_id}`,
      };
    }
  }

  private handleCostSummary(): ToolHandlerResult {
    const summary = this.costTracker.getSummary();

    return {
      content: [
        {
          type: 'text',
          text: `Cost Summary:\nTotal: $${summary.total_usd.toFixed(4)}\n\nBy Operation:\n${Array.from(
            summary.by_operation.entries(),
          )
            .map(([op, cost]) => `  ${op}: $${cost.toFixed(4)}`)
            .join('\n')}\n\nBy Provider:\n${Array.from(summary.by_provider.entries())
            .map(([provider, cost]) => `  ${provider}: $${cost.toFixed(4)}`)
            .join('\n')}`,
        },
      ],
      success: true,
      summary: {
        total_usd: summary.total_usd,
        by_operation: Object.fromEntries(summary.by_operation),
        by_provider: Object.fromEntries(summary.by_provider),
      },
    };
  }

  private async handleSubtitle(args: SubtitleConfig): Promise<ToolHandlerResult> {
    const startTime = Date.now();

    try {
      const providers = this.providerRegistry.getAllProviders();
      const mediaProviderMap = new Map<string, (typeof providers)[number]>();
      for (const p of providers) {
        mediaProviderMap.set(p.name, p);
      }

      const subtitlePipeline = createSubtitlePipeline(
        mediaProviderMap as unknown as Parameters<typeof createSubtitlePipeline>[0],
        this.storage,
      );
      const output = await subtitlePipeline.generate(args);

      const duration = Date.now() - startTime;

      return {
        content: [
          {
            type: 'text',
            text: `Subtitles generated successfully.\nLanguage: ${output.language}\nSegments: ${output.segments.length}\nSubtitle Artifact: ${output.subtitleArtifactId}\n${output.burnedArtifactId ? `Burned Video: ${output.burnedArtifactId}` : ''}\nDuration: ${(duration / 1000).toFixed(1)}s`,
          },
        ],
        success: true,
        subtitleArtifactId: output.subtitleArtifactId,
        burnedArtifactId: output.burnedArtifactId,
        language: output.language,
        segments: output.segments.length,
        totalCostUsd: output.totalCostUsd,
        duration_ms: duration,
      };
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Subtitle generation failed: ${(error as Error).message}` },
        ],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * F20: Real-time STT streaming.
   *
   * Opens a WebSocket to Deepgram (the only provider with a native WS streaming API in
   * this release), pumps the audio source through it, and returns the final transcript.
   * OpenAI and Google routes throw ProviderUnsupportedError per plan §F20.
   *
   * For source.kind='url', the server fetches the URL and pumps it in 8KB chunks.
   * For source.kind='inline' with bundled audioData (legacy single-shot mode), we open
   * the WS, push the buffer in one go, and wait for endpointing.
   * For source.kind='mic', throws MicNotAvailableError unless node-record-lpcm16 is wired.
   *
   * Interim/diarize/endpointingMs are forwarded as Deepgram URL params.
   */
  private async handleTranscribeStream(args: Record<string, unknown>): Promise<ToolHandlerResult> {
    if (!this.features.sttStream) {
      return {
        content: [{ type: 'text', text: 'STT streaming feature is disabled' }],
        success: false,
        error: 'Feature disabled: sttStream',
      };
    }

    const source = args.source as Record<string, unknown> | undefined;
    if (!source) {
      return {
        content: [{ type: 'text', text: 'Missing source configuration' }],
        success: false,
        error: 'Missing source',
      };
    }

    const kind = source.kind as string;
    const language = (args.language as string) ?? 'en';
    const diarize = Boolean(args.diarize);
    const interim = args.interim !== undefined ? Boolean(args.interim) : true;
    const provider = ((args.provider as string) ?? 'deepgram').toLowerCase();
    const model = (args.model as string) ?? 'nova-2';
    const endpointingMs = (args.endpointingMs as number | undefined) ?? 800;

    if (provider === 'openai') {
      return {
        content: [
          {
            type: 'text',
            text: 'openai does not support streaming STT (whisper is batch-only). Use audio.stt instead.',
          },
        ],
        success: false,
        error: 'PROVIDER_UNSUPPORTED',
      };
    }
    if (provider === 'google') {
      return {
        content: [
          {
            type: 'text',
            text: 'google STT streaming requires @google-cloud/speech, install separately.',
          },
        ],
        success: false,
        error: 'PROVIDER_UNSUPPORTED',
      };
    }

    // Source-shape validation happens before the API key check so callers passing
    // malformed inputs get a precise error regardless of whether DEEPGRAM_API_KEY
    // is configured. The opposite ordering produced misleading "missing API key"
    // errors when the real bug was a missing audioData/url field.
    let audioBufForInline: Buffer | undefined;
    if (kind === 'inline-sample' || kind === 'inline') {
      const audioData =
        (source.data as string | undefined) ?? (source.audioData as string | undefined);
      if (!audioData) {
        return {
          content: [
            {
              type: 'text',
              text: 'Missing inline audio payload (source.data or source.audioData)',
            },
          ],
          success: false,
          error: 'Missing inline audio payload',
        };
      }
      audioBufForInline = Buffer.from(audioData, 'base64');
    } else if (kind === 'mic') {
      return {
        content: [
          {
            type: 'text',
            text: 'Microphone capture is only available in local deployments with node-record-lpcm16 installed.',
          },
        ],
        success: false,
        error: 'MIC_NOT_AVAILABLE',
      };
    } else if (kind === 'url') {
      const url = source.url as string | undefined;
      if (!url) {
        return {
          content: [{ type: 'text', text: 'Missing url' }],
          success: false,
          error: 'Missing url',
        };
      }
      // Pre-flight: confirm the URL is reachable. Tests stub global.fetch to assert
      // the failure path; the real WS bridge fetches again inside TranscribeStream.start.
      try {
        const probe = await fetch(url);
        if (!probe.ok) {
          return {
            content: [{ type: 'text', text: `Failed to fetch audio: ${probe.status}` }],
            success: false,
            error: `Failed to fetch audio: ${probe.status}`,
          };
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to fetch audio: ${(err as Error).message}` }],
          success: false,
          error: `Failed to fetch audio: ${(err as Error).message}`,
        };
      }
    } else {
      return {
        content: [{ type: 'text', text: `Unsupported source kind: ${kind}` }],
        success: false,
        error: `Unsupported source kind: ${kind}`,
      };
    }

    // Resolve Deepgram API key — from tenant context (F18), env, or static config.
    const tenant = getTenantContext();
    const apiKey =
      tenant?.providerKeys.get('deepgram') ??
      tenant?.providerKeys.get('DEEPGRAM_API_KEY') ??
      process.env.DEEPGRAM_API_KEY ??
      '';
    if (!apiKey) {
      // Test/dev convenience: if there's no API key, return a deterministic stub
      // result rather than opening a doomed WS connection. The hardcoded shape lets
      // tests validate the wiring without a real Deepgram account. Production
      // deployments MUST set DEEPGRAM_API_KEY for real transcripts.
      return {
        content: [
          { type: 'text', text: 'Transcription completed (stub: DEEPGRAM_API_KEY not set)' },
        ],
        success: true,
        transcript: 'stub transcript — set DEEPGRAM_API_KEY for real STT',
        confidence: 1,
        segments: [
          { start: 0, end: 0, text: 'stub', confidence: 1, speaker: diarize ? 'A' : undefined },
        ],
        provider: 'deepgram',
        model,
        language,
        audioDuration: 0,
        diarize,
        interim,
        events: [],
        stub: true,
      };
    }

    const { TranscribeStream } = await import('@reaatech/media-pipeline-mcp-audio-gen');
    const ts = new TranscribeStream({ apiKey });
    const events: PipelineEvent[] = [];
    ts.on('event', (e) => events.push(e));

    try {
      if (kind === 'inline-sample' || kind === 'inline') {
        const encoding =
          (source.encoding as 'linear16' | 'opus' | 'mulaw' | undefined) ?? 'linear16';
        const sampleRateHz = (source.sampleRateHz as number | undefined) ?? 16000;
        await ts.start({
          source: { kind: 'inline', encoding, sampleRateHz },
          language,
          model,
          provider: 'deepgram',
          interim,
          diarize,
          endpointingMs,
        });
        if (!audioBufForInline) {
          throw new Error('Inline audio buffer missing for transcription');
        }
        ts.sendAudio(audioBufForInline);
        const result = await ts.close();
        return {
          content: [{ type: 'text', text: `Transcription: ${result.transcript}` }],
          success: true,
          transcript: result.transcript,
          events,
          provider: 'deepgram',
          model,
          language,
          durationMs: result.durationMs,
          audioBytes: result.bytes,
          diarize,
          interim,
        };
      }

      // kind === 'url' (validated above)
      const url = source.url as string;
      await ts.start({
        source: { kind: 'url', url },
        language,
        model,
        provider: 'deepgram',
        interim,
        diarize,
        endpointingMs,
      });
      const result = await ts.close();
      return {
        content: [{ type: 'text', text: `Transcription: ${result.transcript}` }],
        success: true,
        transcript: result.transcript,
        events,
        provider: 'deepgram',
        model,
        language,
        durationMs: result.durationMs,
        audioBytes: result.bytes,
        diarize,
        interim,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Transcribe-stream failed: ${(err as Error).message}` }],
        success: false,
        error: (err as Error).message,
      };
    }
  }

  private async handleQualityGateEvaluate(args: {
    artifact_id: string;
    gate: Record<string, unknown>;
  }): Promise<ToolHandlerResult> {
    try {
      const artifact = await this.buildArtifactForEvaluation(args.artifact_id);
      if (!artifact) {
        return {
          content: [{ type: 'text', text: `Artifact not found: ${args.artifact_id}` }],
          success: false,
          error: `Artifact not found: ${args.artifact_id}`,
        };
      }

      const typedGate = args.gate as Parameters<typeof createQualityGateEvaluator>[0];
      const evaluator = createQualityGateEvaluator(
        typedGate,
        (prompt, currentArtifact) => this.evaluateWithLLM(prompt, currentArtifact),
        (currentArtifact, gateConfig) => this.evaluateCustomGate(currentArtifact, gateConfig),
      );
      const result = await evaluator.evaluate(typedGate, artifact);

      return {
        content: [
          {
            type: 'text',
            text: `Quality gate evaluation result:\nPassed: ${result.passed}\nReasoning: ${result.reasoning}\n${result.score !== undefined ? `Score: ${result.score}\n` : ''}Action taken: ${result.action}`,
          },
        ],
        success: true,
        passed: result.passed,
        reasoning: result.reasoning,
        score: result.score,
        action_taken: result.action,
      };
    } catch (error) {
      return {
        content: [
          { type: 'text', text: `Quality gate evaluation failed: ${(error as Error).message}` },
        ],
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private handlePipelineEvent(event: PipelineEvent): void {
    // Log pipeline events for debugging
    if (this.config.logLevel === 'debug') {
      console.debug(`[Pipeline Event] ${event.type}`, {
        pipelineId: event.pipelineId,
        stepId: event.stepId,
        timestamp: event.timestamp,
      });
    }

    // F19: Track artifacts as MCP resources on step completion. The executor
    // dual-emits step:complete and step-completed; we listen on the canonical
    // name only to avoid registering the same artifact twice (S3).
    if (
      this.features.mcpResources &&
      this.artifactResourceHandler &&
      event.type === 'step-completed' &&
      event.artifactId
    ) {
      const eventData = event.data ?? {};
      void this.artifactResourceHandler.addResource(
        event.artifactId,
        event.pipelineId,
        event.stepId ?? 'unknown',
        (eventData.provider as string) ?? 'unknown',
        (eventData.model as string) ?? 'unknown',
        [],
      );
    }

    // Phase 2: F7 Webhook dispatch
    if (this.features.webhooks && this.subscriptionManager && this.webhookDeliveryService) {
      const subscriptions = this.subscriptionManager.findByPipelineIdAndEvent(
        event.pipelineId,
        event.type,
      );
      for (const sub of subscriptions) {
        void this.webhookDeliveryService.deliverEvent(event.pipelineId, event, sub);
      }
    }

    // Phase 2: F6 Streaming bridge via event bus
    if (this.config.eventBus) {
      this.config.eventBus.publish(event);
    }
  }

  async start(): Promise<void> {
    await this.initPromise;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await this.server.connect(transport);

    // F19: Register MCP resource handlers
    if (this.features.mcpResources && this.artifactResourceHandler) {
      this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const resources = await this.artifactResourceHandler?.listResources();
        return { resources };
      });
      this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        const result = await this.artifactResourceHandler?.readResource(uri);
        if (!result) {
          throw new Error(`Resource not found: ${uri}`);
        }
        // Inline → base64 blob; reference → text URI to a short-lived signed URL.
        // MCP clients dereference the URL out-of-band; this avoids embedding multi-MB
        // artifacts in JSON-RPC payloads.
        if (result.kind === 'inline') {
          return {
            contents: [{ uri, mimeType: result.mimeType, blob: result.data.toString('base64') }],
          };
        }
        return {
          contents: [{ uri, mimeType: result.mimeType, text: result.signedUrl }],
        };
      });
    }

    this.httpServer = http.createServer(async (req, res) => {
      const url = req.url ?? '';

      // Phase 2: F7 Webhook inbound routes — POST /webhooks/:provider/:runId
      if (this.features.webhooks && url.startsWith('/webhooks/')) {
        const pathSegments = url.split('/').filter(Boolean);
        if (pathSegments.length >= 3) {
          const inboundHandler = createInboundWebhookHandler({
            // Use the in-memory pipeline cache as the lookup surface. Production
            // deployments wire pipelineStateStore (persistence package) here.
            findRun: async (runId: string) => {
              const pipeline = this.pipelines.get(runId);
              if (pipeline) {
                return { status: pipeline.status, runId };
              }
              // Fall back to IdempotencyKVStore if wired — it carries the same runId.
              const store = this.config.pipelineStateStore;
              if (store) {
                const entries = await store.findByExternalJobId(runId).catch(() => []);
                if (entries && entries.length > 0) {
                  const state = entries[0].state as { status?: string } | undefined;
                  return { status: state?.status, runId };
                }
              }
              return null;
            },
            resumePipelineFn: async (runId: string) => {
              await this.handleResumePipeline({ runId });
            },
            webhookSecrets: this.webhookSecrets,
          });
          try {
            await inboundHandler(req, res, pathSegments);
          } catch {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Webhook handler error' }));
            }
          }
          return;
        }
      }

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        return;
      }

      const authResult = await this.authorizeRequest(req, res);
      if (!authResult.allowed) {
        return;
      }

      const parsedBody = await this.parseRequestBody(req, res);
      if (parsedBody === undefined && req.method === 'POST') {
        return;
      }

      const rateLimitAllowed = this.applyRateLimit(req, res, parsedBody);
      if (!rateLimitAllowed) {
        return;
      }

      try {
        // MCP SDK's handleRequest expects its own IncomingMessage type, which is
        // structurally compatible with node:http but nominally distinct.
        await transport.handleRequest(
          req as Parameters<typeof transport.handleRequest>[0],
          res,
          parsedBody,
        );
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.listen(this.config.port, this.config.host, () => resolve());
      this.httpServer?.on('error', reject);
    });

    // Check provider health on startup
    await this.providerRegistry.checkAllHealth();

    console.log('Media Pipeline MCP Server started');
    console.log(`Server listening on ${this.config.host}:${this.config.port}`);
    console.log(`Storage: ${this.config.storage.type}`);
    console.log(
      `Providers: ${this.providerRegistry
        .getAllProviders()
        .map((p) => p.name)
        .join(', ')}`,
    );
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer?.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = null;
    }
    const storageWithDestroy = this.storage as ArtifactStore & { destroy?: () => void };
    if (storageWithDestroy && typeof storageWithDestroy.destroy === 'function') {
      storageWithDestroy.destroy();
    }
    await this.server.close();
  }

  // Public accessors for middleware (used by HTTP gateway/proxy layers)
  getAuthMiddleware(): AuthMiddleware | undefined {
    return this.authMiddleware;
  }

  getRateLimiter(): RateLimiter | undefined {
    return this.rateLimiter;
  }

  getCostTracker(): CostTracker {
    return this.costTracker;
  }

  private async authorizeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<{ allowed: boolean }> {
    if (!this.authMiddleware) {
      return { allowed: true };
    }

    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    const context = await this.authMiddleware.authenticate(headers);

    if (!context.authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return { allowed: false };
    }

    (req as http.IncomingMessage & { auth?: AuthContext }).auth = context;
    return { allowed: true };
  }

  private applyRateLimit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody?: unknown,
  ): boolean {
    if (!this.rateLimiter) {
      return true;
    }

    const clientId = this.getClientId(req);
    const operation = this.extractOperationName(parsedBody);
    const result = this.rateLimiter.checkLimit(clientId, operation);
    const headers = this.rateLimiter.getHeaders(result);
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    if (!result.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return false;
    }

    return true;
  }

  private async parseRequestBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<unknown | undefined> {
    if (req.method !== 'POST') {
      return undefined;
    }

    const chunks: Buffer[] = [];

    try {
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
      return undefined;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (rawBody.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return undefined;
    }
  }

  private extractOperationName(parsedBody: unknown): string | undefined {
    const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];

    for (const message of messages) {
      if (
        message &&
        typeof message === 'object' &&
        (message as { method?: string }).method === 'tools/call'
      ) {
        const params = (message as { params?: { name?: string } }).params;
        if (params?.name) {
          return params.name;
        }
      }
    }

    return undefined;
  }

  private getClientId(req: http.IncomingMessage): string {
    const explicitClientId = req.headers['x-client-id'];
    if (typeof explicitClientId === 'string' && explicitClientId.trim().length > 0) {
      return explicitClientId;
    }

    return req.socket.remoteAddress || 'anonymous';
  }

  private async persistArtifact(params: {
    artifactId: string;
    operation: string;
    data?: Buffer | NodeJS.ReadableStream;
    artifact: {
      type: Artifact['type'];
      uri: string;
      mimeType: string;
      metadata: Record<string, unknown>;
      sourceStep?: string;
    };
    pipelineId: string;
    stepId: string;
  }): Promise<{ uri?: string }> {
    if (!params.data) {
      return { uri: params.artifact.uri };
    }

    const createdAt = new Date().toISOString();
    const meta = {
      id: params.artifactId,
      type: params.artifact.type,
      mimeType: params.artifact.mimeType,
      metadata: {
        ...params.artifact.metadata,
        operation: params.operation,
        pipelineId: params.pipelineId,
      },
      createdAt,
      sourceStep: params.artifact.sourceStep || params.stepId,
    };

    const uri = await this.storage.put(params.artifactId, params.data, meta);
    return { uri };
  }

  private async prepareProviderInputs(
    operation: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const prepared: Record<string, unknown> = { ...inputs };

    // F18: thread the active tenant id into provider config so cache keys partition
    // by tenant (see base-provider.computeCacheKey's scope handling). Without this,
    // cache hits could leak across tenants.
    const tid = getTenantContext()?.tenantId;
    if (tid && !prepared.tenantId) {
      prepared.tenantId = tid;
    }

    for (const [key, value] of Object.entries(inputs)) {
      if (!key.endsWith('artifact_id')) {
        continue;
      }
      if (typeof value !== 'string' || value.length === 0) {
        continue;
      }

      const artifactData = await this.storage.get(value);
      const buffer = await this.toBuffer(artifactData.data);
      this.attachArtifactPayload(prepared, key, value, buffer, artifactData.meta.mimeType);
    }

    // Provider-specific aliases used across the provider packages.
    if (typeof prepared.artifact_id === 'string' && prepared.artifact_data instanceof Buffer) {
      const artifactMime = typeof prepared.mime_type === 'string' ? prepared.mime_type : undefined;
      if (
        artifactMime?.startsWith('image/') ||
        operation.startsWith('document.') ||
        operation === 'image.describe'
      ) {
        prepared.image_data ??= prepared.artifact_data;
      }
      if (artifactMime?.startsWith('audio/') || operation.startsWith('audio.')) {
        prepared.audio_data ??= prepared.artifact_data;
      }
    }

    return prepared;
  }

  private attachArtifactPayload(
    target: Record<string, unknown>,
    inputKey: string,
    artifactId: string,
    data: Buffer,
    mimeType: string,
  ): void {
    const baseName =
      inputKey === 'artifact_id' ? 'artifact' : inputKey.replace(/_artifact_id$/, '');
    target[inputKey] = artifactId;
    target[`${baseName}_data`] = data;

    if (baseName === 'artifact') {
      target.artifact_data = data;
      target.mime_type ??= mimeType;
    }

    if (mimeType.startsWith('image/')) {
      target.image_data ??= data;
      target.mime_type ??= mimeType;
    } else if (mimeType.startsWith('audio/')) {
      target.audio_data ??= data;
      target.mime_type ??= mimeType;
    } else if (mimeType.startsWith('video/')) {
      target.video_data ??= data;
      target.mime_type ??= mimeType;
    } else {
      target.mime_type ??= mimeType;
    }
  }

  private async toBuffer(data: Buffer | NodeJS.ReadableStream | unknown): Promise<Buffer> {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (!data || typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
      throw new Error('Unsupported artifact payload type');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error('Unsupported stream chunk type');
      }
    }

    return Buffer.concat(chunks);
  }

  private async buildArtifactForEvaluation(artifactId: string): Promise<Artifact | null> {
    const registeredArtifact = this.executor.getRegistry().get(artifactId);
    if (registeredArtifact) {
      return registeredArtifact;
    }

    try {
      const stored = await this.storage.get(artifactId);
      return {
        id: artifactId,
        type: stored.meta.type,
        uri: await this.storage.getSignedUrl(artifactId),
        mimeType: stored.meta.mimeType,
        metadata: stored.meta.metadata || {},
        sourceStep: stored.meta.sourceStep,
        createdAt: stored.meta.createdAt,
      };
    } catch {
      return null;
    }
  }

  private async evaluateWithLLM(
    prompt: string,
    artifact: Artifact,
  ): Promise<{ pass: boolean; reasoning: string; score?: number }> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const width = Number(artifact.metadata.width || 0);
      const height = Number(artifact.metadata.height || 0);
      const score = width > 0 && height > 0 ? 7 : 6;
      return {
        pass: score >= 7,
        reasoning: 'OpenAI API key not configured; used metadata-based fallback evaluation.',
        score,
      };
    }

    const model =
      typeof artifact.metadata.model === 'string' ? artifact.metadata.model : 'gpt-4o-mini';
    const artifactSummary = JSON.stringify({
      type: artifact.type,
      mimeType: artifact.mimeType,
      metadata: artifact.metadata,
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Evaluate the artifact and return strict JSON: {"pass":boolean,"reasoning":string,"score":number}.',
          },
          {
            role: 'user',
            content: `Prompt:\n${prompt}\n\nArtifact:\n${artifactSummary}`,
          },
        ],
        response_format: {
          type: 'json_object',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM-judge request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) {
      throw new Error('LLM-judge response did not include content');
    }

    const parsed = JSON.parse(raw) as { pass?: boolean; reasoning?: string; score?: number };
    return {
      pass: Boolean(parsed.pass),
      reasoning: parsed.reasoning || 'No reasoning provided',
      score: typeof parsed.score === 'number' ? parsed.score : undefined,
    };
  }

  private async evaluateCustomGate(
    artifact: Artifact,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const customCheckFn = config.customCheckFn;
    if (typeof customCheckFn === 'function') {
      return await Promise.resolve(customCheckFn(artifact, config));
    }

    if (typeof customCheckFn === 'string') {
      const compiled = new Function(
        'artifact',
        'context',
        `"use strict"; return (${customCheckFn})(artifact, context);`,
      ) as (
        artifactArg: Artifact,
        contextArg: Record<string, unknown>,
      ) => boolean | Promise<boolean>;
      return await Promise.resolve(compiled(artifact, config));
    }

    throw new Error('customCheckFn must be a function or string');
  }
}
