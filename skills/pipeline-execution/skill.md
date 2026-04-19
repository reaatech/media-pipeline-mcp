# Pipeline Execution

## Capability

Execute pipeline definitions with artifact passing between steps — the core skill that enables chainable media operations with quality gates.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `media.pipeline.define` | `{ pipeline: PipelineDefinition }` | `{ valid: boolean, estimated_cost_usd: number, estimated_duration_ms: number, errors: string[] }` | 60 RPM |
| `media.pipeline.run` | `{ pipeline: PipelineDefinition \| string, wait?: boolean }` | `{ pipeline_id: string, status: 'running' \| 'completed' \| 'failed' \| 'gated', artifacts: Artifact[], cost_usd: number, duration_ms: number }` | 30 RPM |
| `media.pipeline.status` | `{ pipeline_id: string }` | `{ pipeline_id: string, status: PipelineStatus, current_step?: string, completed_steps: string[], artifacts: Artifact[], cost_usd: number }` | 120 RPM |
| `media.pipeline.resume` | `{ pipeline_id: string, action: 'retry' \| 'skip' \| 'abort' }` | `{ pipeline_id: string, status: PipelineStatus, resumed_from_step?: string }` | 30 RPM |

## Usage Examples

### Example 1: Define and validate a pipeline

**User intent:** Validate a pipeline definition before execution

**Tool call:**
```json
{
  "pipeline": {
    "id": "product-photo",
    "steps": [
      {
        "id": "generate",
        "operation": "image.generate",
        "inputs": { "prompt": "Professional product photo" },
        "config": { "model": "sd3", "dimensions": "1024x1024" }
      },
      {
        "id": "upscale",
        "operation": "image.upscale",
        "inputs": { "artifact_id": "{{generate.output}}" },
        "config": { "scale": "4x" }
      }
    ]
  }
}
```

**Expected response:**
```json
{
  "valid": true,
  "estimated_cost_usd": 0.014,
  "estimated_duration_ms": 8500,
  "errors": []
}
```

### Example 2: Execute a pipeline

**User intent:** Run a complete media pipeline

**Tool call:**
```json
{
  "pipeline": {
    "id": "social-media-post",
    "steps": [
      {
        "id": "generate",
        "operation": "image.generate",
        "inputs": { "prompt": "A modern logo for a tech startup" },
        "config": { "dimensions": "1024x1024" },
        "qualityGate": {
          "type": "llm-judge",
          "config": { "prompt": "Is this a professional-looking logo?" },
          "action": "retry",
          "maxRetries": 2
        }
      }
    ]
  },
  "wait": true
}
```

**Expected response:**
```json
{
  "pipeline_id": "social-media-post",
  "status": "completed",
  "artifacts": [
    {
      "id": "artifact-123",
      "type": "image",
      "uri": "s3://bucket/artifacts/artifact-123.png",
      "mimeType": "image/png",
      "metadata": { "width": 1024, "height": 1024 },
      "sourceStep": "generate"
    }
  ],
  "cost_usd": 0.007,
  "duration_ms": 4523
}
```

### Example 3: Check pipeline status

**User intent:** Monitor a long-running pipeline

**Tool call:**
```json
{
  "pipeline_id": "video-render-456"
}
```

**Expected response (in progress):**
```json
{
  "pipeline_id": "video-render-456",
  "status": "running",
  "current_step": "video.encode",
  "completed_steps": ["video.generate", "video.add_audio"],
  "artifacts": [
    {
      "id": "artifact-789",
      "type": "video",
      "uri": "s3://bucket/artifacts/artifact-789.mp4",
      "sourceStep": "video.generate"
    }
  ],
  "cost_usd": 0.15
}
```

### Example 4: Resume a gated pipeline

**User intent:** Retry a pipeline that failed a quality gate

**Tool call:**
```json
{
  "pipeline_id": "product-photo-789",
  "action": "retry"
}
```

**Expected response:**
```json
{
  "pipeline_id": "product-photo-789",
  "status": "running",
  "resumed_from_step": "generate"
}
```

## Error Handling

### Known failure modes

| Error | Cause | Recovery |
|-------|-------|----------|
| `INVALID_PIPELINE` | Pipeline definition fails validation | Return detailed errors, do not execute |
| `CIRCULAR_REFERENCE` | Step references create a cycle | Return error with cycle details |
| `PROVIDER_UNAVAILABLE` | Required provider is down | Fail pipeline or use fallback if configured |
| `QUALITY_GATE_FAILED` | Quality gate evaluation returned fail | Retry (if configured) or halt with "gated" status |
| `STEP_TIMEOUT` | Step exceeds configured timeout | Fail step, mark pipeline as failed |
| `ARTIFACT_NOT_FOUND` | Referenced artifact doesn't exist | Fail step with actionable error |
| `COST_BUDGET_EXCEEDED` | Pipeline would exceed budget | Halt before execution, return cost error |

### Recovery strategies

1. **Provider failures** — Retry with exponential backoff, fall back to secondary provider if configured.

2. **Quality gate failures** — If action is "retry", re-execute the step with same inputs. Track retry count and halt after maxRetries.

