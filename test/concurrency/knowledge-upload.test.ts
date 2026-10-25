import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeObjectRefRepository } from '../../packages/service/src/modules/knowledge/repository/object-ref.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_concurrency_${suffix}`;
const spaceId = randomUUID().replaceAll('-', '').slice(0, 24);
const context: TenantContext = {
  workspaceId,
  memberId: `member_${suffix}`,
  requestId: `request_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:write'],
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeObjectRefRepository;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s2_concurrency_${suffix}?directConnection=true`,
  );
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeObjectRefRepository(connection);
}, 30_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-FILE-001-BLOCK upload CAS', () => {
  it('TEST-FILE-001-U06 allows only one complete transition from a version', async () => {
    const uploadId = randomUUID().replaceAll('-', '').slice(0, 24);
    await repository.createUploadSession(
      {
        uploadId,
        workspaceId,
        knowledgeSpaceId: spaceId,
        provider: 'minio',
        bucket: 'kb-test',
        objectKey: `ws/${workspaceId}/space/${spaceId}/source/unbound/source/${uploadId}/race.txt`,
        mimeType: 'text/plain',
        sizeBytes: 1,
        originalName: 'race.txt',
        mode: 'single',
        partSizeBytes: 8388608,
        partCount: 1,
        providerUploadId: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
      context,
    );
    const results = await Promise.allSettled([
      repository.markUploadCompleting(uploadId, 1, context),
      repository.markUploadCompleting(uploadId, 1, context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
