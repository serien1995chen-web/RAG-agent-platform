import { describe, expect, it, vi } from 'vitest';
import {
  KnowledgeQuotaGate,
  S10_MODEL_LEASE_TTL_SECONDS,
} from '../../packages/service/src/modules/knowledge/adapter/s10-quota.adapter';
import { FREE_V1_QUOTA } from '../../packages/service/src/shared/config/s10-profiles';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_quota',
  memberId: 'member_quota',
  requestId: 'request_quota',
  traceId: 'trace_quota',
  scopes: ['knowledge:write'],
  isWorkspaceOwner: false,
};

class FakeRedis {
  values = new Map<string, number>();
  expires = new Map<string, number>();
  async incr(key: string) {
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }
  async decr(key: string) {
    const next = (this.values.get(key) ?? 0) - 1;
    this.values.set(key, next);
    return next;
  }
  async incrby(key: string, value: number) {
    const next = (this.values.get(key) ?? 0) + value;
    this.values.set(key, next);
    return next;
  }
  async decrby(key: string, value: number) {
    const next = (this.values.get(key) ?? 0) - value;
    this.values.set(key, next);
    return next;
  }
  async del(key: string) {
    this.values.delete(key);
    return 1;
  }
  async expire(key: string, seconds: number) {
    this.expires.set(key, seconds);
    return 1;
  }
}

function gate(aiPointsMicros = 0) {
  const redis = new FakeRedis();
  return {
    redis,
    quota: new KnowledgeQuotaGate({
      usage: {
        summary: async () => ({
          period: { from: new Date().toISOString(), to: new Date().toISOString() },
          quota: {
            aiPointsLimit: 100,
            aiPointsLimitMicros: 100_000_000,
            storageBytesLimit: 10 * 1024 * 1024 * 1024,
            maxSpaces: 3,
            maxIndexes: 600,
            requestsPerMinute: 30,
            maxModelConcurrency: 10,
            profileVersion: FREE_V1_QUOTA.version,
          },
          usage: {
            aiPoints: aiPointsMicros / 1_000_000,
            aiPointsMicros,
            storageBytes: 0,
            indexCount: 0,
            spaceCount: 1,
            parsePages: 0,
            inputTokens: 0,
            outputTokens: 0,
            embeddingTokens: 0,
            rerankTokens: 0,
            modelCalls: 0,
          },
          delivery: { pending: 0, delivered: 0, failed: 0 },
          series: [],
          profileVersion: 'fixture-v1',
        }),
      },
      redis: redis as never,
      quota: FREE_V1_QUOTA,
      now: () => new Date('2026-10-29T00:00:00.000Z'),
    }),
  };
}

describe('TEST-S10-QUOTA-ZERO-SIDE-EFFECT model concurrency', () => {
  it('allows ten active slots and rejects the eleventh before external work', async () => {
    const { quota } = gate();
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'ok';
    });
    const attempts = Array.from({ length: 11 }, () =>
      quota.withModelSlot(context, work).then(
        () => 'pass' as const,
        (error: unknown) => {
          expect(error).toMatchObject({
            problem: { error: { code: 'KNOWLEDGE_QUOTA_EXCEEDED' } },
          });
          return 'quota' as const;
        },
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((value) => value === 'pass')).toHaveLength(10);
    expect(results.filter((value) => value === 'quota')).toHaveLength(1);
    expect(work).toHaveBeenCalledTimes(10);
  });

  it('rejects over-quota model calls before RPM consumption', async () => {
    const { quota, redis } = gate(99_900_000);
    await expect(
      quota.check(
        {
          operation: 'model',
          workspaceId: context.workspaceId,
          estimatedPointsMicros: 10_000_000,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_QUOTA_EXCEEDED',
          details: { quota: 'ai_points' },
        },
      },
    });
    expect([...redis.values.entries()]).toEqual([]);
  });

  it('releases the points reservation when provider work fails', async () => {
    const { quota, redis } = gate();
    await expect(
      quota.withModelSlot(
        context,
        async () => {
          expect(redis.values.get(`kb:quota:points-reserved:${context.workspaceId}`)).toBe(
            10_000_000,
          );
          throw new Error('provider failed');
        },
        10_000_000,
      ),
    ).rejects.toThrow('provider failed');
    expect(redis.values.get(`kb:quota:points-reserved:${context.workspaceId}`)).toBeUndefined();
  });

  it('keeps concurrency and points leases beyond the Provider retry window', async () => {
    const { quota, redis } = gate();
    await quota.withModelSlot(context, async () => 'ok', 10_000_000);
    expect(S10_MODEL_LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(600);
    expect(redis.expires.get(`kb:quota:model-concurrency:${context.workspaceId}`)).toBe(
      S10_MODEL_LEASE_TTL_SECONDS,
    );
    expect(redis.expires.get(`kb:quota:points-reserved:${context.workspaceId}`)).toBe(
      S10_MODEL_LEASE_TTL_SECONDS,
    );
  });
});
