# Provider Management

## Capability

Provider registration, health checks, and routing — manages the lifecycle of media providers (Stability AI, Replicate, OpenAI, etc.) and routes operations to the appropriate provider based on configuration.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `media.providers.list` | `{}` | `{ providers: ProviderInfo[] }` | 60 RPM |
| `media.providers.health` | `{ provider_id: string }` | `{ provider_id: string, healthy: boolean, latency_ms: number, last_check: string }` | 30 RPM |

## Usage Examples

### Example 1: List all providers

**Tool call:**
```json
{}
```

**Expected response:**
```json
{
  "providers": [
    {
      "id": "stability",
      "name": "Stability AI",
      "healthy": true,
      "supported_operations": ["image.generate", "image.inpaint"],
      "models": { "image.generate": "sd3" }
    },
    {
      "id": "replicate",
      "name": "Replicate",
      "healthy": true,
      "supported_operations": ["image.upscale", "image.remove_background"],
      "models": { "image.upscale": "nightmareai/real-esrgan" }
    }
  ]
}
```

### Example 2: Check provider health

**Tool call:**
```json
{ "provider_id": "stability" }
```

**Expected response:**
```json
{
  "provider_id": "stability",
  "healthy": true,
  "latency_ms": 234,
  "last_check": "2026-04-15T23:00:00Z"
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `PROVIDER_UNAVAILABLE` | Provider API down | Use fallback provider if configured |
| `PROVIDER_RATE_LIMITED` | Provider rate limit hit | Exponential backoff, retry |
| `PROVIDER_AUTH_FAILED` | Invalid API key | Alert operator, fail operation |
| `PROVIDER_TIMEOUT` | Provider response timeout | Retry with backoff, use fallback |

## Security Considerations

- **API keys** stored in secrets manager, never in logs
- **Health check endpoints** rate-limited to prevent abuse
- **Provider credentials** rotated regularly
- **Audit logging** for all provider operations

## Performance Characteristics

| Metric | Target |
|--------|--------|
| Provider list latency | < 10ms |
| Health check latency | < 5s (includes API call) |
| Provider routing overhead | < 1ms |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER_HEALTH_CHECK_INTERVAL_MS` | `30000` | Health check interval |
| `PROVIDER_TIMEOUT_MS` | `60000` | Default provider timeout |
| `PROVIDER_RETRY_MAX` | `3` | Max retry attempts |
| `PROVIDER_BACKOFF_BASE_MS` | `1000` | Exponential backoff base |

## Testing

```typescript
describe('provider-management', () => {
  it('should list configured providers', async () => {
    const result = await listProviders();
    expect(result.providers).toHaveLength(3);
    expect(result.providers.find(p => p.id === 'stability')).toBeDefined();
  });

  it('should check provider health', async () => {
    const result = await checkProviderHealth('stability');
    expect(result.healthy).toBe(true);
    expect(result.latency_ms).toBeLessThan(5000);
  });

  it('should execute operation via provider', async () => {
    const result = await executeProviderOperation({
      provider_id: 'stability',
      operation: 'image.generate',
      input: { prompt: 'A test image' }
    });

    expect(result.output.artifact).toBeDefined();
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('should use fallback on primary failure', async () => {
    const mockStability = { execute: vi.fn().mockRejectedValue(new Error('Down')) };
    const mockReplicate = { execute: vi.fn().mockResolvedValue({ artifact: {} }) };

    const result = await executeWithFallback('image.generate', { prompt: 'test' }, {
      primary: mockStability,
      fallbacks: [mockReplicate]
    });

    expect(mockStability.execute).toHaveBeenCalled();
    expect(mockReplicate.execute).toHaveBeenCalled();
    expect(result.output.artifact).toBeDefined();
  });
});
