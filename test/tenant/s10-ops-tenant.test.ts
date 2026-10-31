import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S10OperationsRepository } from '../../packages/service/src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeAuditRepository } from '../../packages/service/src/shared/persistence/knowledge/audit';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_s10_ops_tenant_a_${suffix}`;
const workspaceB = `ws_s10_ops_tenant_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `member_a_${suffix}`,
  requestId: `request_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:admin'],
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `member_b_${suffix}`,
  requestId: `request_b_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  connection = await createKnowledgeMongoConnection(value);
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
}, 60_000);

beforeEach(async () => {
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

describe('TEST-X-TENANT-GUARD S10 ops audit', () => {
  it('returns no workspace A audit records to workspace B', async () => {
    await audits.appendStandalone(
      {
        knowledgeSpaceId: null,
        action: 'cleanup.queued',
        resourceType: 'job',
        resourceId: `65f1e5b2a1c9d4b7e8f0${suffix.slice(0, 4)}`,
        outcome: 'succeeded',
        safeDiff: { scope: 'all' },
      },
      contextA,
    );
    expect((await operations.list({ limit: 10 }, contextA)).items).toHaveLength(1);
    expect(await operations.list({ limit: 10 }, contextB)).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
  });
});
