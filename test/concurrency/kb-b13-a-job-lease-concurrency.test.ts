import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
function objectId() {
  return randomUUID().replaceAll('-', '').slice(0, 24);
}
const workspaceId = `ws_b13a_conc_${suffix}`;
const knowledgeSpaceId = objectId();
const context: TenantContext = {
  workspaceId,
  memberId: `b13a_conc_mem_${suffix}`,
  requestId: `b13a_conc_req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: ReturnType<typeof createKnowledgeMongoConnection>;
let repository: KnowledgeJobExecutionRepository;

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

describe('B13-A Job lease concurrency', () => {
  it('L1-B13-A-TRAIN-001-C01 creates one Job for concurrent identical idempotent requests', async () => {
    const payload = {
      kind: 'index' as const,
      resourceType: 'segment' as const,
      resourceId: objectId(),
      knowledgeSpaceId,
      inputSnapshot: { segmentVersion: 1 },
      priority: 5,
      idempotencyKey: `b13a-conc-idem-${suffix}`,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => repository.create(payload, context)),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.create>>> =>
        result.status === 'fulfilled',
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fulfilled.map((result) => result.value.jobId)).size).toBe(1);
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
        aggregateId: fulfilled[0]!.value.jobId,
      }),
    ).toBe(1);
  });

  it('L1-B13-A-TRAIN-002-C01 allows exactly one of repeated claims for the same Job', async () => {
    const created = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: objectId(),
        knowledgeSpaceId,
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `b13a-conc-same-${suffix}`,
      },
      context,
    );
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.claimById(
          { jobId: created.jobId, kinds: ['index'], workerId: `same-${index}-${suffix}` },
          context,
        ),
      ),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.attemptEpoch).toBe(1);
    expect(new Set(claims.filter(Boolean).map((claim) => claim!.jobId))).toEqual(
      new Set([created.jobId]),
    );
  });

  it('L1-B13-A-TRAIN-002-C02 claims and fences a batch of 10 parse and 10 index Jobs without cross-contamination', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const kind = index < 10 ? ('parse' as const) : ('index' as const);
        return repository.create(
          {
            kind,
            resourceType: 'segment',
            resourceId: objectId(),
            knowledgeSpaceId,
            inputSnapshot:
              kind === 'parse'
                ? { sourceVersion: 1, parseProvider: 'liteparse', configHash: `cfg-${index}` }
                : { segmentVersion: 1, modelId: 'mock-embedding-1024' },
            priority: 5,
            idempotencyKey: `b13a-batch-${suffix}-${index}`,
          },
          context,
        );
      }),
    );
    const claimed = await Promise.all(
      created.map((job, index) =>
        repository.claimById(
          {
            jobId: job.jobId,
            kinds: [job.kind as 'parse' | 'index'],
            workerId: `batch-${index}-${suffix}`,
          },
          context,
        ),
      ),
    );
    expect(claimed.every((job) => job !== null)).toBe(true);
    const raw = await Promise.all(created.map((job) => repository.getRaw(job.jobId, context)));
    expect(new Set(raw.map((job) => String(job.fencingToken))).size).toBe(20);
    expect(new Set(claimed.map((job) => job!.jobId)).size).toBe(20);
    expect(claimed.every((job) => job!.status === 'leased')).toBe(true);
    expect(claimed.every((job) => job!.attemptEpoch === 1)).toBe(true);

    const secondPass = await Promise.all(
      created.map((job, index) =>
        repository.claimById(
          {
            jobId: job.jobId,
            kinds: [job.kind as 'parse' | 'index'],
            workerId: `second-${index}-${suffix}`,
          },
          context,
        ),
      ),
    );
    expect(secondPass.every((job) => job === null)).toBe(true);
  });
});
