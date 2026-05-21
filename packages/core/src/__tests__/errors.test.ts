import { describe, expect, it } from 'vitest';
import {
  A2AError,
  ArtifactAccessDeniedError,
  ArtifactNotFoundError,
  BudgetExceededError,
  ContextRefTypeError,
  ContextRefUnknownError,
  EstimateUnsupportedError,
  FfmpegUnavailableError,
  FormatUnsupportedError,
  IdempotencyConflictError,
  InvalidInputError,
  InvalidResourceUriError,
  JudgeUnavailableError,
  KeyVaultUnavailableError,
  LoudnessGateFailedError,
  ProvenanceSigningFailedError,
  RatioUnsupportedError,
  RouterAllCandidatesFailedError,
  RouterFastestIneligibleError,
  RouterNoCandidatesError,
  RunInProgressError,
  RunNotFoundError,
  RunNotResumableError,
  SafetyGateRejectedError,
  SafetyProviderUnavailableError,
  StateStoreUnavailableError,
  TenantNotFoundError,
  TenantPolicyViolationError,
  VariantsAllRejectedError,
  WebhookProviderUnknownError,
  WebhookSignatureInvalidError,
  WorkflowExpiredError,
  WorkflowNotFoundError,
} from '../errors.js';

describe('A2AError (base)', () => {
  it('should create with default message', () => {
    const err = new A2AError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('A2AError');
    expect(err.code).toBe('A2A_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('');
  });

  it('should create with custom message', () => {
    const err = new A2AError('custom message');
    expect(err.message).toBe('custom message');
  });
});

describe('IdempotencyConflictError', () => {
  it('should create for in-flight', () => {
    const err = new IdempotencyConflictError('in-flight');
    expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(err.retryable).toBe(false);
    expect(err.reason).toBe('in-flight');
    expect(err.message).toContain('in-flight');
  });

  it('should create for body-mismatch with existing run id', () => {
    const err = new IdempotencyConflictError('body-mismatch', 'run-123');
    expect(err.reason).toBe('body-mismatch');
    expect(err.existingRunId).toBe('run-123');
    expect(err.message).toContain('body-mismatch');
    expect(err.message).toContain('run-123');
  });
});

describe('BudgetExceededError', () => {
  it('should create with scope and amounts', () => {
    const err = new BudgetExceededError(42.5, 50, 'tenant-daily');
    expect(err.code).toBe('BUDGET_EXCEEDED');
    expect(err.retryable).toBe(false);
    expect(err.spentUsd).toBe(42.5);
    expect(err.capUsd).toBe(50);
    expect(err.scope).toBe('tenant-daily');
    expect(err.message).toContain('42.5');
    expect(err.message).toContain('50');
    expect(err.message).toContain('tenant-daily');
  });
});

describe('RunNotFoundError', () => {
  it('should create with default message', () => {
    const err = new RunNotFoundError();
    expect(err.code).toBe('RUN_NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Run not found');
  });
});

describe('RunInProgressError', () => {
  it('should create with retryable=true', () => {
    const err = new RunInProgressError();
    expect(err.code).toBe('RUN_IN_PROGRESS');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Run is already in progress');
  });
});

describe('RunNotResumableError', () => {
  it('should create', () => {
    const err = new RunNotResumableError();
    expect(err.code).toBe('RUN_NOT_RESUMABLE');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Run is not resumable');
  });
});

describe('WebhookSignatureInvalidError', () => {
  it('should create', () => {
    const err = new WebhookSignatureInvalidError();
    expect(err.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(err.retryable).toBe(false);
  });
});

describe('WebhookProviderUnknownError', () => {
  it('should create', () => {
    const err = new WebhookProviderUnknownError();
    expect(err.code).toBe('WEBHOOK_PROVIDER_UNKNOWN');
    expect(err.retryable).toBe(false);
  });
});

describe('StateStoreUnavailableError', () => {
  it('should create with retryable=true', () => {
    const err = new StateStoreUnavailableError();
    expect(err.code).toBe('STATE_STORE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('State store is unavailable');
  });
});

describe('EstimateUnsupportedError', () => {
  it('should create', () => {
    const err = new EstimateUnsupportedError();
    expect(err.code).toBe('ESTIMATE_UNSUPPORTED');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Cost estimation is not supported for this operation');
  });
});

describe('ArtifactNotFoundError', () => {
  it('should create', () => {
    const err = new ArtifactNotFoundError();
    expect(err.code).toBe('ARTIFACT_NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Artifact not found');
  });
});

describe('RouterAllCandidatesFailedError', () => {
  it('should create with candidates and lastError', () => {
    const cause = new Error('provider error');
    const err = new RouterAllCandidatesFailedError(['p1', 'p2'], cause);
    expect(err.code).toBe('ROUTER_ALL_CANDIDATES_FAILED');
    expect(err.retryable).toBe(false);
    expect(err.attemptedCandidates).toEqual(['p1', 'p2']);
    expect(err.lastError).toBe(cause);
    expect(err.message).toContain('p1');
    expect(err.message).toContain('p2');
  });
});

describe('RouterNoCandidatesError', () => {
  it('should create', () => {
    const err = new RouterNoCandidatesError();
    expect(err.code).toBe('ROUTER_NO_CANDIDATES');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('No eligible router candidates found');
  });
});

describe('RouterFastestIneligibleError', () => {
  it('should create', () => {
    const err = new RouterFastestIneligibleError();
    expect(err.code).toBe('ROUTER_FASTEST_INELIGIBLE');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Fastest router candidate is ineligible');
  });
});

describe('SafetyGateRejectedError', () => {
  it('should create with category and score', () => {
    const err = new SafetyGateRejectedError('nsfw', 0.95);
    expect(err.code).toBe('SAFETY_GATE_REJECTED');
    expect(err.retryable).toBe(false);
    expect(err.category).toBe('nsfw');
    expect(err.score).toBe(0.95);
    expect(err.message).toContain('nsfw');
    expect(err.message).toContain('0.95');
  });
});

describe('TenantNotFoundError', () => {
  it('should create', () => {
    const err = new TenantNotFoundError();
    expect(err.code).toBe('TENANT_NOT_FOUND');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Tenant not found');
  });
});

describe('KeyVaultUnavailableError', () => {
  it('should create with retryable=true', () => {
    const err = new KeyVaultUnavailableError();
    expect(err.code).toBe('KEY_VAULT_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('Key vault is unavailable');
  });
});

describe('FfmpegUnavailableError', () => {
  it('should create', () => {
    const err = new FfmpegUnavailableError();
    expect(err.code).toBe('FFMPEG_UNAVAILABLE');
    expect(err.retryable).toBe(false);
  });
});

describe('VariantsAllRejectedError', () => {
  it('should create with each reason', () => {
    for (const reason of ['safety', 'judge-low', 'generation-error', 'all-failed'] as const) {
      const err = new VariantsAllRejectedError(reason);
      expect(err.code).toBe('VARIANTS_ALL_REJECTED');
      expect(err.retryable).toBe(false);
      expect(err.reason).toBe(reason);
    }
  });
});

describe('JudgeUnavailableError', () => {
  it('should create with retryable=true', () => {
    const err = new JudgeUnavailableError();
    expect(err.code).toBe('JUDGE_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
});

describe('WorkflowNotFoundError', () => {
  it('should create', () => {
    const err = new WorkflowNotFoundError();
    expect(err.code).toBe('WORKFLOW_NOT_FOUND');
    expect(err.retryable).toBe(false);
  });
});

describe('WorkflowExpiredError', () => {
  it('should create', () => {
    const err = new WorkflowExpiredError();
    expect(err.code).toBe('WORKFLOW_EXPIRED');
    expect(err.retryable).toBe(false);
  });
});

describe('ContextRefUnknownError', () => {
  it('should create with kind and name', () => {
    const err = new ContextRefUnknownError('step', 'gen-img');
    expect(err.code).toBe('CONTEXT_REF_UNKNOWN');
    expect(err.retryable).toBe(false);
    expect(err.kind).toBe('step');
    expect(err.name).toBe('gen-img');
  });
});

describe('ContextRefTypeError', () => {
  it('should create with stepOp and refKind', () => {
    const err = new ContextRefTypeError('image.generate', 'audio');
    expect(err.code).toBe('CONTEXT_REF_TYPE_MISMATCH');
    expect(err.retryable).toBe(false);
    expect(err.stepOp).toBe('image.generate');
    expect(err.refKind).toBe('audio');
  });
});

describe('LoudnessGateFailedError', () => {
  it('should create', () => {
    const err = new LoudnessGateFailedError();
    expect(err.code).toBe('LOUDNESS_GATE_FAILED');
    expect(err.retryable).toBe(false);
  });
});

describe('TenantPolicyViolationError', () => {
  it('should create', () => {
    const err = new TenantPolicyViolationError();
    expect(err.code).toBe('TENANT_POLICY_VIOLATION');
    expect(err.retryable).toBe(false);
  });
});

describe('ProvenanceSigningFailedError', () => {
  it('should create', () => {
    const err = new ProvenanceSigningFailedError();
    expect(err.code).toBe('PROVENANCE_SIGNING_FAILED');
    expect(err.retryable).toBe(false);
  });
});

describe('SafetyProviderUnavailableError', () => {
  it('should create with retryable=true', () => {
    const err = new SafetyProviderUnavailableError();
    expect(err.code).toBe('SAFETY_PROVIDER_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
});

describe('RatioUnsupportedError', () => {
  it('should create with ratio and provider', () => {
    const err = new RatioUnsupportedError('16:9', 'stable-diffusion');
    expect(err.code).toBe('RATIO_UNSUPPORTED');
    expect(err.retryable).toBe(false);
    expect(err.ratio).toBe('16:9');
    expect(err.provider).toBe('stable-diffusion');
  });
});

describe('InvalidInputError', () => {
  it('should create with reason', () => {
    const err = new InvalidInputError('prompt is empty');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.retryable).toBe(false);
    expect(err.reason).toBe('prompt is empty');
    expect(err.message).toBe('Invalid input: prompt is empty');
  });
});

describe('FormatUnsupportedError', () => {
  it('should create with format and operation', () => {
    const err = new FormatUnsupportedError('webp', 'image.generate');
    expect(err.code).toBe('FORMAT_UNSUPPORTED');
    expect(err.retryable).toBe(false);
    expect(err.format).toBe('webp');
    expect(err.operation).toBe('image.generate');
    expect(err.message).toBe('Format unsupported: webp for image.generate');
  });
});

describe('ArtifactAccessDeniedError', () => {
  it('should create', () => {
    const err = new ArtifactAccessDeniedError();
    expect(err.code).toBe('ARTIFACT_ACCESS_DENIED');
    expect(err.retryable).toBe(false);
  });
});

describe('InvalidResourceUriError', () => {
  it('should create', () => {
    const err = new InvalidResourceUriError('artifact://bad');
    expect(err.code).toBe('INVALID_RESOURCE_URI');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('artifact://bad');
  });
});
