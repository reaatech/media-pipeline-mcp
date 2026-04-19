# Deployment Guide

## Prerequisites

- Node.js 18+
- pnpm 8+
- Provider credentials for desired backends (OpenAI, Anthropic, Replicate, Google, etc.)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run
pnpm --filter=@media-pipeline/server start
```

## Environment Variables

### Server Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8080` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `LOG_LEVEL` | No | `info` | Log level (error/warn/info/debug) |

### Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STORAGE_TYPE` | No | `local` | Storage backend (local/s3/gcs) |
| `STORAGE_PATH` | No | `./artifacts` | Local storage path |
| `STORAGE_TTL` | No | - | TTL in seconds for local storage |
| `STORAGE_SERVE_HTTP` | No | `false` | Serve artifacts via HTTP |
| `S3_BUCKET` | Conditional | - | S3 bucket name (when STORAGE_TYPE=s3) |
| `S3_REGION` | No | `us-east-1` | S3 region |
| `S3_PREFIX` | No | `artifacts/` | S3 key prefix |
| `GCS_BUCKET` | Conditional | - | GCS bucket name (when STORAGE_TYPE=gcs) |
| `GCS_PREFIX` | No | `artifacts/` | GCS key prefix |

### Authentication

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_ENABLED` | No | `false` | Enable JWT/API key authentication |
| `JWT_SECRET` | Conditional | - | Secret for JWT signing (required if AUTH_ENABLED=true) |
| `API_KEYS` | No | - | Comma-separated API keys for authentication |

### Rate Limiting

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | No | `true` | Enable rate limiting |
| `RATE_LIMIT_RPM` | No | `60` | Requests per minute per client |
| `RATE_LIMIT_BURST` | No | `10` | Burst size |
| `EXPENSIVE_OPS_RPM` | No | `10` | Expensive operations per minute |

### Budget

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUDGET_DAILY_LIMIT` | No | - | Daily cost budget in USD |
| `BUDGET_MONTHLY_LIMIT` | No | - | Monthly cost budget in USD |
| `BUDGET_PER_PIPELINE_LIMIT` | No | - | Per-pipeline budget limit in USD |
| `BUDGET_ALERT_THRESHOLD` | No | `0.9` | Alert threshold (0-1) |

### Provider Credentials

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Conditional | OpenAI API key |
| `ANTHROPIC_API_KEY` | Conditional | Anthropic API key |
| `STABILITY_API_KEY` | Conditional | Stability AI API key |
| `REPLICATE_API_KEY` | Conditional | Replicate API key |
| `ELEVENLABS_API_KEY` | Conditional | ElevenLabs API key |
| `DEEPGRAM_API_KEY` | Conditional | Deepgram API key |
| `FAL_API_KEY` | Conditional | Fal API key |
| `GOOGLE_PROJECT_ID` | Conditional | Google Cloud project ID for Google provider |
| `GOOGLE_LOCATION` | No | Google Cloud location for Document AI / Vertex AI |
| `GOOGLE_DOCUMENT_AI_PROCESSOR_ID` | No | Document AI processor ID for OCR/table/field extraction |
| `GOOGLE_GEMINI_MODEL` | No | Gemini model name for `image.describe` |
| `GOOGLE_KEY_FILE` | No | Service account JSON path for Google SDK authentication |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Standard Google credentials env var, used as fallback |

## Authentication

The server supports JWT-based authentication and API key validation. Configure via environment variables or pass headers through an API gateway.

### Server-Side Authentication

```bash
# Enable JWT authentication
AUTH_ENABLED=true
JWT_SECRET=your-secret-key

# Or use API keys
AUTH_ENABLED=true
API_KEYS=key1,key2,key3
```

### Using Authentication

Include credentials in request headers:

```bash
# JWT Token
curl -H "Authorization: Bearer <jwt_token>" http://localhost:8080/...

# API Key
curl -H "X-API-Key: <api_key>" http://localhost:8080/...
```

### API Gateway (Recommended for Production)

For production deployments, an API gateway is still recommended for centralized auth, IP filtering, and edge rate limiting:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   AI Client     │────▶│  API Gateway    │────▶│  MCP Server     │
│  (Claude, etc)  │     │  (Auth + Rate)  │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

