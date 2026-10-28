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

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_cas_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_cas_${suffix}`,
  requestId: `req_s6_cas_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
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

describe('S6 Job fencing concurrency', () => {
  it('allows exactly one of two concurrent claims', async () => {
    const job = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
        knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `s6-cas-${suffix}`,
      },
      context,
    );
    const [left, right] = await Promise.all([
      repository.claimById(
        { jobId: job.jobId, kinds: ['index'], workerId: `left-${suffix}` },
        context,
      ),
      repository.claimById(
        { jobId: job.jobId, kinds: ['index'], workerId: `right-${suffix}` },
        context,
      ),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
  });
});
