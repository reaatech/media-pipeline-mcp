# Architecture — media-pipeline-mcp

## System Overview

media-pipeline-mcp is an MCP server that provides chainable media processing pipelines with quality gates. It consists of three main packages:

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Provider  │  │    Cost     │  │   Tool Handlers         │  │
│  │  Registry   │  │   Tracker   │  │  (pipeline, artifact,   │  │
│  │             │  │             │  │   provider, cost)       │  │
│  └──────┬──────┘  └─────────────┘  └─────────────────────────┘  │
│         │                                                         │
│         ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Pipeline Executor                          ││
│  │  ┌───────────┐    ┌──────────────┐    ┌──────────────────┐  ││
│  │  │   Step    │───▶│ Quality Gate │───▶│ Artifact Registry│  ││
│  │  │ Executor  │    │  Evaluators  │    │                  │  ││
│  │  └───────────┘    └──────────────┘    └──────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Storage Layer                               │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐               │
│  │   Local   │    │    S3     │    │    GCS    │               │
│  │ Filesystem│    │           │    │           │               │
│  └───────────┘    └───────────┘    └───────────┘               │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Providers                                 │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌────────┐ │
│  │   Mock    │    │  OpenAI   │    │ Stability │    │Replicate││
│  │ (testing) │    │           │    │    AI     │    │         ││
│  └───────────┘    └───────────┘    └───────────┘    └────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Package Structure

### `@reaatech/media-pipeline-mcp`
The core pipeline engine with:
- **Types**: Zod-validated schemas for Pipeline, Step, Artifact, QualityGate
- **PipelineExecutor**: Sequential step execution with artifact passing
- **QualityGates**: Threshold, dimension-check, LLM-judge evaluators
- **ArtifactRegistry**: In-memory artifact tracking during execution
- **PipelineValidator**: Validates pipeline definitions before execution
- **MockProvider**: For testing without real API calls

### `@reaatech/media-pipeline-mcp-storage`
Storage abstraction with adapters:
- **LocalStorage**: Filesystem storage with TTL cleanup
- **S3Storage**: AWS S3 with presigned URLs
- **GCSStorage**: Google Cloud Storage with signed URLs

### `@reaatech/media-pipeline-mcp-server`
MCP server implementation:
- **MCPServer**: Main server with tool handlers
- **ProviderRegistry**: Provider registration and health checks
- **CostTracker**: Per-call cost recording and aggregation
- **Config**: Zod-validated configuration with env var support

## Data Flow

1. **Pipeline Definition**: Client sends a pipeline definition via MCP tool call
2. **Validation**: PipelineValidator checks step graph, references, and provider availability
3. **Execution**: PipelineExecutor runs steps sequentially:
   - Resolve inputs (literal values or `{{step.output}}` references)
   - Find provider for operation
   - Execute via provider
   - Register artifact
   - Evaluate quality gate (if configured)
   - Handle retry/fail/warn based on gate result
4. **Storage**: Artifacts stored via storage layer
5. **Response**: Return pipeline status, artifacts, cost, and duration

## Quality Gates

Quality gates run between steps to validate output:

| Type | Description | Use Case |
|------|-------------|----------|
| `threshold` | Numeric checks on metadata fields | Min dimensions, max file size |
| `dimension-check` | Verify output dimensions match expectations | Ensure 1024x1024 output |
| `llm-judge` | LLM evaluates output quality | Check image relevance to prompt |
| `custom` | User-provided function | Programmatic validation |

Actions: `fail` (halt), `retry` (re-execute up to maxRetries), `warn` (log and continue)

## Provider Interface

```typescript
interface Provider {
  readonly name: string;
  readonly supportedOperations: string[];
  execute(operation: string, inputs: Record<string, unknown>, config: Record<string, unknown>): Promise<{
    artifact: Omit<Artifact, 'id' | 'createdAt'>;
    cost_usd?: number;
    duration_ms?: number;
  }>;
  healthCheck(): Promise<boolean>;
}
```

Providers self-register their supported operations. The executor routes operations to the registered provider.

## Configuration

Configuration is loaded from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | HTTP listen port |
| `HOST` | 0.0.0.0 | Listen address |
| `LOG_LEVEL` | info | Log level (error/warn/info/debug) |
| `STORAGE_TYPE` | local | Storage backend (local/s3/gcs) |
| `STORAGE_PATH` | ./artifacts | Local storage path |
| `STORAGE_TTL` | — | TTL in seconds for local storage |
| `S3_BUCKET` | media-artifacts | S3 bucket name |
| `S3_REGION` | us-east-1 | S3 region |
| `GCS_BUCKET` | media-artifacts | GCS bucket name |

## Security

- API keys via environment variables only (never hardcoded)
- Input validation with Zod schemas
- Non-root container user
- Structured logging (no binary data in logs)

## Observability

- Structured JSON logging
- Pipeline events emitted during execution
- Cost tracking per operation/provider/pipeline
- Provider health checks on startup
