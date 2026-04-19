# Artifact Management

## Capability

Artifact storage, retrieval, and lifecycle management — handles the persistence and access of media artifacts (images, videos, audio, text, documents) across pipeline steps and after completion.

## MCP Tools

| Tool | Input Schema | Output | Rate Limit |
|------|-------------|--------|------------|
| `media.artifact.get` | `{ artifact_id: string }` | `{ artifact: Artifact, data: ReadableStream \| Buffer }` | 120 RPM |
| `media.artifact.list` | `{ prefix?: string, limit?: number, types?: string[] }` | `{ artifacts: Artifact[], next_token?: string }` | 60 RPM |
| `media.artifact.delete` | `{ artifact_id: string }` | `{ success: boolean, deleted_uri?: string }` | 30 RPM |


## Usage Examples

### Example 1: Retrieve artifact

**Tool call:**
```json
{ "artifact_id": "artifact-123" }
```

**Expected response:**
```json
{
  "artifact": {
    "id": "artifact-123",
    "type": "image",
    "uri": "s3://bucket/artifacts/artifact-123.png",
    "mimeType": "image/png",
    "metadata": { "width": 1024, "height": 1024, "fileSize": 524288 },
    "sourceStep": "image.generate"
  }
}
```

### Example 2: List artifacts

**Tool call:**
```json
{ "prefix": "pipelines/product-photo/", "limit": 10, "types": ["image"] }
```

**Expected response:**
```json
{
  "artifacts": [
    { "id": "artifact-1", "type": "image", "uri": "s3://...", "metadata": {} },
    { "id": "artifact-2", "type": "image", "uri": "s3://...", "metadata": {} }
  ],
  "next_token": "eyJsYXN0S2V5IjoiYXJ0aWZhY3QtMiJ9"
}
```

### Example 3: Get signed URL

**Tool call:**
```json
{ "artifact_id": "artifact-123", "expires_in_seconds": 3600 }
```

**Expected response:**
```json
{
  "signed_url": "https://bucket.s3.amazonaws.com/artifacts/artifact-123.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
  "expires_at": "2026-04-16T00:00:00Z"
}
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `ARTIFACT_NOT_FOUND` | Artifact ID doesn't exist | Return 404, suggest checking artifact_id |
| `STORAGE_UNAVAILABLE` | Storage backend down | Retry with backoff, fail if persistent |
| `ACCESS_DENIED` | No permission to access artifact | Return 403, check permissions |
| `ARTIFACT_EXPIRED` | Artifact TTL expired | Return 410, artifact no longer available |

## Security Considerations

- **Signed URLs** for external access with configurable expiration
- **Access control** based on artifact ownership and permissions
- **No PII in artifact metadata** — validate on ingestion
- **Audit logging** for all artifact access and deletion

## Performance Characteristics

| Metric | Target |
|--------|--------|
| Get artifact metadata | < 10ms |
| Get artifact data | Storage-dependent |
| List artifacts | < 100ms for 100 items |
| Delete artifact | < 50ms |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_TYPE` | `local` | Storage backend (local/s3/gcs) |
| `ARTIFACT_TTL_HOURS` | `24` | Default TTL for artifacts |
| `SIGNED_URL_EXPIRY_SECONDS` | `3600` | Default signed URL expiration |
| `MAX_ARTIFACT_SIZE_MB` | `100` | Maximum artifact size |

## Testing

```typescript
describe('artifact-management', () => {
  it('should store and retrieve artifact', async () => {
    const artifact = await storeArtifact({
      type: 'image',
      data: Buffer.from('test'),
      metadata: { width: 100, height: 100 }
    });

    const retrieved = await getArtifact(artifact.id);
    expect(retrieved.artifact.id).toBe(artifact.id);
  });

  it('should list artifacts by prefix', async () => {
    await storeArtifact({ type: 'image', prefix: 'test/' });
    await storeArtifact({ type: 'image', prefix: 'test/' });

    const result = await listArtifacts({ prefix: 'test/' });
    expect(result.artifacts).toHaveLength(2);
  });

  it('should delete artifact', async () => {
    const artifact = await storeArtifact({ type: 'image' });
    const result = await deleteArtifact(artifact.id);
    expect(result.success).toBe(true);

    await expect(getArtifact(artifact.id)).rejects.toThrow('ARTIFACT_NOT_FOUND');
  });
});
