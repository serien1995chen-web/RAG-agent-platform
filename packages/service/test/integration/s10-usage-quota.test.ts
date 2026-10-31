import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeQuotaGate } from '../../src/modules/knowledge/adapter/s10-quota.adapter';
import { S5UsageRepository } from '../../src/modules/knowledge/repository/s5-usage.repository';
import { FIXTURE_V1_PRICING, FREE_V1_QUOTA } from '../../src/shared/config/s10-profiles';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_usage_${suffix}`;
const knowledgeSpaceId = `65f1e5b2a1c9d4b7e8f0${suffix.slice(0, 4)}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s10_usage_${suffix}`,
  requestId: `req_s10_usage_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

class FakeRedis {
  values = new Map<string, number>();
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
  async expire() {
    return 1;
  }
}

let connection: mongoose.Connection;
let usage: S5UsageRepository;

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  const uri = new URL(value);
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  usage = new S5UsageRepository(connection, FIXTURE_V1_PRICING, FREE_V1_QUOTA);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-OPS-001-BLOCK / TEST-OPS-002-BLOCK usage and quota', () => {
  it('records token points, pricing snapshots and a single deduplicated outbox fact', async () => {
    const fact = {
      workspaceId,
      knowledgeSpaceId,
      operation: 'llm',
      requestId: context.requestId,
      traceId: context.traceId,
      modelId: 'llm-fixture',
      kind: 'llm' as const,
      attempt: 1,
      eventSequence: 2,
      quantity: 1100,
      unit: 'token' as const,
      inputTokens: 1000,
      outputTokens: 100,
      status: 200,
      fallbackUsed: false,
      provider: 'aiproxy',
      resourceType: 'space' as const,
      resourceId: knowledgeSpaceId,
    };
    expect(await usage.recordInvocationUsage(fact, context)).toBe(true);
    expect(await usage.recordInvocationUsage(fact, context)).toBe(false);
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeUsageEvent.findOne({ workspaceId }).lean();
    expect(event).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      pointsMicros: 1_200_000,
      pricingVersion: FIXTURE_V1_PRICING.version,
      pricingSnapshot: expect.objectContaining({
        name: 'fixture-v1',
        version: FIXTURE_V1_PRICING.version,
      }),
    });
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
    const summary = await usage.summary(
      {
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 1_000),
      },
      context,
    );
    expect(summary.usage).toMatchObject({
      aiPointsMicros: 1_200_000,
      inputTokens: 1000,
      outputTokens: 100,
      modelCalls: 1,
    });
    expect(summary.quota.profileVersion).toBe(FREE_V1_QUOTA.version);
  });

  it('transitions a persisted usage fact through delivery states idempotently', async () => {
    const fact = {
      workspaceId,
      knowledgeSpaceId,
      operation: 'llm-delivery',
      requestId: context.requestId,
      traceId: context.traceId,
      modelId: 'llm-fixture',
      kind: 'llm' as const,
      attempt: 1,
      eventSequence: 3,
      quantity: 100,
      unit: 'token' as const,
      inputTokens: 100,
      outputTokens: 0,
      status: 200,
      fallbackUsed: false,
      provider: 'aiproxy',
      resourceType: 'space' as const,
      resourceId: knowledgeSpaceId,
    };
    expect(await usage.recordInvocationUsage(fact, context)).toBe(true);
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeUsageEvent.findOne({ workspaceId }).lean();
    expect(event?.deliveryStatus).toBe('pending');
    await usage.deliverUsage();
    await usage.markDelivery(event!.eventId, 'delivered', context);
    await usage.markDelivery(event!.eventId, 'delivered', context);
    const delivered = await models.KnowledgeUsageEvent.findOne({ workspaceId }).lean();
    expect(delivered).toMatchObject({ deliveryStatus: 'delivered' });
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    await usage.markDelivery(event!.eventId, 'failed', context);
    expect(await models.KnowledgeUsageEvent.findOne({ workspaceId }).lean()).toMatchObject({
      deliveryStatus: 'failed',
      deliveredAt: null,
    });
    const summary = await usage.summary(
      {
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 1_000),
      },
      context,
    );
    expect(summary.delivery).toEqual({ pending: 0, delivered: 0, failed: 1 });
  });

  it('TEST-S10-AUDIT-ROLLBACK rolls back usage and outbox when audit append fails', async () => {
    const models = registerKnowledgeModels(connection);
    const create = vi
      .spyOn(models.KnowledgeAuditEvent, 'create')
      .mockRejectedValueOnce(new Error('audit dependency unavailable') as never);
    try {
      await expect(
        usage.recordInvocationUsage(
          {
            workspaceId,
            knowledgeSpaceId,
            operation: 'audit-rollback',
            requestId: `${context.requestId}-rollback`,
            traceId: context.traceId,
            modelId: 'llm-fixture',
            kind: 'llm',
            attempt: 1,
            eventSequence: 90,
            quantity: 100,
            unit: 'token',
            inputTokens: 100,
            outputTokens: 0,
            status: 200,
            fallbackUsed: false,
            provider: 'aiproxy',
            resourceType: 'space',
            resourceId: knowledgeSpaceId,
          },
          context,
        ),
      ).rejects.toThrow('audit dependency unavailable');
    } finally {
      create.mockRestore();
    }
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId })).toBe(0);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('rejects over-quota model calls before any external or database side effect', async () => {
    const redis = new FakeRedis();
    const quota = new KnowledgeQuotaGate({
      usage,
      redis: redis as never,
      quota: FREE_V1_QUOTA,
    });
    const models = registerKnowledgeModels(connection);
    const before = {
      jobs: await models.KnowledgeJob.countDocuments({ workspaceId }),
      outbox: await models.KnowledgeOutboxEvent.countDocuments({ workspaceId }),
      sources: await models.KnowledgeSource.countDocuments({ workspaceId }),
    };
    await expect(
      quota.check(
        {
          operation: 'model',
          workspaceId,
          knowledgeSpaceId,
          estimatedPointsMicros: FREE_V1_QUOTA.aiPointsLimit * 1_000_000 + 1,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_QUOTA_EXCEEDED',
          details: expect.objectContaining({
            quota: 'ai_points',
            profileVersion: FREE_V1_QUOTA.version,
          }),
        },
      },
    });
    expect({
      jobs: await models.KnowledgeJob.countDocuments({ workspaceId }),
      outbox: await models.KnowledgeOutboxEvent.countDocuments({ workspaceId }),
      sources: await models.KnowledgeSource.countDocuments({ workspaceId }),
    }).toEqual(before);
    expect(redis.values.size).toBe(0);
  });
});
