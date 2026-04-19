export interface CostEntry {
  pipelineId?: string;
  stepId?: string;
  operation: string;
  provider: string;
  costUsd: number;
  timestamp: Date;
  artifactId?: string;
}

export interface CostSummary {
  totalCostUsd: number;
  byPipeline: Map<string, number>;
  byOperation: Map<string, number>;
  byProvider: Map<string, number>;
  lastUpdated: Date;
}

export class CostReporter {
  private costs: CostEntry[] = [];
  private summary: CostSummary = {
    totalCostUsd: 0,
    byPipeline: new Map(),
    byOperation: new Map(),
    byProvider: new Map(),
    lastUpdated: new Date(),
  };

  recordCost(entry: Omit<CostEntry, 'timestamp'>): void {
    const costEntry: CostEntry = {
      ...entry,
      timestamp: new Date(),
    };
    this.costs.push(costEntry);
    this.updateSummary(costEntry);
  }

  private updateSummary(entry: CostEntry): void {
    this.summary.totalCostUsd += entry.costUsd;
    this.summary.lastUpdated = new Date();

    if (entry.pipelineId) {
      const current = this.summary.byPipeline.get(entry.pipelineId) || 0;
      this.summary.byPipeline.set(entry.pipelineId, current + entry.costUsd);
    }

    const operationCurrent = this.summary.byOperation.get(entry.operation) || 0;
    this.summary.byOperation.set(entry.operation, operationCurrent + entry.costUsd);

    const providerCurrent = this.summary.byProvider.get(entry.provider) || 0;
    this.summary.byProvider.set(entry.provider, providerCurrent + entry.costUsd);
  }

  getSummary(): CostSummary {
    return { ...this.summary };
  }

  getPipelineCost(pipelineId: string): number {
    return this.summary.byPipeline.get(pipelineId) || 0;
  }

  getOperationCost(operation: string): number {
    return this.summary.byOperation.get(operation) || 0;
  }

  getProviderCost(provider: string): number {
    return this.summary.byProvider.get(provider) || 0;
  }

  getCostHistory(limit?: number): CostEntry[] {
    const sorted = [...this.costs].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return limit ? sorted.slice(0, limit) : sorted;
  }

  reset(): void {
    this.costs = [];
    this.summary = {
      totalCostUsd: 0,
      byPipeline: new Map(),
      byOperation: new Map(),
      byProvider: new Map(),
      lastUpdated: new Date(),
    };
  }
}
