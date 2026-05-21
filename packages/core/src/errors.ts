export class A2AError extends Error {
  code: string;
  retryable: boolean;

  constructor(message?: string) {
    super(message);
    this.name = 'A2AError';
    this.code = 'A2A_ERROR';
    this.retryable = false;
  }
}

// Phase 2.1
export class IdempotencyConflictError extends A2AError {
  code = 'IDEMPOTENCY_CONFLICT' as const;
  retryable = false as const;

  constructor(
    public reason: 'in-flight' | 'body-mismatch',
    public existingRunId?: string,
  ) {
    super(
      `Idempotency conflict: ${reason}${existingRunId ? ` (existing run: ${existingRunId})` : ''}`,
    );
  }
}

export class BudgetExceededError extends A2AError {
  code = 'BUDGET_EXCEEDED' as const;
  retryable = false as const;

  constructor(
    public spentUsd: number,
    public capUsd: number,
    public scope: 'run' | 'tenant-daily' | 'tenant-monthly',
  ) {
    super(`Budget exceeded: $${spentUsd} spent, $${capUsd} cap (${scope})`);
  }
}

export class RunNotFoundError extends A2AError {
  code = 'RUN_NOT_FOUND' as const;
  retryable = false as const;

  constructor() {
    super('Run not found');
  }
}

export class RunInProgressError extends A2AError {
  code = 'RUN_IN_PROGRESS' as const;
  retryable = true as const;

  constructor() {
    super('Run is already in progress');
  }
}

export class RunNotResumableError extends A2AError {
  code = 'RUN_NOT_RESUMABLE' as const;
  retryable = false as const;

  constructor() {
    super('Run is not resumable');
  }
}

export class WebhookSignatureInvalidError extends A2AError {
  code = 'WEBHOOK_SIGNATURE_INVALID' as const;
  retryable = false as const;

  constructor() {
    super('Webhook signature is invalid');
  }
}

export class WebhookProviderUnknownError extends A2AError {
  code = 'WEBHOOK_PROVIDER_UNKNOWN' as const;
  retryable = false as const;

  constructor() {
    super('Webhook provider is unknown');
  }
}

export class StateStoreUnavailableError extends A2AError {
  code = 'STATE_STORE_UNAVAILABLE' as const;
  retryable = true as const;

  constructor() {
    super('State store is unavailable');
  }
}

export class EstimateUnsupportedError extends A2AError {
  code = 'ESTIMATE_UNSUPPORTED' as const;
  retryable = false as const;

  constructor() {
    super('Cost estimation is not supported for this operation');
  }
}

export class ArtifactNotFoundError extends A2AError {
  code = 'ARTIFACT_NOT_FOUND' as const;
  retryable = false as const;

  constructor() {
    super('Artifact not found');
  }
}

// Phase 2.2
export class RouterAllCandidatesFailedError extends A2AError {
  code = 'ROUTER_ALL_CANDIDATES_FAILED' as const;
  retryable = false as const;

  constructor(
    public attemptedCandidates: string[],
    public lastError: Error,
  ) {
    super(`All router candidates failed: ${attemptedCandidates.join(', ')}`);
  }
}

export class RouterNoCandidatesError extends A2AError {
  code = 'ROUTER_NO_CANDIDATES' as const;
  retryable = false as const;

  constructor() {
    super('No eligible router candidates found');
  }
}

export class RouterFastestIneligibleError extends A2AError {
  code = 'ROUTER_FASTEST_INELIGIBLE' as const;
  retryable = false as const;

  constructor() {
    super('Fastest router candidate is ineligible');
  }
}

// Phase 2.4
export class SafetyGateRejectedError extends A2AError {
  code = 'SAFETY_GATE_REJECTED' as const;
  retryable = false as const;

  constructor(
    public category: string,
    public score: number,
  ) {
    super(`Safety gate rejected: ${category} (score: ${score})`);
  }
}

