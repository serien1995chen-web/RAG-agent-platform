import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S5UsageRepository } from '../../src/modules/knowledge/repository/s5-usage.repository';
import {
  computeUsagePointsMicros,
  type S10UsageKind,
} from '../../src/modules/knowledge/domain/s10-usage';
import { FIXTURE_V1_PRICING, FREE_V1_QUOTA } from '../../src/shared/config/s10-profiles';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = (process.env.B19_RUN_ID ?? 'b19-a-20261122-220039-7c1e')
  .replaceAll(/[^A-Za-z0-9]/g, '')
  .slice(-12);
const workspaceId = `b19-a-20261122-220039-7c1e-ops-${suffix}`;
const knowledgeSpaceId = new Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `b19-a-20261122-220039-7c1e-owner-${suffix}`,
  requestId: `b19-a-ops-${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

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

function fact(input: {
  operation: string;
  kind: S10UsageKind;
  unit: 'page' | 'image' | 'token' | 'vector' | 'byte' | 'request' | 'second' | 'character';
  quantity: number;
  inputTokens?: number;
  outputTokens?: number;
  eventSequence: number;
}) {
  return {
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    operation: input.operation,
    requestId: `${context.requestId}-${input.eventSequence}`,
    traceId: context.traceId,
    modelId: `b19-model-${input.kind}`,
    kind: input.kind,
    attempt: 1,
    eventSequence: input.eventSequence,
    quantity: input.quantity,
    unit: input.unit,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    status: 200,
    fallbackUsed: false,
    provider: 'b19-local-provider',
    resourceType: 'space' as const,
    resourceId: String(knowledgeSpaceId),
  };
}

describe('L1-B19-OPS-001 usage validation and accounting', () => {
  it('L1-B19-OPS-001-C01 persists one event and one outbox fact for concurrent duplicate writes', async () => {
    const factValue = fact({
      operation: 'concurrent-dedup',
      kind: 'llm',
      unit: 'token',
      quantity: 1100,
      inputTokens: 1000,
      outputTokens: 100,
      eventSequence: 1,
    });
    const inserted = await Promise.all(
      Array.from({ length: 8 }, () => usage.recordInvocationUsage(factValue, context)),
    );
    const models = registerKnowledgeModels(connection);
    expect(inserted.filter(Boolean)).toHaveLength(1);
    expect(await models.KnowledgeUsageEvent.countDocuments({ workspaceId })).toBe(1);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
    const summary = await usage.summary(
      {
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000),
      },
      context,
    );
    expect(summary.usage).toMatchObject({
      aiPointsMicros: 1_200_000,
      aiPoints: 1.2,
      inputTokens: 1000,
      outputTokens: 100,
      modelCalls: 1,
    });
  });

  it('L1-B19-OPS-001-Q01 stores every declared unit label and reconciles their points', async () => {
    const models = registerKnowledgeModels(connection);
    const units = [
      'page',
      'image',
      'token',
      'vector',
      'byte',
      'request',
      'second',
      'character',
    ] as const;
    const now = new Date();
    await models.KnowledgeUsageEvent.create(
      units.map((unit, index) => ({
        workspaceId,
        knowledgeSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        eventId: `${context.requestId}-unit-${unit}`,
        eventType: index === 0 ? 'ocr' : 'storage',
        quantity: index + 1,
        unit,
        inputTokens: 0,
        outputTokens: 0,
        pointsMicros: index + 1,
        pricingVersion: FIXTURE_V1_PRICING.version,
        pricingSnapshot: FIXTURE_V1_PRICING,
        modelId: null,
        resourceType: 'space',
        resourceId: knowledgeSpaceId,
        jobId: null,
        source: 'api',
        occurredAt: new Date(now.getTime() + index),
        deliveredAt: null,
        deliveryStatus: 'pending',
        expiresAt: new Date(now.getTime() + 730 * 86_400_000),
      })),
    );
    const summary = await usage.summary(
      {
        from: new Date(now.getTime() - 60_000),
        to: new Date(now.getTime() + 60_000),
      },
      context,
    );
    expect(summary.usage.aiPointsMicros).toBe(36);
    expect(summary.usage.parsePages).toBe(1);
    expect(summary.delivery).toEqual({ pending: 8, delivered: 0, failed: 0 });
    expect(
      new Set(
        (await models.KnowledgeUsageEvent.find({ workspaceId }).select({ unit: 1 }).lean()).map(
          (event) => event.unit,
        ),
      ),
    ).toEqual(new Set(units));
  });

  it('L1-B19-OPS-001-N01 rejects negative usage values', async () => {
    await expect(
      usage.recordInvocationUsage(
        fact({
          operation: 'negative-input-tokens',
          kind: 'llm',
          unit: 'token',
          quantity: 10,
          inputTokens: -1,
          eventSequence: 20,
        }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B19-OPS-001-N02 rejects an illegal usage unit', () => {
    expect(() =>
      computeUsagePointsMicros({
        kind: 'ocr',
        status: 200,
        intent: false,
        quantity: 1,
        unit: 'furlong' as never,
        pricing: FIXTURE_V1_PRICING,
      }),
    ).toThrow(/unit/);
  });

  it('L1-B19-OPS-001-Q01 accepts native TTS character usage', () => {
    expect(
      computeUsagePointsMicros({
        kind: 'tts',
        status: 200,
        intent: false,
        quantity: 2,
        unit: 'character',
        pricing: FIXTURE_V1_PRICING,
      }),
    ).toBe(0);
  });
});
