import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S8ImageIndexRepository } from '../../packages/service/src/modules/knowledge/repository/s8-image-index.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s8_cas_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s8_cas_${suffix}`,
  requestId: `req_s8_cas_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s8_cas_${suffix}?directConnection=true`,
  );
  await ensureKnowledgeCollections(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-TRAIN-003-BLOCK / TEST-SEARCH-008-BLOCK concurrency contracts', () => {
  it('allows only one image index pointer switch for the same Segment version', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await models.KnowledgeSpace.create({
      workspaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'space',
      parentSpaceId: null,
      name: `CAS ${suffix}`,
      normalizedName: `cas-${suffix}`,
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
    const source = await models.KnowledgeSource.create({
      workspaceId,
      knowledgeSpaceId: space._id,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'image',
      name: 'cas.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      contentHash: 'sha256',
      parseProvider: 'liteparse',
      processingStatus: 'queued',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'inherited',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
      metadata: {},
      tagValues: [],
    });
    const repository = new S8ImageIndexRepository(connection);
    const imageBlobRefId = new connection.base.Types.ObjectId().toString();
    const segment = await repository.ensureImageSegment(
      {
        source: {
          id: String(source._id),
          workspaceId,
          knowledgeSpaceId: String(space._id),
          kind: 'image',
          sourceVersion: 1,
          blobRefId: imageBlobRefId,
          name: 'cas.png',
          mimeType: 'image/png',
          parseProvider: 'liteparse',
          searchEnabled: true,
          processingStatus: 'queued',
          version: 1,
        },
        imageBlobRefId,
      },
      context,
    );
    const base = {
      segmentId: segment.id,
      expectedVersion: segment.version,
      sourceVersion: 1,
      imageBlobRefId,
      imageDescription: 'caption',
      captionPromptVersion: 's8.image-caption.v1',
      visionEmbeddingModelId: 'mock-embedding-1536',
      captionKey: 'fixture',
      indexes: [],
    };
    const [left, right] = await Promise.all([
      repository.commit({ ...base, captionStatus: 'indexed', vectorStatus: 'error' }, context),
      repository.commit({ ...base, captionStatus: 'error', vectorStatus: 'indexed' }, context),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const current = await models.KnowledgeSegment.findById(segment.id).lean();
    expect(
      current?.metadata.captionStatus === 'indexed'
        ? current.metadata.vectorStatus === 'error'
        : current?.metadata.vectorStatus === 'indexed',
    ).toBe(true);
  }, 60_000);
});