export class TenantNotFoundError extends A2AError {
  code = 'TENANT_NOT_FOUND' as const;
  retryable = false as const;

  constructor() {
    super('Tenant not found');
  }
}

export class KeyVaultUnavailableError extends A2AError {
  code = 'KEY_VAULT_UNAVAILABLE' as const;
  retryable = true as const;

  constructor() {
    super('Key vault is unavailable');
  }
}

// Phase 2.7 — Foundation
export class FfmpegUnavailableError extends A2AError {
  code = 'FFMPEG_UNAVAILABLE';
  retryable = false;
}

export class VariantsAllRejectedError extends A2AError {
  code = 'VARIANTS_ALL_REJECTED';
  retryable = false;
  constructor(public reason: 'safety' | 'judge-low' | 'generation-error' | 'all-failed') {
    super();
  }
}

export class JudgeUnavailableError extends A2AError {
  code = 'JUDGE_UNAVAILABLE';
  retryable = true;
}

export class WorkflowNotFoundError extends A2AError {
  code = 'WORKFLOW_NOT_FOUND';
  retryable = false;
  constructor(public workflowName?: string) {
    super(workflowName ? `Workflow not found: ${workflowName}` : 'Workflow not found');
  }
}

export class WorkflowExpiredError extends A2AError {
  code = 'WORKFLOW_EXPIRED';
  retryable = false;
  constructor(public detail?: string) {
    // Plan §F10 expected behavior: "ComfyUI expired | resume after retentionMs |
    // WorkflowExpiredError". The legacy ComfyUI provider raised a plain Error with
    // message "did not complete within retention period"; preserved here as the
    // default detail so existing test assertions continue to pass.
    super(
      `Workflow expired${detail ? `: ${detail}` : ' — did not complete within retention period'}`,
    );
  }
}

export class ContextRefUnknownError extends A2AError {
  code = 'CONTEXT_REF_UNKNOWN';
  retryable = false;
  constructor(
    public kind: string,
    public name: string,
  ) {
    super();
  }
}

export class ContextRefTypeError extends A2AError {
  code = 'CONTEXT_REF_TYPE_MISMATCH';
  retryable = false;
  constructor(
    public stepOp: string,
    public refKind: string,
  ) {
    super();
  }
}

export class LoudnessGateFailedError extends A2AError {
  code = 'LOUDNESS_GATE_FAILED';
  retryable = false;
}

export class TenantPolicyViolationError extends A2AError {
  code = 'TENANT_POLICY_VIOLATION';
  retryable = false;
}

export class ProvenanceSigningFailedError extends A2AError {
  code = 'PROVENANCE_SIGNING_FAILED';
  retryable = false;
}

export class SafetyProviderUnavailableError extends A2AError {
  code = 'SAFETY_PROVIDER_UNAVAILABLE';
  retryable = true;
}

export class RatioUnsupportedError extends A2AError {
  code = 'RATIO_UNSUPPORTED';
  retryable = false;
  constructor(
    public ratio: string,
    public provider: string,
  ) {
    super(`Ratio ${ratio} not natively supported by provider ${provider}`);
  }
}

export class InvalidInputError extends A2AError {
  code = 'INVALID_INPUT';
  retryable = false;
  constructor(public reason: string) {
    super(`Invalid input: ${reason}`);
  }
}

export class FormatUnsupportedError extends A2AError {
  code = 'FORMAT_UNSUPPORTED';
  retryable = false;
  constructor(
    public format: string,
    public operation: string,
  ) {
    super(`Format unsupported: ${format} for ${operation}`);
  }
}

export class ArtifactAccessDeniedError extends A2AError {
  code = 'ARTIFACT_ACCESS_DENIED';
  retryable = false;
}

export class InvalidResourceUriError extends A2AError {
  code = 'INVALID_RESOURCE_URI';
  retryable = false;
  constructor(public uri?: string) {
    super(uri ? `Invalid resource URI: ${uri}` : 'Invalid resource URI');
  }
}
