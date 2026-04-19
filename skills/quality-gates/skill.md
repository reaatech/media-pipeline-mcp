# Quality Gates

## Capability

Quality gate evaluation for pipeline steps — validates output quality between steps using LLM-judge, threshold checks, dimension checks, and custom evaluators to ensure only acceptable outputs proceed through the pipeline.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `quality_gate.evaluate` | `{ artifact_id: string, gate: { type: 'llm-judge' \| 'threshold' \| 'dimension-check' \| 'custom', config: Record<string, unknown>, action?: 'fail' \| 'retry' \| 'warn' } }` | `{ pass: boolean, score?: number, reasoning?: string, action: 'pass' \| 'fail' \| 'retry' \| 'warn' }` | 60 RPM |

## Usage Examples

### Example 1: LLM-Judge evaluation

**User intent:** Evaluate image quality using an LLM

**Tool call:**
```json
{
  "artifact_id": "artifact-123",
  "gate": {
    "type": "llm-judge",
    "config": {
      "prompt": "Evaluate this image on a scale of 1-10 for: relevance to prompt, visual quality, and composition. Return a JSON object with scores and a 'pass' boolean (pass if average score >= 7).",
      "model": "gpt-4o-mini"
    },
    "action": "fail"
  }
}
```

**Expected response:**
```json
{
  "pass": true,
  "score": 0.85,
  "reasoning": "Image scores: relevance 8/10, visual quality 9/10, composition 8/10. Average: 8.3/10. The image is well-composed and highly relevant to the prompt.",
  "action": "pass"
}
```

### Example 2: Threshold check

**User intent:** Validate image dimensions meet requirements

**Tool call:**
```json
{
  "artifact_id": "artifact-456",
  "gate": {
    "type": "threshold",
    "config": {
      "checks": [
        { "field": "metadata.width", "operator": ">=", "value": 1024 },
        { "field": "metadata.height", "operator": ">=", "value": 1024 },
        { "field": "metadata.fileSize", "operator": "<", "value": 10485760 }
      ]
    },
    "action": "fail"
  }
}
```

**Expected response:**
```json
{
  "pass": true,
  "results": [
    { "field": "metadata.width", "operator": ">=", "value": 1024, "actual": 2048, "pass": true },
    { "field": "metadata.height", "operator": ">=", "value": 1024, "actual": 2048, "pass": true },
    { "field": "metadata.fileSize", "operator": "<", "value": 10485760, "actual": 5242880, "pass": true }
  ],
  "action": "pass"
}
```

### Example 3: Dimension check

**User intent:** Verify image dimensions match expected aspect ratio

**Tool call:**
```json
{
  "artifact_id": "artifact-789",
  "gate": {
    "type": "dimension-check",
    "config": {
      "expectedWidth": 1024,
      "expectedHeight": 1024,
      "tolerance": 0.05
    },
    "action": "warn"
  }
}
```

**Expected response:**
```json
{
  "pass": true,
  "actualWidth": 1024,
  "actualHeight": 1024,
  "deviation": 0
}
```

### Example 4: Custom gate

**User intent:** Run a custom evaluation function

**Tool call:**
```json
{
  "artifact_id": "artifact-custom",
  "gate": {
    "type": "custom",
    "config": {
      "customCheckFn": "async (artifact, context) => { return { pass: true, score: 1.0 }; }"
    },
    "action": "fail"
  }
}
```

**Expected response:**
```json
{
  "pass": true,
  "score": 0.88,
  "reasoning": "Product visibility: 9/10 (clearly visible, well-lit). Background: 8/10 (clean, non-distracting). Lighting: 9/10 (even, professional). Composition: 8/10 (well-framed). Weighted score: 8.6/10.",
  "action": "pass"
}
```

## Error Handling

### Known failure modes

| Error | Cause | Recovery |
|-------|-------|----------|
| `LLM_JUDGE_TIMEOUT` | LLM API timeout | Return error, pipeline step can retry or fail |
| `LLM_JUDGE_PARSE_ERROR` | LLM returned invalid JSON | Retry once, then fail with parse error |
| `ARTIFACT_NOT_ACCESSIBLE` | Cannot retrieve artifact for evaluation | Fail gate, artifact URI invalid or inaccessible |
| `INVALID_THRESHOLD_CHECK` | Malformed threshold check | Return validation error, do not evaluate |
| `METADATA_MISSING` | Required metadata field not found | Fail check, suggest adding metadata |

