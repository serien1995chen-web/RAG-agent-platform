import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  S5UsageRepository,
  usageEventIdOf,
} from '../../src/modules/knowledge/repository/s5-usage.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { KnowledgeOutboxDispatcher } from '../../src/shared/persistence/knowledge/outbox';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s5_usage_${suffix}`;
const knowledgeSpaceId = `65f1e5b2a1c9d4b7e8f0${suffix.slice(0, 4)}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s5_usage_${suffix}`,
  requestId: `req_s5_usage_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};

let connection: mongoose.Connection;
let repository: S5UsageRepository;

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s5_usage');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  repository = new S5UsageRepository(connection);
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

describe('TEST-MODEL-003-BLOCK usage event and outbox transaction', () => {
  it('writes one fact and one pending outbox for an actual attempt', async () => {
    const fact = {
      workspaceId,
      knowledgeSpaceId,
      operation: 'llm',
      requestId: context.requestId,
      traceId: context.traceId,
      modelId: 'llm-primary',
      kind: 'llm' as const,
      attempt: 1,
      eventSequence: 1,
      quantity: 42,
      unit: 'token' as const,
      status: 200,
      fallbackUsed: false,
      provider: 'aiproxy',
      resourceType: 'space' as const,
      resourceId: knowledgeSpaceId,
    };
    expect(await repository.recordInvocationUsage(fact, context)).toBe(true);
    expect(await repository.recordInvocationUsage(fact, context)).toBe(false);
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId })).toBe(1);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
    expect(await models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(1);
    const event = await models.KnowledgeUsageEvent.findOne({ workspaceId }).lean();
    expect(event?.eventId).toBe(
      usageEventIdOf({
        workspaceId,
        operation: 'llm',
        requestId: context.requestId,
        modelId: 'llm-primary',
        kind: 'llm',
        attempt: 1,
        eventSequence: 1,
      }),
    );
    expect(event?.quantity).toBe(42);
    expect(event?.deliveryStatus).toBe('pending');
    const outbox = await models.KnowledgeOutboxEvent.findOne({ workspaceId }).lean();
    expect(outbox?.status).toBe('pending');
    expect(outbox?.payload.queue).toBe('knowledge-outbox');
    const audit = await models.KnowledgeAuditEvent.findOne({ workspaceId }).lean();
    expect(audit).toMatchObject({
      action: 'model.invoke',
      outcome: 'succeeded',
      resourceType: 'space',
    });
    expect(JSON.stringify(audit)).not.toMatch(
      /"(authorization|credential|prompt|objectKey|password|secret|token)":/i,
    );
  });

  it('records failed attempts with zero quantity and a safe status', async () => {
    await repository.recordInvocationUsage(
      {
        workspaceId,
        knowledgeSpaceId,
        operation: 'rerank',
        requestId: context.requestId,
        traceId: context.traceId,
        modelId: 'rerank-primary',
        kind: 'rerank',
        attempt: 2,
        eventSequence: 2,
        quantity: 0,
        unit: 'token',
        status: 503,
        fallbackUsed: true,
        provider: 'aiproxy',
        resourceType: 'space',
        resourceId: knowledgeSpaceId,
      },
      context,
    );
    const event = await registerKnowledgeModels(connection)
      .KnowledgeUsageEvent.findOne({
        workspaceId,
      })
      .lean();
    expect(event?.quantity).toBe(0);
    expect(event?.modelId).toBe('rerank-primary');
  });

  it('records a deterministic zero-quantity intent before the actual usage event', async () => {
    const base = {
      workspaceId,
      knowledgeSpaceId,
      operation: 's8.caption:2',
      requestId: context.requestId,
      traceId: context.traceId,
      modelId: 'vlm-primary',
      kind: 'vlm' as const,
      attempt: 1,
      unit: 'token' as const,
      fallbackUsed: false,
      provider: 'aiproxy',
      resourceType: 'source' as const,
      resourceId: '65f1e5b2a1c9d4b7e8f05678',
      promptVersion: 's8.image-caption.v1',
      mediaItemCount: 1,
      totalBytes: 128,
      sourceVersion: 2,
    };
    const intent = { ...base, eventSequence: 1, quantity: 0, status: null, intent: true };
    expect(await repository.recordInvocationUsage(intent, context)).toBe(true);
    expect(await repository.recordInvocationUsage(intent, context)).toBe(false);
    await repository.recordInvocationUsage(
      { ...base, eventSequence: 2, quantity: 4, status: 200, intent: false },
      context,
    );
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId })).toBe(2);
    expect(
      await models.KnowledgeUsageEvent.aggregate([
        { $match: { workspaceId } },
        { $group: { _id: null, quantity: { $sum: '$quantity' } } },
      ]),
    ).toEqual([{ _id: null, quantity: 4 }]);
    const intentAudit = await models.KnowledgeAuditEvent.findOne({
      workspaceId,
      outcome: 'allowed',
    }).lean();
    expect(intentAudit?.safeDiff).toMatchObject({
      intent: true,
      promptVersion: 's8.image-caption.v1',
      mediaItemCount: 1,
      totalBytes: 128,
      sourceVersion: 2,
    });
    expect(JSON.stringify(intentAudit)).not.toMatch(/(objectKey|ticket=|caption":)/i);
  });

  it('records OCR provider facts with a source resource and pending outbox', async () => {
    const sourceId = `65f1e5b2a1c9d4b7e8f1${suffix.slice(0, 4)}`;
    expect(
      await repository.recordProviderUsage(
        {
          workspaceId,
          knowledgeSpaceId,
          sourceId,
          sourceVersion: 1,
          provider: 'sangfor',
          unit: 'page',
          quantity: 3,
          status: 200,
          attempt: 1,
          eventSequence: 1,
          requestId: context.requestId,
          traceId: context.traceId,
          fallbackUsed: false,
        },
        context,
      ),
    ).toBe(true);
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeUsageEvent.findOne({
      workspaceId,
      eventType: 'ocr',
    }).lean();
    expect(event).toMatchObject({
      quantity: 3,
      unit: 'page',
      modelId: null,
      resourceType: 'source',
    });
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        action: 'ocr.invoke',
        resourceType: 'source',
      }),
    ).toBe(1);
  });

  it('TEST-X-OUTBOX-CRASH recovers stale publishing and publishes one final fact', async () => {
    const models = registerKnowledgeModels(connection);
    const [event] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId,
        knowledgeSpaceId: null,
        version: 2,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: `crash-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `usage-crash-${suffix}`,
        payload: { queue: 'knowledge-outbox', usageEventId: `usage-crash-${suffix}` },
        status: 'publishing',
        attempts: 1,
        availableAt: new Date(Date.now() - 60_000),
        publishedAt: null,
        error: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    await models.KnowledgeOutboxEvent.collection.updateOne(
      { _id: event!._id },
      { $set: { updatedAt: new Date(Date.now() - 60_000) } },
    );
    const enqueue = vi.fn(async () => ({ jobId: 'k_ignored', enqueued: true }));
    const dispatcher = new KnowledgeOutboxDispatcher(connection, { enqueue } as never);
    await expect(dispatcher.dispatchOnce(context)).resolves.toMatchObject({ dispatched: true });
    const persisted = await models.KnowledgeOutboxEvent.findById(event!._id).lean();
    expect(persisted).toMatchObject({ status: 'published' });
    expect(persisted?.publishedAt).toBeInstanceOf(Date);
    expect(enqueue).toHaveBeenCalledOnce();
    await expect(dispatcher.dispatchOnce(context)).resolves.toEqual({ dispatched: false });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('dispatches only the requested pending event by ID and version', async () => {
    const models = registerKnowledgeModels(connection);
    const [target, other] = await models.KnowledgeOutboxEvent.create([
      {
        workspaceId,
        knowledgeSpaceId: null,
        version: 5,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: `target-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `target-${suffix}`,
        payload: { queue: 'knowledge-outbox', usageEventId: `target-${suffix}` },
        status: 'pending',
        attempts: 0,
        availableAt: new Date(Date.now() - 1_000),
        publishedAt: null,
        error: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        workspaceId,
        knowledgeSpaceId: null,
        version: 9,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventKey: `other-${suffix}`,
        eventType: 'usage.recorded',
        aggregateType: 'usage_event',
        aggregateId: `other-${suffix}`,
        payload: { queue: 'knowledge-outbox', usageEventId: `other-${suffix}` },
        status: 'pending',
        attempts: 0,
        availableAt: new Date(Date.now() - 10_000),
        publishedAt: null,
        error: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    const enqueue = vi.fn(async () => ({ jobId: 'k_target', enqueued: true }));
    const dispatcher = new KnowledgeOutboxDispatcher(connection, { enqueue } as never);
    await expect(dispatcher.dispatchById(String(target!._id), 5, context)).resolves.toMatchObject({
      dispatched: true,
      eventKey: target!.eventKey,
    });
    expect(await models.KnowledgeOutboxEvent.findById(target!._id).lean()).toMatchObject({
      status: 'published',
    });
    expect(await models.KnowledgeOutboxEvent.findById(other!._id).lean()).toMatchObject({
      status: 'pending',
      version: 9,
    });
    expect(enqueue).toHaveBeenCalledWith(
      'knowledge-outbox',
      expect.stringMatching(/^k_[a-f0-9]{40}$/),
      expect.objectContaining({ outboxEventId: String(target!._id) }),
      expect.any(Object),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
