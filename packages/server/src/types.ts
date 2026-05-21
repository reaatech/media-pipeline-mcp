export interface MCPProgressValue {
  kind: 'pipeline-progress';
  runId: string;
  stepId?: string;
  totalSteps?: number;
  completedSteps?: number;
  currentStepPct?: number;
  etaMs?: number;
  message?: string;
  costUsdAccrued?: number;
  budgetWarning?: boolean;
}
