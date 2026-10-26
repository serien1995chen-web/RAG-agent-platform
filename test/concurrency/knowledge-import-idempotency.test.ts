import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeImportRepository } from '../../packages/service/src/modules/knowledge/repository/import.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import type { ImportSubmissionCommand } from '../../packages/service/src/modules/knowledge/application/ingestion.ports';
import { requestHashOf } from '../../packages/service/src/modules/knowledge/domain/import-submission';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_concurrency_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:write'],
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeImportRepository;
let spaceId: string;

function command(key: string, body: string): ImportSubmissionCommand {
  return {
    workspaceId,
    knowledgeSpaceId: spaceId,
    directoryId: null,
    importKind: 'text',
    idempotencyKey: key,
    requestHash: requestHashOf({ body }),
    configurationHash: requestHashOf({ chunking: 'auto' }),
    sourceDrafts: [
      {
        id: new connection.base.Types.ObjectId().toString(),
        kind: 'text',
        name: `${body}.txt`,
        directoryId: null,
        blobRefId: null,
        externalId: null,
        connectorId: null,
        mimeType: 'text/plain',
        sizeBytes: body.length,
        contentHash: body,
        parseProvider: 'liteparse',
        metadata: {},
      },
    ],
    parseConfigSnapshot: {},
    chunkingConfigSnapshot: {},
    qaConfigSnapshot: {},
  };
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    (
      process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s4_concurrency_${suffix}?replicaSet=rs0&directConnection=true`
    ).toString(),
  );
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeImportRepository(connection);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  const space = await connection.models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `Concurrency ${suffix}`,
    normalizedName: `concurrency-${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 0,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  spaceId = String(space._id);
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-X-S4-IDEMPOTENCY', () => {
  it('TEST-X-S4-IDEMPOTENCY/TEST-DOWN-004-U03 coalesces 10 concurrent identical submissions', async () => {
    const shared = command(`concurrent-${suffix}`, 'same-body');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => repository.submit(shared, context)),
    );
    expect(new Set(results.map((result) => result.parentJobId)).size).toBe(1);
    expect(new Set(results.map((result) => result.sourceIds[0])).size).toBe(1);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(1);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(1);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
  });

  it('TEST-DOWN-004-U04 allows only one side of a concurrent different-body conflict', async () => {
    const key = `different-${suffix}`;
    const outcomes = await Promise.allSettled([
      repository.submit(command(key, 'left'), context),
      repository.submit(command(key, 'right'), context),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });
});