### Recovery strategies

1. **LLM-Judge failures** — Retry with exponential backoff. If all retries fail, return error and let pipeline decide (retry step or fail).

2. **Artifact retrieval failures** — Fail the gate immediately. The artifact should always be accessible during pipeline execution.

3. **Parse errors** — Retry once with a stricter prompt. If still failing, return error with raw LLM output for debugging.

### Escalation paths

- **High LLM-Judge failure rate** → Check LLM provider health, review prompt templates
- **Consistent threshold failures** → Review threshold values or provider output quality
- **Dimension check failures** → Review provider configuration or model selection

## Security Considerations

### PII handling

- **Never include artifact content in logs** — Only log artifact IDs and metadata
- **Never log LLM-Judge prompts with user data** — Sanitize prompts before sending to LLM
- **Redact URLs** in logs — Use artifact IDs instead of full URIs

### Permission requirements

- Quality gate evaluation requires `quality_gate:evaluate` permission
- LLM-Judge requires `llm:call` permission for the configured model
- Artifact access requires `artifact:read` permission

### Audit logging

Log these events for compliance:
- Quality gate evaluations (type, result, artifact_id)
- LLM-Judge calls (model, prompt_hash, result)
- Gate failures with reasoning

### Prompt injection defense

- Sanitize prompts before sending to LLM
- Validate LLM responses against expected schema
- Limit prompt length to prevent overflow
- Use structured output format (JSON) to prevent injection