3. **Timeout failures** — Fail the step and pipeline. User must fix timeout configuration or optimize pipeline.

4. **Circular references** — Detected during validation. Return clear error with the cycle path.

### Escalation paths

- **Repeated pipeline failures** → Alert on-call engineer
- **High quality gate failure rate** → Review gate configuration or provider quality
- **Cost anomalies** → Alert when spending exceeds thresholds

## Security Considerations

### PII handling

- **Never log raw prompts or artifact content** — Use artifact IDs and summaries
- **Never include user data in pipeline definitions** — Use placeholders
- **Redact sensitive metadata** in logs

### Permission requirements

- Pipeline execution requires `pipeline:run` permission
- Artifact access requires `artifact:read` permission
- Provider access requires `provider:read` permission

### Audit logging

Log these events for compliance:
- Pipeline execution start/end
- Quality gate results
- Cost accumulation
- Provider failures

### Input validation

- All pipeline definitions validated against schema
- Variable interpolation sanitized (prevent injection)
- Step graph validated for cycles and orphaned steps

## Performance Characteristics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Pipeline validation latency | < 100ms | Schema validation + graph analysis |
| Step execution latency | Provider-dependent | Varies by operation |
| Artifact passing overhead | < 10ms | In-memory registry lookup |
| Quality gate evaluation | < 5s | LLM-judge includes API call |
| Concurrent pipelines | 100+ | Per-instance capacity |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PIPELINE_TIMEOUT_MS` | `300000` | Default pipeline timeout (5 minutes) |
| `STEP_TIMEOUT_MS` | `60000` | Default step timeout (60 seconds) |
| `MAX_PIPELINE_STEPS` | `50` | Maximum steps per pipeline |
| `QUALITY_GATE_TIMEOUT_MS` | `30000` | Timeout for LLM-judge evaluation |
| `COST_BUDGET_DAILY` | `100` | Daily cost budget in USD |
| `COST_BUDGET_MONTHLY` | `2000` | Monthly cost budget in USD |

## Testing

### Unit tests

```typescript
describe('pipeline-execution', () => {
  it('should execute 3-step pipeline successfully', async () => {
    const pipeline = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {}
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },
          config: {}
        },
        {
          id: 'step3',
          operation: 'mock.extract',
          inputs: { artifact_id: '{{step2.output}}' },
          config: {}
        }
      ]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(3);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should halt on quality gate failure', async () => {
    const pipeline = {
      id: 'test-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.width', operator: '>=', value: 99999 }] },
            action: 'fail'
          }
        }
      ]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('gated');
    expect(result.gatedStep).toBe('step1');
  });

  it('should detect circular references', async () => {
    const pipeline = {
      id: 'circular-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { artifact_id: '{{step2.output}}' },  // References step2
          config: {}
        },
        {
          id: 'step2',
          operation: 'mock.transform',
          inputs: { artifact_id: '{{step1.output}}' },  // References step1
          config: {}
        }
      ]
    };

    const result = await validatePipeline(pipeline);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('circular'));
  });

  it('should retry on quality gate failure with maxRetries', async () => {
    let attemptCount = 0;
    const mockProviderWithFailures = {
      ...mockProvider,
      execute: async () => {
        attemptCount++;
        if (attemptCount < 3) {
          return { /* low quality result */ };
        }
        return { /* high quality result */ };
      }
    };

    const pipeline = {
      id: 'retry-pipeline',
      steps: [
        {
          id: 'step1',
          operation: 'mock.generate',
          inputs: { prompt: 'test' },
          config: {},
          qualityGate: {
            type: 'threshold',
            config: { checks: [{ field: 'metadata.quality', operator: '>=', value: 0.8 }] },
            action: 'retry',
            maxRetries: 3
          }
        }
      ]
    };

    const result = await executePipeline(pipeline, { providers: [mockProviderWithFailures] });

    expect(result.status).toBe('completed');
    expect(attemptCount).toBe(3);
  });
});

### Integration tests

```typescript
describe('MCP pipeline execution', () => {
  it('should execute pipeline via MCP tool call', async () => {
    const response = await fetch('http://localhost:8080/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'tools/call',
        params: {
          name: 'media.pipeline.run',
          arguments: {
            pipeline: {
              id: 'test',
              steps: [{
                id: 'step1',
                operation: 'mock.generate',
                inputs: { prompt: 'test' },
                config: {}
              }]
            },
            wait: true
          }
        }
      })
    });

    const result = await response.json();
    expect(result.result.status).toBe('completed');
    expect(result.result.artifacts).toHaveLength(1);
  });

  it('should validate pipeline before execution', async () => {
    const response = await fetch('http://localhost:8080/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-2',
        method: 'tools/call',
        params: {
          name: 'media.pipeline.define',
          arguments: {
            pipeline: {
              id: 'test',
              steps: [{
                id: 'step1',
                operation: 'image.generate',
                inputs: { prompt: 'test' },
                config: {}
              }]
            }
          }
        }
      })
    });

    const result = await response.json();
    expect(result.result.valid).toBe(true);
    expect(result.result.estimated_cost_usd).toBeDefined();
  });
});
