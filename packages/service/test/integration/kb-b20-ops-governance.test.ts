import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeQuotaGate } from '../../src/modules/knowledge/adapter/s10-quota.adapter';
import { S5UsageRepository } from '../../src/modules/knowledge/repository/s5-usage.repository';
import { S10OperationsRepository } from '../../src/modules/knowledge/repository/s10-operations.repository';
import { FREE_V1_QUOTA, FIXTURE_V1_PRICING } from '../../src/shared/config/s10-profiles';
import { KnowledgeAuditRepository } from '../../src/shared/persistence/knowledge/audit';
import { KnowledgeOutboxDispatcher } from '../../src/shared/persistence/knowledge/outbox';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_b20_ops_a_${suffix}`;
const workspaceB = `ws_b20_ops_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `mem_b20_ops_a_${suffix}`,
  requestId: `req_b20_ops_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `mem_b20_ops_b_${suffix}`,
  requestId: `req_b20_ops_b_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
};
const objectId = () => new mongoose.Types.ObjectId().toString();

let connection: mongoose.Connection;
let usage: S5UsageRepository;
let operations: S10OperationsRepository;
let audits: KnowledgeAuditRepository;
const enqueue = vi.fn(async () => ({ jobId: 'b20-outbox', enqueued: true }));

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  const uri = new URL(value);
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  usage = new S5UsageRepository(connection, FIXTURE_V1_PRICING, FREE_V1_QUOTA);
  operations = new S10OperationsRepository(connection, { enqueue } as never);
  audits = new KnowledgeAuditRepository(connection);
}, 60_000);

beforeEach(async () => {
  enqueue.mockClear();
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await connection.close();
});

function invocationFact(input: {
  kind: 'llm' | 'vlm' | 'embedding' | 'rerank' | 'image';
  unit: 'token' | 'vector' | 'image';
  quantity: number;
  sequence: number;
  inputTokens?: number;
  outputTokens?: number;
  modelId?: string;
  fallbackUsed?: boolean;
  status?: number;
}) {
  return {
    workspaceId: workspaceA,
    knowledgeSpaceId: objectId(),
    operation: `b20.${input.kind}`,
    requestId: `${contextA.requestId}-${input.sequence}`,
    traceId: contextA.traceId,
    modelId: input.modelId ?? `b20-${input.kind}-model`,
    kind: input.kind,
    attempt: 1,
    eventSequence: input.sequence,
    quantity: input.quantity,
    unit: input.unit,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    status: input.status ?? 200,
    fallbackUsed: input.fallbackUsed ?? false,
    provider: 'aiproxy',
    resourceType: 'space' as const,
    resourceId: objectId(),
  };
}

