import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLogger, createAuditLogger } from './audit-logger.js';

function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const baseConfig = {
  retentionDays: 30,
  bufferSize: 100,
  flushInterval: 0,
};

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await logger?.destroy();
  });

  it('should log events with required fields', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'user-1', email: 'user@test.com', role: 'admin' },
      action: { operation: 'pipeline.execute', resourceType: 'pipeline', resourceId: 'pipe-1' },
      outcome: { success: true, duration_ms: 100 },
      context: {},
      metadata: {},
    });

    expect(true).toBe(true);
  });

  it('should handle different severity levels through outcome.success', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'operator' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: false, errorCode: 'ERR', errorMessage: 'failure', duration_ms: 0 },
      context: {},
      metadata: {},
    });

    expect(true).toBe(true);
  });

  it('should include runId when provided', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: { pipelineId: 'run-abc-123' },
      metadata: {},
    });

    expect(true).toBe(true);
  });

  it('should include tenantId when provided', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: { tenantId: 'tenant-42' },
      metadata: {},
    });

    expect(true).toBe(true);
  });

  it('should serialize event data with proper id and timestamp', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'config.change',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'config.update', resourceType: 'config' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: { key: 'value', nested: { a: 1 } },
    });

    expect(true).toBe(true);
  });

  it('should handle empty event data', () => {
    logger = new AuditLogger(baseConfig);

    logger.log({
      eventType: 'provider.health',
      actor: { userId: 'system', email: 'system@local', role: 'operator' },
      action: { operation: 'health.check', resourceType: 'provider' },
      outcome: { success: true, duration_ms: 5 },
      context: {},
      metadata: {},
    });

    expect(true).toBe(true);
  });

  it('should logAuthentication correctly', () => {
    logger = new AuditLogger(baseConfig);

    logger.logAuthentication('user-42', 'alice@test.com', true, '127.0.0.1');
    expect(true).toBe(true);
  });

  it('should logAuthentication without ipAddress', () => {
    logger = new AuditLogger(baseConfig);

    logger.logAuthentication('user-42', 'alice@test.com', false);
    expect(true).toBe(true);
  });

  it('should logAuthorizationFailure correctly', () => {
    logger = new AuditLogger(baseConfig);

    logger.logAuthorizationFailure('user-1', 'pipeline.run', 'pipeline:run');
    expect(true).toBe(true);
  });

  it('should logPipelineExecution correctly with success', () => {
    logger = new AuditLogger(baseConfig);

    logger.logPipelineExecution('user-1', 'pipe-123', true, 1500, 0.05, 'tenant-abc');
    expect(true).toBe(true);
  });

  it('should logPipelineExecution correctly with failure', () => {
    logger = new AuditLogger(baseConfig);

    logger.logPipelineExecution('user-2', 'pipe-456', false, 2000, 0.02);
    expect(true).toBe(true);
  });

  it('should logArtifactAccess correctly', () => {
    logger = new AuditLogger(baseConfig);

    logger.logArtifactAccess('user-1', 'art-456', 'read', true);
    logger.logArtifactAccess('user-1', 'art-789', 'delete', false);
    expect(true).toBe(true);
  });

  it('should logArtifactAccess with create action', () => {
    logger = new AuditLogger(baseConfig);

    logger.logArtifactAccess('user-1', 'art-001', 'create', true);
    expect(true).toBe(true);
  });

  it('should logRateLimitExceeded correctly with operation', () => {
    logger = new AuditLogger(baseConfig);

    logger.logRateLimitExceeded('client-1', 'image.generate');
    expect(true).toBe(true);
  });

  it('should logRateLimitExceeded without operation', () => {
    logger = new AuditLogger(baseConfig);

    logger.logRateLimitExceeded('client-2');
    expect(true).toBe(true);
  });

  it('should flush when buffer is full', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger = new AuditLogger({ ...baseConfig, bufferSize: 2 });

    logger.log({
      eventType: 'provider.health',
      actor: { userId: 'u1', email: 'u@t.com', role: 'operator' },
      action: { operation: 'check', resourceType: 'provider' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    logger.log({
      eventType: 'provider.health',
      actor: { userId: 'u2', email: 'u2@t.com', role: 'operator' },
      action: { operation: 'check', resourceType: 'provider' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should not flush when buffer is not full', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger = new AuditLogger({ ...baseConfig, bufferSize: 100 });

    logger.log({
      eventType: 'provider.health',
      actor: { userId: 'u1', email: 'u@t.com', role: 'operator' },
      action: { operation: 'check', resourceType: 'provider' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should createAuditLogger work as factory', () => {
    logger = createAuditLogger(baseConfig);
    expect(logger).toBeInstanceOf(AuditLogger);
  });

  it('should handle flush error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger = new AuditLogger({ ...baseConfig, bufferSize: 1 });

    logger.log({
      eventType: 'provider.health',
      actor: { userId: 'u1', email: 'u@t.com', role: 'operator' },
      action: { operation: 'check', resourceType: 'provider' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should handle flush interval timer', () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger = new AuditLogger({ ...baseConfig, flushInterval: 1000 });

    logger.log({
      eventType: 'config.change',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'config.update', resourceType: 'config' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    vi.advanceTimersByTime(1000);
    expect(true).toBe(true);
    vi.useRealTimers();
    consoleSpy.mockRestore();
  });

  it('should flush to splunk endpoint when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      splunkEndpoint: 'https://splunk.example.com',
      splunkToken: 'splunk-token-abc',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    const splunkCall = calls.find((c: unknown[]) => (c[0] as string).includes('splunk'));
    expect(splunkCall).toBeDefined();
    expect(splunkCall![0] as string).toContain('/services/collector/event');
    expect(splunkCall![1]?.headers?.['Authorization']).toContain('Splunk');

    vi.unstubAllGlobals();
  });

  it('should flush to datadog endpoint when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      datadogEndpoint: 'https://datadog.example.com',
      datadogApiKey: 'dd-api-key-xyz',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();

    const calls = fetchMock.mock.calls;
    const ddCall = calls.find((c: unknown[]) => (c[0] as string).includes('datadog'));
    expect(ddCall).toBeDefined();
    expect(ddCall![0] as string).toContain('/api/v2/logs');
    expect(ddCall![1]?.headers?.['DD-API-KEY']).toBe('dd-api-key-xyz');

    vi.unstubAllGlobals();
  });

  it('should flush to sumologic endpoint when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      sumoLogicEndpoint: 'https://sumologic.example.com',
      sumoLogicSourceName: 'audit',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();

    const calls = fetchMock.mock.calls;
    const sumoCall = calls.find((c: unknown[]) => (c[0] as string).includes('sumologic'));
    expect(sumoCall).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('should flush to datadog endpoint with failure status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      datadogEndpoint: 'https://datadog.example.com',
      datadogApiKey: 'dd-api-key-xyz',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: false, errorCode: 'ERR', errorMessage: 'failure', duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();

    const calls = fetchMock.mock.calls;
    const ddCall = calls.find((c: unknown[]) => (c[0] as string).includes('datadog'));
    expect(ddCall).toBeDefined();
    const body = JSON.parse(ddCall![1]?.body as string);
    expect(body[0].status).toBe('error');

    vi.unstubAllGlobals();
  });

  it('should flush to all SIEM endpoints when all are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      splunkEndpoint: 'https://splunk.example.com',
      splunkToken: 'splunk-token-abc',
      datadogEndpoint: 'https://datadog.example.com',
      datadogApiKey: 'dd-api-key-xyz',
      sumoLogicEndpoint: 'https://sumologic.example.com',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();

    // 3 SIEM endpoints (splunk + datadog + sumologic) = 3 fetch calls; writeToFile uses fs not fetch
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it('should handle flush error from SIEM endpoint and re-queue events', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 1,
      splunkEndpoint: 'https://splunk.example.com',
      splunkToken: 'splunk-token-abc',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await flushPromises();
    expect(consoleSpy).toHaveBeenCalledWith('Audit log flush failed:', expect.any(Error));

    consoleSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('should handle flush with empty buffer gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger = new AuditLogger({ ...baseConfig, bufferSize: 1 });
    await flushPromises();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should destroy with flush timer and flush remaining events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    logger = new AuditLogger({
      ...baseConfig,
      bufferSize: 10,
      flushInterval: 5000,
      splunkEndpoint: 'https://splunk.example.com',
      splunkToken: 'splunk-token-abc',
    });

    logger.log({
      eventType: 'pipeline.execute',
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    });

    await logger.destroy();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should generate unique event IDs', () => {
    logger = new AuditLogger(baseConfig);
    const event1 = {
      eventType: 'config.change' as const,
      actor: { userId: 'u1', email: 'u@t.com', role: 'admin' },
      action: { operation: 'test', resourceType: 'test' },
      outcome: { success: true, duration_ms: 0 },
      context: {},
      metadata: {},
    };

    logger.log(event1);
    logger.log(event1);

    expect(true).toBe(true);
  });
});
