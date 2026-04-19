# Cost Tracking

## Capability

Per-call cost recording and aggregation — tracks costs for every provider operation, aggregates by session/pipeline/operation type, and provides budget alerts to prevent unexpected spending.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `media.costs.summary` | `{}` | `{ total_usd: number, by_operation: Record<string, number>, by_provider: Record<string, number>, budget_remaining_usd: number }` | 60 RPM |

## Usage Examples

### Example 1: Get cost summary

**Tool call:**
```json
{}
```

**Expected response:**
```json
{
  "total_usd": 2.45,
  "by_operation": {
    "image.generate": 1.50,
    "image.upscale": 0.45,
    "audio.tts": 0.50
  },
  "by_provider": {
    "stability": 1.50,
    "replicate": 0.45,
    "elevenlabs": 0.50
  },
  "budget_remaining_usd": 97.55
}
```

### Example 2: Get budget status

**Tool call:**
```json
{}
```

**Expected response:**
```json
{
  "daily_budget": 100,
  "monthly_budget": 2000,
  "daily_spent": 25.50,
  "monthly_spent": 450.75,
  "daily_remaining": 74.50,
  "monthly_remaining": 1549.25
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `BUDGET_EXCEEDED` | Spending exceeds configured budget | Halt operations, alert operator |
| `COST_RECORDING_FAILED` | Failed to record cost | Log warning, continue operation |

## Security Considerations

- Cost data is sensitive — restrict access to authorized users
- Budget alerts should not expose detailed spending patterns
- Audit logging for budget changes and overrides

## Performance Characteristics

| Metric | Target |
|--------|--------|
| Cost recording latency | < 1ms |
| Cost summary aggregation | < 10ms |
| Budget check latency | < 1ms |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `COST_BUDGET_DAILY_USD` | `100` | Daily spending limit |
| `COST_BUDGET_MONTHLY_USD` | `2000` | Monthly spending limit |
| `COST_ALERT_THRESHOLD_PCT` | `80` | Alert at this % of budget |

## Testing

```typescript
describe('cost-tracking', () => {
  it('should record and aggregate costs', async () => {
    await recordCost({ operation: 'image.generate', provider: 'stability', cost_usd: 0.007 });
    await recordCost({ operation: 'image.generate', provider: 'stability', cost_usd: 0.007 });

    const summary = await getCostSummary();
    expect(summary.total_usd).toBeCloseTo(0.014);
    expect(summary.by_operation['image.generate']).toBeCloseTo(0.014);
  });

  it('should enforce daily budget', async () => {
    setBudget({ daily: 1.00 });

    await recordCost({ operation: 'image.generate', cost_usd: 0.60 });
    expect(await checkBudget()).toBe(true);

    await recordCost({ operation: 'image.generate', cost_usd: 0.60 });
    expect(await checkBudget()).toBe(false); // Exceeds budget
  });
});
