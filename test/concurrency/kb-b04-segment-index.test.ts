import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b04_concurrency_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b04_concurrency_${suffix}`,
  requestId: `req_b04_concurrency_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let jobs: KnowledgeJobExecutionRepository;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B04 index state concurrency', () => {
  it('L1-B04-DATA-003-C01 ready success cannot be rolled back by a late failure from the same worker', async () => {
    const job = await jobs.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
        knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `b04-state-race-${suffix}`,
      },
      context,
    );
    const workerId = `b04-worker-${suffix}`;
    const claimed = await jobs.claimById({ jobId: job.jobId, kinds: ['index'], workerId }, context);
    expect(claimed).toBeTruthy();
    const claimedRaw = await jobs.getRaw(job.jobId, context);
    const started = await jobs.start(
      job.jobId,
      claimedRaw.version,
      claimedRaw.attemptEpoch,
      claimedRaw.fencingToken,
      workerId,
      context,
    );
    const succeeded = await jobs.commit(
      job.jobId,
      started.version,
      claimedRaw.attemptEpoch,
      claimedRaw.fencingToken,
      workerId,
      { indexStatus: 'indexed' },
      context,
    );
    expect(succeeded.status).toBe('succeeded');

    await expect(
      jobs.fail(
        job.jobId,
        started.version,
        claimedRaw.attemptEpoch,
        claimedRaw.fencingToken,
        workerId,
        false,
        'KNOWLEDGE_MODEL_FAILED',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect(await jobs.getRaw(job.jobId, context)).toMatchObject({
      status: 'succeeded',
      result: { indexStatus: 'indexed' },
    });
  });
});
