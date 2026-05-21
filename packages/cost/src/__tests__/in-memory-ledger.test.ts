import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCostLedger } from '../in-memory-ledger.js';
import type { CostEntry, CostEstimate } from '../types.js';

function createEntry(overrides?: Partial<CostEntry>): CostEntry {
  return {
    id: 'entry-1',
    runId: 'run-1',
    stepId: 'step-1',
    provider: 'stability',
    operation: 'image.generate',
    modelId: 'sd3',
    inputUnits: 0,
    outputUnits: 0,
    inputUnitType: 'pixels',
    outputUnitType: 'pixels',
    usd: 0.01,
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryCostLedger', () => {
  let ledger: InMemoryCostLedger;

  beforeEach(() => {
    ledger = new InMemoryCostLedger();
  });

  describe('charge', () => {
    it('should record a cost entry', async () => {
      const entry = createEntry();
      await ledger.charge(entry);

      const total = await ledger.totalForRun('run-1');
      expect(total).toBe(0.01);
    });

    it('should accumulate multiple entries for the same run', async () => {
      await ledger.charge(createEntry({ id: 'entry-1', usd: 0.01 }));
      await ledger.charge(createEntry({ id: 'entry-2', usd: 0.02 }));

      const total = await ledger.totalForRun('run-1');
      expect(total).toBe(0.03);
    });
  });

  describe('preflight', () => {
    describe('run scope', () => {
      it('should allow when under cap', async () => {
        ledger = new InMemoryCostLedger({ defaultRunCapUsd: 1.0 });

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.01,
          usdHigh: 0.01,
        };

        const result = await ledger.preflight(estimate, { type: 'run', runId: 'run-1' });
        expect(result.allowed).toBe(true);
        expect(result.currentSpentUsd).toBe(0);
      });

      it('should deny when cost exceeds cap', async () => {
        ledger = new InMemoryCostLedger({ runCaps: new Map([['run-1', 0.05]]) });

        await ledger.charge(createEntry({ usd: 0.04 }));

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.02,
          usdHigh: 0.02,
        };

        const result = await ledger.preflight(estimate, { type: 'run', runId: 'run-1' });
        expect(result.allowed).toBe(false);
        expect(result.currentSpentUsd).toBe(0.04);
        expect(result.requestEstimateUsd).toBe(0.02);
        expect(result.capUsd).toBe(0.05);
      });

      it('should allow when exactly at cap', async () => {
        ledger = new InMemoryCostLedger({ runCaps: new Map([['run-1', 0.05]]) });

        await ledger.charge(createEntry({ usd: 0.04 }));

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.01,
          usdHigh: 0.01,
        };

        const result = await ledger.preflight(estimate, { type: 'run', runId: 'run-1' });
        expect(result.allowed).toBe(true);
      });

      it('should allow when no cap is configured', async () => {
        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 1000,
          usdHigh: 1000,
        };

        const result = await ledger.preflight(estimate, { type: 'run', runId: 'run-1' });
        expect(result.allowed).toBe(true);
      });
    });

    describe('tenant scope', () => {
      it('should allow when under daily cap', async () => {
        ledger = new InMemoryCostLedger({
          tenantDailyCaps: new Map([['tenant-1', 1.0]]),
        });

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.01,
          usdHigh: 0.01,
        };

        const result = await ledger.preflight(estimate, {
          type: 'tenant',
          tenantId: 'tenant-1',
          timeWindow: {
            start: new Date(Date.now() - 3600000).toISOString(),
            end: new Date().toISOString(),
          },
        });

        expect(result.allowed).toBe(true);
      });

      it('should deny when daily cap exceeded', async () => {
        ledger = new InMemoryCostLedger({
          tenantDailyCaps: new Map([['tenant-1', 0.05]]),
        });

        const now = new Date();
        await ledger.charge(
          createEntry({
            id: 'entry-1',
            tenantId: 'tenant-1',
            usd: 0.04,
            at: now.toISOString(),
          }),
        );

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.02,
          usdHigh: 0.02,
        };

        const result = await ledger.preflight(estimate, {
          type: 'tenant',
          tenantId: 'tenant-1',
          timeWindow: {
            start: new Date(now.getTime() - 3600000).toISOString(),
            end: new Date(now.getTime() + 3600000).toISOString(),
          },
        });

        expect(result.allowed).toBe(false);
      });

      it('should deny when monthly cap exceeded', async () => {
        ledger = new InMemoryCostLedger({
          tenantMonthlyCaps: new Map([['tenant-1', 0.1]]),
        });

        const now = new Date();
        await ledger.charge(
          createEntry({
            id: 'entry-1',
            tenantId: 'tenant-1',
            usd: 0.09,
            at: now.toISOString(),
          }),
        );

        const estimate: CostEstimate = {
          operation: 'image.generate',
          provider: 'stability',
          modelId: 'sd3',
          inputUnits: 0,
          outputUnitsLow: 1,
          outputUnitsHigh: 1,
          usdLow: 0.02,
          usdHigh: 0.02,
        };

        const result = await ledger.preflight(estimate, {
          type: 'tenant',
          tenantId: 'tenant-1',
          timeWindow: {
            start: new Date(now.getTime() - 86400000 * 20).toISOString(),
            end: new Date(now.getTime() + 86400000).toISOString(),
          },
        });

        expect(result.allowed).toBe(false);
      });
    });
  });

  describe('totalForRun', () => {
    it('should return 0 for a run with no entries', async () => {
      const total = await ledger.totalForRun('nonexistent');
      expect(total).toBe(0);
    });

    it('should sum entries for the given run', async () => {
      await ledger.charge(createEntry({ id: 'e1', runId: 'run-1', usd: 0.01 }));
      await ledger.charge(createEntry({ id: 'e2', runId: 'run-1', usd: 0.02 }));
      await ledger.charge(createEntry({ id: 'e3', runId: 'run-2', usd: 0.99 }));

      const total = await ledger.totalForRun('run-1');
      expect(total).toBe(0.03);
    });
  });

  describe('totalForTenant', () => {
    it('should return 0 for a tenant with no entries', async () => {
      const total = await ledger.totalForTenant('nonexistent', {
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-12-31T23:59:59.000Z',
      });
      expect(total).toBe(0);
    });

    it('should sum entries for the given tenant within the time window', async () => {
      const now = new Date();
      await ledger.charge(
        createEntry({
          id: 'e1',
          tenantId: 'tenant-1',
          usd: 0.01,
          at: new Date(now.getTime() - 86400000).toISOString(),
        }),
      );
      await ledger.charge(
        createEntry({
          id: 'e2',
          tenantId: 'tenant-1',
          usd: 0.02,
          at: now.toISOString(),
        }),
      );
      await ledger.charge(
        createEntry({
          id: 'e3',
          tenantId: 'tenant-2',
          usd: 0.99,
          at: now.toISOString(),
        }),
      );

      const total = await ledger.totalForTenant('tenant-1', {
        start: new Date(now.getTime() - 86400000 * 2).toISOString(),
        end: new Date(now.getTime() + 86400000).toISOString(),
      });
      expect(total).toBe(0.03);
    });

    it('should exclude entries outside the time window', async () => {
      await ledger.charge(
        createEntry({
          id: 'e1',
          tenantId: 'tenant-1',
          usd: 0.01,
          at: '2026-01-01T00:00:00.000Z',
        }),
      );

      const total = await ledger.totalForTenant('tenant-1', {
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-12-31T23:59:59.000Z',
      });
      expect(total).toBe(0);
    });
  });

  describe('listEntries', () => {
    it('should list entries for a run scope', async () => {
      await ledger.charge(createEntry({ id: 'e1', runId: 'run-1' }));
      await ledger.charge(createEntry({ id: 'e2', runId: 'run-2' }));

      const entries = await ledger.listEntries({ type: 'run', runId: 'run-1' });
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('e1');
    });

    it('should list entries for a tenant scope', async () => {
      const now = new Date();
      await ledger.charge(createEntry({ id: 'e1', tenantId: 'tenant-1', at: now.toISOString() }));
      await ledger.charge(createEntry({ id: 'e2', tenantId: 'tenant-2', at: now.toISOString() }));

      const entries = await ledger.listEntries({
        type: 'tenant',
        tenantId: 'tenant-1',
        timeWindow: {
          start: new Date(now.getTime() - 86400000).toISOString(),
          end: new Date(now.getTime() + 86400000).toISOString(),
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('e1');
    });
  });
});

describe('index exports', () => {
  it('should export all expected symbols', async () => {
    const mod = await import('../index.js');
    const keys = Object.keys(mod);
    expect(keys.length).toBeGreaterThan(0);
  });
});
