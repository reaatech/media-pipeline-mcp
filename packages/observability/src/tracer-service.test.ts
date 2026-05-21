import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TracerService } from './tracer-service.js';

describe('TracerService', () => {
  let tracer: TracerService;

  const baseConfig = {
    serviceName: 'test-service',
    serviceVersion: '1.0.0',
  };

  beforeEach(() => {
    tracer = new TracerService(baseConfig);
  });

  it('should create a pipeline span', () => {
    const span = tracer.startPipelineSpan('pipeline-123');
    expect(span).toBeDefined();
    expect(span.spanContext().traceId).toBeDefined();
    span.end();
  });

  it('should create an operation span', () => {
    const span = tracer.startOperationSpan('image.generate', 'stability', 'art-123');
    expect(span).toBeDefined();
    span.end();
  });

  it('should create an operation span without provider or artifactId', () => {
    const span = tracer.startOperationSpan('audio.tts');
    expect(span).toBeDefined();
    span.end();
  });

  it('should create an operation span with provider only', () => {
    const span = tracer.startOperationSpan('image.generate', 'openai');
    expect(span).toBeDefined();
    span.end();
  });

  it('should create an operation span with artifactId only', () => {
    const span = tracer.startOperationSpan('image.generate', undefined, 'art-456');
    expect(span).toBeDefined();
    span.end();
  });

  it('should set span attributes', () => {
    const span = tracer.startPipelineSpan('pipe-1');
    const setAttributesSpy = vi.spyOn(span, 'setAttributes');

    tracer.setSpanAttributes(span, { 'media.custom': 'value', count: 42 });

    expect(setAttributesSpy).toHaveBeenCalledWith({ 'media.custom': 'value', count: 42 });
    span.end();
  });

  it('should record span error', () => {
    const span = tracer.startPipelineSpan('pipe-1');
    const recordExceptionSpy = vi.spyOn(span, 'recordException');
    const setStatusSpy = vi.spyOn(span, 'setStatus');
    const error = new Error('Something went wrong');

    tracer.recordSpanError(span, error);

    expect(recordExceptionSpy).toHaveBeenCalledWith(error);
    expect(setStatusSpy).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    span.end();
  });

  it('should end a span', () => {
    const span = tracer.startPipelineSpan('pipe-1');
    const endSpy = vi.spyOn(span, 'end');

    tracer.endSpan(span);

    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('should execute a function within span context', () => {
    const span = tracer.startPipelineSpan('pipe-1');
    const result = tracer.withSpan(span, () => {
      const activeSpan = trace.getSpan(context.active());
      expect(activeSpan).toBe(span);
      return 42;
    });

    expect(result).toBe(42);
    span.end();
  });

  it('should execute async function within span context', () => {
    const span = tracer.startPipelineSpan('pipe-1');
    const result = tracer.withSpan(span, async () => {
      const activeSpan = trace.getSpan(context.active());
      expect(activeSpan).toBe(span);
      return 'done';
    });

    expect(result).toBeInstanceOf(Promise);
    span.end();
  });

  it('should shutdown', async () => {
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });

  it('should handle shutdown when sdk is undefined', async () => {
    const tracer2 = new TracerService(baseConfig);
    // @ts-expect-error - accessing private for test
    delete tracer2.sdk;
    await expect(tracer2.shutdown()).resolves.toBeUndefined();
  });
});
