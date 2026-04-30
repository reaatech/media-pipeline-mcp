import type { CostRecord, CostSummary } from '@reaatech/media-pipeline-mcp';

export interface BudgetConfig {
  dailyLimit?: number;
  monthlyLimit?: number;
  perPipelineLimit?: number;
  alertThreshold?: number; // 0.0 to 1.0
}

export interface BudgetStatus {
  withinBudget: boolean;
  dailySpent: number;
  monthlySpent: number;
  pipelineSpent: number;
  alertLevel: 'ok' | 'warning' | 'critical' | 'exceeded';
}

export class CostTracker {
  private records: CostRecord[] = [];
  private summary: CostSummary = {
    total_usd: 0,
    by_operation: new Map(),
    by_provider: new Map(),
    by_pipeline: new Map(),
  };
  private budgetConfig?: BudgetConfig;
  private dailySpend = 0;
  private monthlySpend = 0;
  private lastDailyReset?: Date;
  private lastMonthlyReset?: Date;

  constructor(budgetConfig?: BudgetConfig) {
    this.budgetConfig = budgetConfig;
    this.resetDaily();
    this.resetMonthly();
  }

  private resetDaily(): void {
    this.dailySpend = 0;
    this.lastDailyReset = new Date();
  }

  private resetMonthly(): void {
    this.monthlySpend = 0;
    this.lastMonthlyReset = new Date();
  }

  private checkBudgetReset(): void {
    const now = new Date();

    // Check daily reset
    if (this.lastDailyReset) {
      const dayDiff = now.getTime() - this.lastDailyReset.getTime();
      if (dayDiff >= 24 * 60 * 60 * 1000) {
        this.resetDaily();
      }
    }

    // Check monthly reset - use month/year comparison
    if (this.lastMonthlyReset) {
      const lastMonth = this.lastMonthlyReset.getMonth();
      const lastYear = this.lastMonthlyReset.getFullYear();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      if (currentYear > lastYear || (currentYear === lastYear && currentMonth > lastMonth)) {
        this.resetMonthly();
      }
    }
  }

  canAfford(cost: number, pipelineId?: string): boolean {
    if (!this.budgetConfig) return true;

    this.checkBudgetReset();

    if (this.budgetConfig.dailyLimit && this.dailySpend + cost > this.budgetConfig.dailyLimit) {
      return false;
    }
    if (
      this.budgetConfig.monthlyLimit &&
      this.monthlySpend + cost > this.budgetConfig.monthlyLimit
    ) {
      return false;
    }
    if (pipelineId && this.budgetConfig.perPipelineLimit) {
      const pipelineCost = this.summary.by_pipeline.get(pipelineId) || 0;
      if (pipelineCost + cost > this.budgetConfig.perPipelineLimit) {
        return false;
      }
    }
    return true;
  }

  getBudgetStatus(pipelineId?: string): BudgetStatus {
    this.checkBudgetReset();

    const alertThreshold = this.budgetConfig?.alertThreshold || 0.9;
    let alertLevel: 'ok' | 'warning' | 'critical' | 'exceeded' = 'ok';

    if (this.budgetConfig) {
      if (this.budgetConfig.dailyLimit) {
        const ratio = this.dailySpend / this.budgetConfig.dailyLimit;
        if (ratio >= 1) alertLevel = 'exceeded';
        else if (ratio >= alertThreshold) alertLevel = 'critical';
        else if (ratio >= alertThreshold * 0.75) alertLevel = 'warning';
      }
      if (this.budgetConfig.monthlyLimit) {
        const ratio = this.monthlySpend / this.budgetConfig.monthlyLimit;
        if (ratio >= 1) alertLevel = 'exceeded';
        else if (ratio >= alertThreshold) alertLevel = 'critical';
        else if (ratio >= alertThreshold * 0.75) alertLevel = 'warning';
      }
    }

    return {
      withinBudget: alertLevel !== 'exceeded',
      dailySpent: this.dailySpend,
      monthlySpent: this.monthlySpend,
      pipelineSpent: pipelineId ? this.summary.by_pipeline.get(pipelineId) || 0 : 0,
      alertLevel,
    };
  }

  record(record: CostRecord): void {
    // Check budget before recording
    if (!this.canAfford(record.cost_usd, record.pipelineId)) {
      throw new Error(`Budget exceeded for operation: ${record.operation}`);
    }

    this.records.push(record);

    // Update totals
    this.summary.total_usd += record.cost_usd;
    this.dailySpend += record.cost_usd;
    this.monthlySpend += record.cost_usd;

    // By operation
    const opCost = this.summary.by_operation.get(record.operation) || 0;
    this.summary.by_operation.set(record.operation, opCost + record.cost_usd);

    // By provider
    const providerCost = this.summary.by_provider.get(record.provider) || 0;
    this.summary.by_provider.set(record.provider, providerCost + record.cost_usd);

    // By pipeline
    if (record.pipelineId) {
      const pipelineCost = this.summary.by_pipeline.get(record.pipelineId) || 0;
      this.summary.by_pipeline.set(record.pipelineId, pipelineCost + record.cost_usd);
    }
  }

  getSummary(): CostSummary {
    return { ...this.summary };
  }

  getRecords(): CostRecord[] {
    return [...this.records];
  }

  getPipelineCost(pipelineId: string): number {
    return this.summary.by_pipeline.get(pipelineId) || 0;
  }

  getOperationCost(operation: string): number {
    return this.summary.by_operation.get(operation) || 0;
  }

  getProviderCost(provider: string): number {
    return this.summary.by_provider.get(provider) || 0;
  }

  reset(): void {
    this.records = [];
    this.summary = {
      total_usd: 0,
      by_operation: new Map(),
      by_provider: new Map(),
      by_pipeline: new Map(),
    };
    this.resetDaily();
    this.resetMonthly();
  }
}
