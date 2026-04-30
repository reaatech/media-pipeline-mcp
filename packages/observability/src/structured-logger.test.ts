import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StructuredLogger } from './structured-logger';

describe('StructuredLogger', () => {
  let logger: StructuredLogger;

  beforeEach(() => {
    logger = new StructuredLogger({
      serviceName: 'test-service',
      serviceVersion: '1.0.0',
      logLevel: 'debug',
    });
  });

  it('should log at all levels', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('debug message');
    expect(debugSpy).toHaveBeenCalled();

    logger.info('info message');
    expect(infoSpy).toHaveBeenCalled();

    logger.warn('warn message');
    expect(warnSpy).toHaveBeenCalled();

    logger.error('error message');
    expect(errorSpy).toHaveBeenCalled();

    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should include context in log output', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test message', { pipelineId: 'pipe-123', stepId: 'step-1' });

    expect(consoleSpy).toHaveBeenCalled();
    const logOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);
    expect(parsed.pipelineId).toBe('pipe-123');
    expect(parsed.stepId).toBe('step-1');

    consoleSpy.mockRestore();
  });

  it('should log operation completion with all details', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.logOperation('image.generate', 'stability', 'artifact-123', 0.01, 2500);

    const logOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);
    expect(parsed.operation).toBe('image.generate');
    expect(parsed.provider).toBe('stability');
    expect(parsed.artifactId).toBe('artifact-123');
    expect(parsed.costUsd).toBe(0.01);
    expect(parsed.durationMs).toBe(2500);

    consoleSpy.mockRestore();
  });

  it('should log pipeline step status changes', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.logPipelineStep('pipe-123', 'step-1', 'image.generate', 'complete');

    const logOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);
    expect(parsed.pipelineId).toBe('pipe-123');
    expect(parsed.stepId).toBe('step-1');
    expect(parsed.operation).toBe('image.generate');
    expect(parsed.status).toBe('complete');

    consoleSpy.mockRestore();
  });

  it('should respect log level filtering', () => {
    const debugLogger = new StructuredLogger({
      serviceName: 'test',
      serviceVersion: '1.0.0',
      logLevel: 'error',
    });

    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    debugLogger.debug('should not appear');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should include error details in error logs', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const testError = new Error('Test error');
    logger.error('Something failed', testError, { pipelineId: 'pipe-123' });

    const logOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toBe('Test error');
    expect(parsed.pipelineId).toBe('pipe-123');

    consoleSpy.mockRestore();
  });
});
