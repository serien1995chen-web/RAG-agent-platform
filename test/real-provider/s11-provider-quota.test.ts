import { describe, expect, it, vi } from 'vitest';
import { KnowledgeQuotaGate } from '../../packages/service/src/modules/knowledge/adapter/s10-quota.adapter';
import {
  FIXTURE_V1_PRICING,
  FREE_V1_QUOTA,
} from '../../packages/service/src/shared/config/s10-profiles';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s11_provider_quota',
  memberId: 'mem_s11_provider_quota',
  requestId: 'req_s11_provider_quota',
  traceId: 'trace_s11_provider_quota',
  scopes: ['knowledge:write'],
  isWorkspaceOwner: false,
};

class FakeRedis {
  values = new Map<string, number>();
  expires = new Map<string, number>();
  async incr(key: string) {
    const value = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }
  async decr(key: string) {
    const value = (this.values.get(key) ?? 0) - 1;
    this.values.set(key, value);
    return value;
  }
  async incrby(key: string, amount: number) {
    const value = (this.values.get(key) ?? 0) + amount;
    this.values.set(key, value);
    return value;
  }
  async decrby(key: string, amount: number) {
    const value = (this.values.get(key) ?? 0) - amount;
    this.values.set(key, value);
    return value;
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

function quotaGate(usageMicros = 0) {
  const redis = new FakeRedis();
  const quota = new KnowledgeQuotaGate({
    usage: {
      async summary() {
        return {
          period: { from: new Date().toISOString(), to: new Date().toISOString() },
          quota: {
            aiPointsLimit: FREE_V1_QUOTA.aiPointsLimit,
            aiPointsLimitMicros: FREE_V1_QUOTA.aiPointsLimit * 1_000_000,
            storageBytesLimit: FREE_V1_QUOTA.storageBytesLimit,
            maxSpaces: FREE_V1_QUOTA.maxSpaces,
            maxIndexes: FREE_V1_QUOTA.maxIndexes,
            requestsPerMinute: FREE_V1_QUOTA.requestsPerMinute,
            maxModelConcurrency: FREE_V1_QUOTA.maxModelConcurrency,
            profileVersion: FREE_V1_QUOTA.version,
          },
          usage: {
            aiPoints: usageMicros / 1_000_000,
            aiPointsMicros: usageMicros,
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
          profileVersion: FIXTURE_V1_PRICING.version,
        };
      },
    },
    redis: redis as never,
    quota: FREE_V1_QUOTA,
  });
  return { quota, redis };
}

describe('TEST-X-S11-PROVIDER-REAL quota and pricing inheritance', () => {
  it('keeps the approved non-zero fixture pricing and free quota defaults', () => {
    expect(FIXTURE_V1_PRICING).toMatchObject({
      name: 'fixture-v1',
      llmInputPer1kTokensMicros: 1_000_000,
      llmOutputPer1kTokensMicros: 2_000_000,
    });
    expect(FREE_V1_QUOTA).toMatchObject({
      name: 'free-v1',
      aiPointsLimit: 100,
      maxIndexes: 600,
      requestsPerMinute: 30,
      maxModelConcurrency: 10,
    });
  });

  it('rejects quota before RPM or provider work and releases failed reservations', async () => {
    const { quota, redis } = quotaGate(99_900_000);
    const providerWork = vi.fn();
    await expect(quota.withModelSlot(context, providerWork, 10_000_000)).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_QUOTA_EXCEEDED',
          details: { quota: 'ai_points', profileVersion: FREE_V1_QUOTA.version },
        },
      },
    });
    expect(providerWork).not.toHaveBeenCalled();
    expect(
      redis.values.get(`kb:quota:rpm:${context.workspaceId}:${Math.floor(Date.now() / 60_000)}`),
    ).toBeUndefined();

    const allowed = quotaGate();
    await expect(
      allowed.quota.withModelSlot(
        context,
        async () => {
          throw new Error('provider 429');
        },
        10_000_000,
      ),
    ).rejects.toThrow('provider 429');
    expect(
      allowed.redis.values.get(`kb:quota:points-reserved:${context.workspaceId}`),
    ).toBeUndefined();
  });
});
