import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_V1_PRICING } from '../../src/shared/config/s10-profiles';
import { S8DeepCostAdapter } from '../../src/modules/knowledge/adapter/s8-deep-cost.adapter';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b17_cost',
  memberId: 'mem_b17_cost',
  requestId: 'req_b17_cost',
  traceId: 'b17-cost-trace-0000000000000',
  scopes: ['knowledge:search'],
};

describe('L1-B17-SEARCH-008 cost pricing', () => {
  it('derives safe AI Points from the approved pricing profile and quota availability', async () => {
    const available = vi.fn(async () => 75_000_000);
    const adapter = new S8DeepCostAdapter({
      pricing: FIXTURE_V1_PRICING,
      quota: {
        async check() {},
        async withModelSlot(_context, work) {
          return work();
        },
        availableAiPointsMicros: available,
      },
    });

    expect(adapter.pricingVersion).toBe(FIXTURE_V1_PRICING.version);
    expect(adapter.llmPointsMicros(1_000, 1_000)).toBe(3_000_000);
    expect(adapter.embeddingPointsMicros(1_000)).toBe(1_000_000);
    expect(adapter.rerankPointsMicros(1_000)).toBe(1_000_000);
    await expect(adapter.availablePointsMicros(context)).resolves.toBe(75_000_000);
    expect(available).toHaveBeenCalledWith(context);
  });

  it('rejects invalid token usage instead of producing unsafe integer points', () => {
    const adapter = new S8DeepCostAdapter({
      pricing: FIXTURE_V1_PRICING,
      quota: {
        async check() {},
        async withModelSlot(_context, work) {
          return work();
        },
      },
    });
    expect(() => adapter.llmPointsMicros(-1, 0)).toThrow(RangeError);
    expect(() => adapter.embeddingPointsMicros(Number.NaN)).toThrow(RangeError);
    expect(() => adapter.rerankPointsMicros(1.5)).toThrow(RangeError);
  });
});
