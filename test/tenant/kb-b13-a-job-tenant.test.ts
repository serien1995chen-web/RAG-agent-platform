import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

function objectId() {
  return randomUUID().replaceAll('-', '').slice(0, 24);
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_b13a_tenant_a_${suffix}`;
const workspaceB = `ws_b13a_tenant_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `b13a_mem_a_${suffix}`,
  requestId: `b13a_req_a_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `b13a_mem_b_${suffix}`,
  requestId: `b13a_req_b_${suffix}`,
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
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceA, workspaceB] },
    });
  }
  await connection.close();
});

describe('B13-A Job tenant isolation', () => {
  it('L1-B13-A-TRAIN-001-A01 creates a Job only inside the calling workspace and hides it from another workspace', async () => {
    const created = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: objectId(),
        knowledgeSpaceId: objectId(),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `b13a-tenant-${suffix}`,
      },
      contextA,
    );
    expect(created.workspaceId).toBe(workspaceA);
    await expect(repository.getRaw(created.jobId, contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(
      await repository.claimById(
        { jobId: created.jobId, kinds: ['index'], workerId: `tenant-b-${suffix}` },
        contextB,
      ),
    ).toBeNull();
    expect((await repository.getRaw(created.jobId, contextA)).status).toBe('queued');
  });

  it('L1-B13-A-TRAIN-002-A01 rejects cross-workspace commits and keeps the owning Job untouched', async () => {
    const created = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: objectId(),
        knowledgeSpaceId: objectId(),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `b13a-tenant-fence-${suffix}`,
      },
      contextA,
    );
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `tenant-a-${suffix}` },
      contextA,
    );
    const raw = await repository.getRaw(created.jobId, contextA);
    const fence = String(raw.fencingToken);
    const started = await repository.start(
      created.jobId,
      claimed!.version,
      raw.attemptEpoch,
      fence,
      `tenant-a-${suffix}`,
      contextA,
    );
    await expect(
      repository.commit(
        created.jobId,
        started.version,
        raw.attemptEpoch,
        fence,
        `tenant-a-${suffix}`,
        { forgedBy: workspaceB },
        contextB,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    const after = await repository.getRaw(created.jobId, contextA);
    expect(after.status).toBe('running');
    expect(after.result).toBeNull();
  });

  it('L1-B13-A-TRAIN-001-A01 denies creating a Job when TenantContext has no workspace', async () => {
    await expect(
      repository.create(
        {
          kind: 'index',
          resourceType: 'segment',
          resourceId: objectId(),
          knowledgeSpaceId: objectId(),
          inputSnapshot: { segmentVersion: 1 },
          priority: 5,
          idempotencyKey: `b13a-tenant-missing-${suffix}`,
        },
        { ...contextA, workspaceId: '' },
      ),
    ).rejects.toBeDefined();
  });
});
