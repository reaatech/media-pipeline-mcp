import { describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  BudgetExceededError,
  InvalidInputError,
  MockProvider,
  PipelineEstimator,
  PipelineExecutor,
  RunNotFoundError,
  createEventBus,
} from '../index.js';

describe('package exports (index.ts)', () => {
  it('should export PipelineExecutor', () => {
    expect(PipelineExecutor).toBeDefined();
    expect(PipelineExecutor).toBeInstanceOf(Function);
  });

  it('should export PipelineEstimator', () => {
    expect(PipelineEstimator).toBeDefined();
    expect(PipelineEstimator).toBeInstanceOf(Function);
  });

  it('should export createEventBus', () => {
    expect(createEventBus).toBeDefined();
    expect(createEventBus).toBeInstanceOf(Function);
  });

  it('should export MockProvider', () => {
    expect(MockProvider).toBeDefined();
    expect(MockProvider).toBeInstanceOf(Function);
  });

  it('should export error classes', () => {
    expect(ArtifactNotFoundError).toBeDefined();
    expect(BudgetExceededError).toBeDefined();
    expect(InvalidInputError).toBeDefined();
    expect(RunNotFoundError).toBeDefined();

    const err = new ArtifactNotFoundError();
    expect(err.code).toBe('ARTIFACT_NOT_FOUND');
  });
});