describe('L1-B20-OPS-002 operations governance', () => {
  it('L1-B20-OPS-002-P01 persists provider/model usage, units, pricing and outbox facts', async () => {
    const spaceId = objectId();
    const sourceId = objectId();
    expect(
      await usage.recordProviderUsage(
        {
          workspaceId: workspaceA,
          knowledgeSpaceId: spaceId,
          sourceId,
          sourceVersion: 1,
          provider: 'textin',
          unit: 'page',
          quantity: 2,
          status: 200,
          attempt: 1,
          eventSequence: 1,
          requestId: `${contextA.requestId}-ocr`,
          traceId: contextA.traceId,
          fallbackUsed: false,
        },
        contextA,
      ),
    ).toBe(true);

    const facts = [
      invocationFact({
        kind: 'embedding',
        unit: 'token',
        quantity: 12,
        sequence: 2,
        inputTokens: 12,
      }),
      invocationFact({
        kind: 'rerank',
        unit: 'token',
        quantity: 8,
        sequence: 3,
        inputTokens: 8,
      }),
      invocationFact({
        kind: 'llm',
        unit: 'token',
        quantity: 120,
        sequence: 4,
        inputTokens: 100,
        outputTokens: 20,
      }),
      invocationFact({
        kind: 'image',
        unit: 'image',
        quantity: 2,
        sequence: 5,
      }),
      invocationFact({
        kind: 'vlm',
        unit: 'token',
        quantity: 60,
        sequence: 6,
        inputTokens: 50,
        outputTokens: 10,
      }),
    ];
    for (const fact of facts) {
      expect(await usage.recordInvocationUsage(fact, contextA)).toBe(true);
    }

    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeUsageEvent.countDocuments({
        workspaceId: workspaceA,
      }),
    ).toBe(6);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId: workspaceA,
      }),
    ).toBe(6);
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId: workspaceA,
      }),
    ).toBe(6);

    const summary = await usage.summary(
      {
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
      },
      contextA,
    );
    expect(summary.usage).toMatchObject({
      parsePages: 2,
      embeddingTokens: 12,
      rerankTokens: 8,
      inputTokens: 170,
      outputTokens: 30,
    });
    expect(summary.delivery).toEqual({ pending: 6, delivered: 0, failed: 0 });

    const outbox = await models.KnowledgeOutboxEvent.find({ workspaceId: workspaceA }).lean();
    expect(new Set(outbox.map((event) => event.payload.unit))).toEqual(
      new Set(['page', 'token', 'image']),
    );
    expect(
      outbox.every(
        (event) =>
          event.status === 'pending' &&
          typeof event.payload.usageEventId === 'string' &&
          event.payload.pricingVersion === FIXTURE_V1_PRICING.version,
      ),
    ).toBe(true);
  });

  it('L1-B20-OPS-002-N01 rejects invalid usage contracts and preserves failed-call evidence', async () => {
    await expect(
      usage.recordInvocationUsage(
        {
          ...invocationFact({
            kind: 'llm',
            unit: 'token',
            quantity: 1,
            sequence: 10,
          }),
          unit: 'page',
        } as never,
        contextA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      usage.recordInvocationUsage(
        {
          ...invocationFact({
            kind: 'llm',
            unit: 'token',
            quantity: 1,
            sequence: 11,
          }),
          inputTokens: -1,
        },
        contextA,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const failed = {
      workspaceId: workspaceA,
      knowledgeSpaceId: objectId(),
      sourceId: objectId(),
      sourceVersion: 1,
      provider: 'somark',
      unit: 'request' as const,
      quantity: 1,
      status: 401,
      attempt: 1,
      eventSequence: 12,
      requestId: `${contextA.requestId}-failed-ocr`,
      traceId: contextA.traceId,
      fallbackUsed: false,
    };
    expect(await usage.recordProviderUsage(failed, contextA)).toBe(true);
    expect(await usage.recordProviderUsage(failed, contextA)).toBe(false);
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeUsageEvent.findOne({
      workspaceId: workspaceA,
      eventType: 'ocr',
    }).lean();
    expect(event).toMatchObject({
      quantity: 1,
      unit: 'request',
      pointsMicros: 0,
    });
    const outbox = await models.KnowledgeOutboxEvent.findOne({ workspaceId: workspaceA }).lean();
    expect(outbox?.payload).toMatchObject({
      provider: 'somark',
      status: 401,
      unit: 'request',
      pointsMicros: 0,
    });
  });

  it('L1-B20-OPS-002-A01 isolates usage, audit, jobs and outbox across workspaces', async () => {
    await usage.recordInvocationUsage(
      invocationFact({
        kind: 'llm',
        unit: 'token',
        quantity: 10,
        sequence: 20,
        inputTokens: 10,
      }),
      contextA,
    );
    await audits.appendStandalone(
      {
        knowledgeSpaceId: null,
        action: 'model.invoke',
        resourceType: 'space',
        resourceId: objectId(),
        outcome: 'succeeded',
        safeDiff: { provider: 'aiproxy' },
      },
      contextA,
    );
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.create({
      workspaceId: workspaceA,
      knowledgeSpaceId: null,
      version: 1,
      deletedAt: null,
      createdByMemberId: contextA.memberId,
      updatedByMemberId: contextA.memberId,
      idempotencyKey: `b20-job-${suffix}`.padEnd(16, '0'),
      kind: 'cleanup',
      status: 'queued',
      operationId: 'API-OPS-CLEANUP',
      priority: 5,
      attempts: 0,
      maxAttempts: 5,
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      resourceType: 'workspace',
      resourceId: '000000000000000000000000',
      inputSnapshot: { scope: 'all' },
      result: null,
      error: null,
      lease: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(
      await usage.summary(
        {
          from: new Date(Date.now() - 60_000),
          to: new Date(Date.now() + 60_000),
        },
        contextB,
      ),
    ).toMatchObject({
      usage: { aiPointsMicros: 0, modelCalls: 0 },
      delivery: { pending: 0, delivered: 0, failed: 0 },
    });
    expect(await operations.list({ limit: 10 }, contextB)).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    expect(await models.KnowledgeJob.countDocuments({ workspaceId: workspaceB })).toBe(0);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId: workspaceB })).toBe(0);
    await expect(
      usage.summary(
        {
          from: new Date(Date.now() - 60_000),
          to: new Date(Date.now() + 60_000),
        },
        {} as TenantContext,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B20-OPS-002-S01 rolls back success facts, audit and outbox together', async () => {
    const models = registerKnowledgeModels(connection);
    const create = vi
      .spyOn(models.KnowledgeAuditEvent, 'create')
      .mockRejectedValueOnce(new Error('audit unavailable') as never);
    try {
      await expect(
        usage.recordInvocationUsage(
          invocationFact({
            kind: 'llm',
            unit: 'token',
            quantity: 100,
            sequence: 30,
            inputTokens: 90,
            outputTokens: 10,
          }),
          contextA,
        ),
      ).rejects.toThrow('audit unavailable');
    } finally {
      create.mockRestore();
    }
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId: workspaceA })).toBe(0);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId: workspaceA })).toBe(0);
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId: workspaceA })).toBe(0);
  });

  it('L1-B20-OPS-002-C01 deduplicates concurrent usage and enforces ten model slots', async () => {
    const fact = invocationFact({
      kind: 'embedding',
      unit: 'token',
      quantity: 32,
      sequence: 40,
      inputTokens: 32,
    });
    const writes = await Promise.all(
      Array.from({ length: 10 }, () => usage.recordInvocationUsage(fact, contextA)),
    );
    expect(writes.filter(Boolean)).toHaveLength(1);
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId: workspaceA })).toBe(1);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId: workspaceA })).toBe(1);

    const redisUrl = process.env.KB_TEST_REDIS_URL?.trim();
    if (!redisUrl) throw new Error('missing required test environment: KB_TEST_REDIS_URL');
    const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    try {
      const quota = new KnowledgeQuotaGate({
        usage,
        redis,
        quota: FREE_V1_QUOTA,
      });
      const work = vi.fn(async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      });
      const attempts = await Promise.all(
        Array.from({ length: 11 }, () =>
          quota.withModelSlot(contextA, work).then(
            () => 'pass' as const,
            (error: unknown) => {
              expect(error).toMatchObject({
                problem: { error: { code: 'KNOWLEDGE_QUOTA_EXCEEDED' } },
              });
              return 'quota' as const;
            },
          ),
        ),
      );
      expect(attempts.filter((result) => result === 'pass')).toHaveLength(10);
      expect(attempts.filter((result) => result === 'quota')).toHaveLength(1);
      expect(work).toHaveBeenCalledTimes(10);
    } finally {
      await redis.quit();
    }
  });

  it('L1-B20-OPS-002-F01 recovers stale delivery and permits one replay winner', async () => {
    const models = registerKnowledgeModels(connection);
    const [stale] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId: workspaceA,
        knowledgeSpaceId: null,
        version: 2,
        deletedAt: null,
        createdByMemberId: contextA.memberId,
        updatedByMemberId: contextA.memberId,
        eventKey: `b20-stale-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `b20-stale-usage-${suffix}`,
        payload: {
          queue: 'knowledge-outbox',
          usageEventId: `b20-stale-usage-${suffix}`,
          unit: 'page',
          quantity: 2,
        },
        status: 'publishing',
        attempts: 1,
        availableAt: new Date(Date.now() - 60_000),
        publishedAt: null,
        error: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    await models.KnowledgeOutboxEvent.collection.updateOne(
      { _id: stale!._id },
      { $set: { updatedAt: new Date(Date.now() - 60_000) } },
    );
    const dispatcher = new KnowledgeOutboxDispatcher(connection, { enqueue } as never);
    await expect(dispatcher.dispatchOnce(contextA)).resolves.toMatchObject({ dispatched: true });
    await expect(dispatcher.dispatchOnce(contextA)).resolves.toEqual({ dispatched: false });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(await models.KnowledgeOutboxEvent.findById(stale!._id).lean()).toMatchObject({
      status: 'published',
    });

    await models.KnowledgeOutboxEvent.deleteMany({ workspaceId: workspaceA });
    const [dead] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId: workspaceA,
        knowledgeSpaceId: null,
        version: 7,
        deletedAt: null,
        createdByMemberId: contextA.memberId,
        updatedByMemberId: contextA.memberId,
        eventKey: `b20-dead-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `b20-dead-usage-${suffix}`,
        payload: { queue: 'knowledge-outbox', usageEventId: `b20-dead-usage-${suffix}` },
        status: 'dead_letter',
        attempts: 10,
        availableAt: new Date(),
        publishedAt: null,
        error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const replayResults = await Promise.all(
      [1, 2].map((index) =>
        operations
          .replayOutbox(
            {
              eventId: String(dead!._id),
              version: 7,
              idempotencyKey: `b20-replay-${suffix}-${index}`.padEnd(16, '0'),
            },
            contextA,
          )
          .then(() => 'pass' as const)
          .catch(() => 'conflict' as const),
      ),
    );
    expect(replayResults.sort()).toEqual(['conflict', 'pass']);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId: workspaceA,
        kind: 'outbox',
        resourceId: String(dead!._id),
      }),
    ).toBe(1);
    expect(await models.KnowledgeOutboxEvent.findById(dead!._id).lean()).toMatchObject({
      status: 'pending',
      version: 8,
    });
  });

  it('L1-B20-OPS-002-Q01 snapshots pricing, preserves token split and redacts storage fields', async () => {
    await usage.recordInvocationUsage(
      invocationFact({
        kind: 'llm',
        unit: 'token',
        quantity: 1100,
        sequence: 50,
        inputTokens: 1000,
        outputTokens: 100,
        fallbackUsed: true,
        status: 200,
      }),
      contextA,
    );
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeUsageEvent.findOne({ workspaceId: workspaceA }).lean();
    expect(event).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      pointsMicros: 1_200_000,
      pricingVersion: FIXTURE_V1_PRICING.version,
      pricingSnapshot: expect.objectContaining({
        version: FIXTURE_V1_PRICING.version,
      }),
    });
    const audit = await models.KnowledgeAuditEvent.findOne({ workspaceId: workspaceA }).lean();
    const outbox = await models.KnowledgeOutboxEvent.findOne({ workspaceId: workspaceA }).lean();
    expect(audit?.safeDiff).toMatchObject({
      kind: 'llm',
      fallbackUsed: true,
    });
    expect(audit?.safeDiff).not.toHaveProperty('inputTokens');
    expect(JSON.stringify({ audit, outbox })).not.toMatch(
      /"(authorization|cookie|apiKey|api_key|secret|objectKey|object_key|connectionString)":/i,
    );
  });
});
