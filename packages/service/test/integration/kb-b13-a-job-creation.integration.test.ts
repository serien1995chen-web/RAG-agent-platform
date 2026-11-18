import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b13a_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const context: TenantContext = {
  workspaceId,
  memberId: `b13a_mem_${suffix}`,
  requestId: `b13a_req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: ReturnType<typeof createKnowledgeMongoConnection>;
let repository: KnowledgeJobExecutionRepository;

function input(
  kind:
    | 'parse'
    | 'segment'
    | 'qa'
    | 'embed'
    | 'index'
    | 'fulltext'
    | 'rebuild'
    | 'caption'
    | 'synonym_rebuild',
  key: string,
) {
  const resourceType = kind === 'rebuild' ? ('space' as const) : ('segment' as const);
  const resourceId = new mongoose.Types.ObjectId().toString();
  const snapshots: Record<string, Record<string, unknown>> = {
    parse: { sourceVersion: 1, parseProvider: 'liteparse', configHash: 'cfg' },
    segment: { rawTextBlobId: resourceId, sourceVersion: 1, chunking: { mode: 'auto' } },
    qa: { segmentInputs: [resourceId], modelId: 'mock-qa', promptVersion: 'v1', sourceVersion: 1 },
    embed: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
    index: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
    fulltext: { segmentVersion: 1 },
    rebuild: { sourceIds: [resourceId], reason: 'manual' },
    caption: { segmentVersion: 1 },
    synonym_rebuild: { synonymVersion: 1 },
  };
  return {
    kind,
    resourceType,
    resourceId,
    knowledgeSpaceId,
    inputSnapshot: snapshots[kind],
    priority: 5,
    idempotencyKey: `b13a-${suffix}-${key}`,
  } as const;
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeJobExecutionRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B13-A Job creation and Outbox', () => {
  it('L1-B13-A-TRAIN-001-P01 creates every public job kind as one queued job with its canonical queue', async () => {
    const kinds = ['parse', 'segment', 'qa', 'embed', 'index', 'fulltext', 'rebuild'] as const;
    const models = registerKnowledgeModels(connection);
    for (const kind of kinds) {
      const created = await repository.create(input(kind, `kind-${kind}`), context);
      expect(created.jobId).toMatch(/^[a-f0-9]{24}$/);
      expect(created.status).toBe('queued');
      expect(created.kind).toBe(kind);
      expect(created.attempts).toBe(0);
      expect(created.maxAttempts).toBe(3);
      expect(created.version).toBe(1);
      expect(created.progress).toMatchObject({ stage: 'queued', percent: 0 });
      const outbox = await models.KnowledgeOutboxEvent.findOne({
        workspaceId,
        aggregateId: created.jobId,
      }).lean();
      expect(outbox?.eventType).toBe(`${kind}.job.queued`);
      expect(outbox?.payload.queue).toBe(
        kind === 'fulltext' ? 'knowledge-index' : `knowledge-${kind}`,
      );
    }
  });

  it('L1-B13-A-TRAIN-001-P03 keeps internal caption and synonym rebuild kinds on canonical queues', async () => {
    const caption = await repository.create(input('caption', 'caption'), context);
    const synonym = await repository.create(input('synonym_rebuild', 'synonym'), context);
    expect(caption.kind).toBe('caption');
    expect(synonym.kind).toBe('synonym_rebuild');
    const models = registerKnowledgeModels(connection);
    const queues = await models.KnowledgeOutboxEvent.find({
      workspaceId,
      aggregateId: { $in: [caption.jobId, synonym.jobId] },
    }).lean();
    expect(queues.map((event) => event.payload.queue).sort()).toEqual([
      'knowledge-caption',
      'knowledge-rebuild',
    ]);
  });

  it('L1-B13-A-TRAIN-001-S01 replays an identical idempotency key without a second Job or Outbox', async () => {
    const payload = input('index', 'idempotent');
    const first = await repository.create(payload, context);
    const second = await repository.create(payload, context);
    expect(second.jobId).toBe(first.jobId);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        idempotencyKey: payload.idempotencyKey,
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: first.jobId,
      }),
    ).toBe(1);
    await expect(
      repository.create(
        { ...payload, inputSnapshot: { ...payload.inputSnapshot, segmentVersion: 2 } },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: first.jobId,
      }),
    ).toBe(1);
  });

  it('L1-B13-A-TRAIN-001-C01 allows only one Job when the same idempotency key is created concurrently', async () => {
    const payload = input('index', 'concurrent');
    const results = await Promise.allSettled([
      repository.create(payload, context),
      repository.create(payload, context),
    ]);
    const created = results
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.create>>> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((job) => job.jobId)).size).toBe(1);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        idempotencyKey: payload.idempotencyKey,
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: created[0]!.jobId,
      }),
    ).toBe(1);
  });

  it('L1-B13-A-TRAIN-001-Q01 keeps the Job and Outbox unique indexes and TTL indexes installed', async () => {
    const models = registerKnowledgeModels(connection);
    const jobIndexes = await models.KnowledgeJob.collection.indexes();
    const outboxIndexes = await models.KnowledgeOutboxEvent.collection.indexes();
    expect(jobIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ux_job_idempotency', unique: true }),
        expect.objectContaining({ name: 'ttl_job_expiry' }),
      ]),
    );
    expect(outboxIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ux_outbox_event', unique: true }),
        expect.objectContaining({ name: 'ttl_outbox_dispatch' }),
      ]),
    );
  });

  it('L1-B13-A-TRAIN-001-F04 rolls back the Job when transactional Outbox creation fails', async () => {
    const payload = input('index', 'outbox-rollback');
    const models = registerKnowledgeModels(connection);
    const outboxBefore = await models.KnowledgeOutboxEvent.countDocuments({ workspaceId });
    const createOutbox = vi
      .spyOn(models.KnowledgeOutboxEvent, 'create')
      .mockRejectedValueOnce(new Error('forced outbox failure'));
    try {
      await expect(repository.create(payload, context)).rejects.toThrow('forced outbox failure');
    } finally {
      createOutbox.mockRestore();
    }
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        idempotencyKey: payload.idempotencyKey,
      }),
    ).toBe(0);
    expect(await models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(outboxBefore);
  });
});