## Performance Characteristics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Threshold check latency | < 1ms | In-memory evaluation |
| Dimension check latency | < 1ms | Simple numeric comparison |
| LLM-Judge latency (p50) | < 3s | Includes LLM API call |
| LLM-Judge latency (p99) | < 10s | Including retries |
| LLM-Judge cost | $0.001-0.01 | Depends on model and prompt length |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QUALITY_GATE_LLM_MODEL` | `gpt-4o-mini` | Default model for LLM-Judge |
| `QUALITY_GATE_LLM_TIMEOUT_MS` | `30000` | Timeout for LLM API calls |
| `QUALITY_GATE_MAX_RETRIES` | `2` | Max retries for failed evaluations |
| `QUALITY_GATE_RETRY_BACKOFF_MS` | `1000` | Initial backoff for retries |
| `LLM_JUDGE_MAX_PROMPT_LENGTH` | `4000` | Max characters in LLM prompt |

## Testing

### Unit tests

```typescript
describe('quality-gates', () => {
  describe('threshold', () => {
    it('should pass when all checks pass', () => {
      const artifact = {
        id: 'test-1',
        metadata: { width: 1024, height: 1024, fileSize: 1000000 }
      };

      const result = evaluateThreshold(artifact, {
        checks: [
          { field: 'metadata.width', operator: '>=', value: 1024 },
          { field: 'metadata.height', operator: '>=', value: 1024 },
          { field: 'metadata.fileSize', operator: '<', value: 5000000 }
        ]
      });

      expect(result.pass).toBe(true);
      expect(result.results.every(r => r.pass)).toBe(true);
    });

    it('should fail when any check fails', () => {
      const artifact = {
        id: 'test-2',
        metadata: { width: 512, height: 1024 }
      };

      const result = evaluateThreshold(artifact, {
        checks: [
          { field: 'metadata.width', operator: '>=', value: 1024 }
        ]
      });

      expect(result.pass).toBe(false);
      expect(result.results[0].pass).toBe(false);
    });

    it('should support all comparison operators', () => {
      const artifact = { id: 'test-3', metadata: { value: 100 } };

      expect(evaluateThreshold(artifact, { checks: [{ field: 'metadata.value', operator: '==', value: 100 }]}).pass).toBe(true);
      expect(evaluateThreshold(artifact, { checks: [{ field: 'metadata.value', operator: '!=', value: 50 }]}).pass).toBe(true);
      expect(evaluateThreshold(artifact, { checks: [{ field: 'metadata.value', operator: '>', value: 50 }]}).pass).toBe(true);
      expect(evaluateThreshold(artifact, { checks: [{ field: 'metadata.value', operator: '<', value: 200 }]}).pass).toBe(true);
      expect(evaluateThreshold(artifact, { checks: [{ field: 'metadata.value', operator: '<=', value: 100 }]}).pass).toBe(true);
    });
  });

  describe('dimension-check', () => {
    it('should pass when dimensions match exactly', () => {
      const artifact = { id: 'test-4', metadata: { width: 1024, height: 1024 } };

      const result = evaluateDimensionCheck(artifact, {
        expectedWidth: 1024,
        expectedHeight: 1024
      });

      expect(result.pass).toBe(true);
      expect(result.deviation).toBe(0);
    });

    it('should pass within tolerance', () => {
      const artifact = { id: 'test-5', metadata: { width: 1020, height: 1020 } };

      const result = evaluateDimensionCheck(artifact, {
        expectedWidth: 1024,
        expectedHeight: 1024,
        tolerance: 0.05
      });

      expect(result.pass).toBe(true);
      expect(result.deviation).toBeLessThanOrEqual(0.05);
    });

    it('should fail outside tolerance', () => {
      const artifact = { id: 'test-6', metadata: { width: 800, height: 800 } };

      const result = evaluateDimensionCheck(artifact, {
        expectedWidth: 1024,
        expectedHeight: 1024,
        tolerance: 0.05
      });

      expect(result.pass).toBe(false);
    });
  });

  describe('llm-judge', () => {
    it('should call LLM and parse response', async () => {
      const artifact = { id: 'test-7', type: 'image', uri: 's3://bucket/test.png' };

      const mockLLM = {
        call: vi.fn().mockResolvedValue({
          content: JSON.stringify({ pass: true, scores: { quality: 8 }, reasoning: 'Good image' })
        })
      };

      const result = await evaluateLLMJudge(artifact, {
        prompt: 'Evaluate this image',
        model: 'gpt-4o-mini'
      }, { llm: mockLLM });

      expect(result.pass).toBe(true);
      expect(result.reasoning).toContain('Good image');
      expect(mockLLM.call).toHaveBeenCalled();
    });

    it('should handle LLM parse errors', async () => {
      const artifact = { id: 'test-8', type: 'image', uri: 's3://bucket/test.png' };

      const mockLLM = {
        call: vi.fn().mockResolvedValue({
          content: 'Invalid JSON response'
        })
      };

      await expect(evaluateLLMJudge(artifact, {
        prompt: 'Evaluate this image'
      }, { llm: mockLLM })).rejects.toThrow('parse_error');
    });

    it('should apply weighted criteria', async () => {
      const artifact = { id: 'test-9', type: 'image', uri: 's3://bucket/test.png' };

      const mockLLM = {
        call: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            pass: true,
            scores: { visibility: 9, background: 7, lighting: 8 },
            reasoning: 'Good overall'
          })
        })
      };

      const result = await evaluateLLMJudge(artifact, {
        prompt: 'Evaluate product photo',
        criteria: { visibility: 0.5, background: 0.25, lighting: 0.25 }
      }, { llm: mockLLM });

      expect(result.score).toBeCloseTo(8.0); // (9*0.5 + 7*0.25 + 8*0.25) = 8.0
    });
  });
});

### Integration tests

```typescript
describe('quality-gates integration', () => {
  it('should evaluate quality gate in pipeline context', async () => {
    const pipeline = {
      id: 'gate-test',
      steps: [{
        id: 'step1',
        operation: 'mock.generate',
        inputs: { prompt: 'test' },
        config: {},
        qualityGate: {
          type: 'threshold',
          config: { checks: [{ field: 'metadata.width', operator: '>=', value: 1024 }] },
          action: 'fail'
        }
      }]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('gated');
    expect(result.gatedStep).toBe('step1');
  });

  it('should retry step on quality gate failure with retry action', async () => {
    let attemptCount = 0;
    const mockProvider = {
      execute: async () => {
        attemptCount++;
        return {
          artifact: { id: `artifact-${attemptCount}`, metadata: { width: attemptCount === 3 ? 1024 : 512 } }
        };
      }
    };

    const pipeline = {
      id: 'retry-test',
      steps: [{
        id: 'step1',
        operation: 'mock.generate',
        inputs: { prompt: 'test' },
        config: {},
        qualityGate: {
          type: 'threshold',
          config: { checks: [{ field: 'metadata.width', operator: '>=', value: 1024 }] },
          action: 'retry',
          maxRetries: 3
        }
      }]
    };

    const result = await executePipeline(pipeline, { providers: [mockProvider] });

    expect(result.status).toBe('completed');
    expect(attemptCount).toBe(3);
  });
});
