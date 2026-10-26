import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  S5UsageRepository,
  usageEventIdOf,
} from '../../src/modules/knowledge/repository/s5-usage.repository';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

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
  });
});