Configure your gateway to forward the original auth headers or pass user context:

```bash
# Headers forwarded to MCP server
X-User-Id: user-123
X-User-Roles: admin,operator
```

## Storage Configuration

### Local Storage (Development)

```bash
STORAGE_TYPE=local
STORAGE_PATH=./artifacts
```

### S3 Storage (Production)

```bash
STORAGE_TYPE=s3
S3_BUCKET=my-media-artifacts
S3_REGION=us-east-1
S3_PREFIX=artifacts/
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}
```

### GCS Storage (Production)

```bash
STORAGE_TYPE=gcs
GCS_BUCKET=my-media-artifacts
GCS_PREFIX=artifacts/
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Google Provider (Document AI / Vertex AI)

```bash
GOOGLE_PROJECT_ID=my-gcp-project
GOOGLE_LOCATION=us-central1
GOOGLE_DOCUMENT_AI_PROCESSOR_ID=processor-id
GOOGLE_GEMINI_MODEL=gemini-1.5-pro
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

## Provider Configuration

Register provider credentials in your configuration:

```typescript
// config.ts
providers: [
  {
    name: 'openai',
    operations: ['image.generate', 'audio.tts'],
    config: { apiKey: process.env.OPENAI_API_KEY }
  },
  {
    name: 'replicate',
    operations: ['image.upscale', 'image.remove_background'],
    config: { apiKey: process.env.REPLICATE_API_KEY }
  },
  {
    name: 'google',
    operations: ['document.ocr', 'document.extract_tables', 'document.extract_fields', 'image.describe'],
    config: {
      projectId: process.env.GOOGLE_PROJECT_ID,
      location: process.env.GOOGLE_LOCATION,
      documentAiProcessorId: process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID,
      geminiModel: process.env.GOOGLE_GEMINI_MODEL,
      keyFile: process.env.GOOGLE_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
    }
  }
]
```

## Health Checks

Provider health is monitored via MCP tools:

```bash
# Check all providers via MCP tool
# POST to http://localhost:8080/tools/call with:
{
  "name": "media.providers.list",
  "arguments": {}
}

# Check specific provider via MCP tool
{
  "name": "media.providers.health",
  "arguments": { "provider_id": "openai" }
}
```

Note: Health checks are performed via MCP tool calls, not HTTP REST endpoints.

## Monitoring

### Metrics

The server exposes Prometheus metrics at `/metrics`:

- `media_pipeline_requests_total` - Total requests by operation
- `media_pipeline_request_duration_ms` - Request latency
- `media_pipeline_cost_usd` - Cumulative cost by operation
- `media_pipeline_artifacts_total` - Total artifacts stored

### Logging

Structured JSON logs are written to stdout. Configure your log aggregator:

```json
{
  "timestamp": "2026-04-18T10:30:00Z",
  "level": "info",
  "service": "media-pipeline-mcp",
  "operation": "image.generate",
  "provider": "openai",
  "artifact_id": "artifact-123",
  "cost_usd": 0.04,
  "duration_ms": 2345,
  "request_id": "req-789"
}
```

## Security Checklist

- [ ] Deploy behind API gateway with authentication
- [ ] Use HTTPS in production
- [ ] Set daily/monthly budget limits
- [ ] Rotate API keys regularly
- [ ] Enable audit logging
- [ ] Monitor for unusual activity
- [ ] Keep dependencies updated

## Troubleshooting

### Server won't start

1. Check port is not in use: `lsof -i :8080`
2. Verify storage directory exists and is writable
3. Check environment variables are set correctly

### Authentication not working

1. Verify API gateway is forwarding headers correctly
2. Check X-User-Id header is being passed
3. Review server logs for auth errors

### Cost overages

1. Enable budget limits: `BUDGET_DAILY_LIMIT=100`
2. Check cost tracker via MCP tool:
```json
{
  "name": "media.costs.summary",
  "arguments": {}
}
```
3. Review operation costs in provider documentation

## Support

For issues and security concerns, please contact security@media-pipeline.dev
