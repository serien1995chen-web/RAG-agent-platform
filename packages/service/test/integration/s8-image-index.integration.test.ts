import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileTicketService } from '../../../../sdk/storage/src/file-ticket';
import { S8FileTicketAdapter } from '../../src/modules/knowledge/adapter/s8-file-ticket.adapter';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S8ModelResolver } from '../../src/modules/knowledge/adapter/s8-model-resolver';
import { S8CaptionApplication } from '../../src/modules/knowledge/application/s8-caption.application';
import { KnowledgeFullTextRepository } from '../../src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { S8ImageIndexRepository } from '../../src/modules/knowledge/repository/s8-image-index.repository';
import { KnowledgeVectorRepository } from '../../src/shared/persistence/pgvector';
import { ensurePgvectorDdl } from '../../src/shared/persistence/pgvector';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s8_index_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s8_index_${suffix}`,
  requestId: `req_s8_index_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:write', 'knowledge:read'],
};

let connection: mongoose.Connection;
let pool: Pool;
let spaceId: string;
let sourceId: string;
let imageBlobRefId: string;

async function seed() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `S8 index ${suffix}`,
    normalizedName: `s8-index-${suffix}`,
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
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'image',
    name: 'refund-flow.png',
    mimeType: 'image/png',
    sizeBytes: 128,
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
  sourceId = String(source._id);
  const object = new mongoose.Types.ObjectId();
  imageBlobRefId = String(object);
  const now = new Date();
  await models.KnowledgeObjectRef.create({
    _id: object,
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    provider: 'minio',
    bucket: 'kb-test',
    objectKey: `ws/${workspaceId}/space/${spaceId}/source/${sourceId}/refund.png`,
    purpose: 'image',
    sourceId: source._id,
    mimeType: 'image/png',
    sizeBytes: 128,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active',
    expiresAt: null,
    upload: {
      mode: 'single',
      status: 'completed',
      providerUploadId: null,
      pendingObjectKey: null,
      finalObjectKey: `ws/${workspaceId}/space/${spaceId}/source/${sourceId}/refund.png`,
      finalizedAt: now,
      pendingUrlExpiresAt: null,
      partSizeBytes: 128,
      partCount: 1,
      parts: [],
      originalName: 'refund.png',
      completedAt: now,
      abortedAt: null,
    },
  });
  await models.KnowledgeModelBinding.create([
    {
      workspaceId,
      knowledgeSpaceId: space._id,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      modelType: 'vlm',
      modelId: 'mock-vlm',
      displayName: 'Mock VLM',
      requiredCapabilities: ['vision'],
      status: 'active',
      authorizedAt: now,
    },
    {
      workspaceId,
      knowledgeSpaceId: space._id,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      modelType: 'embedding',
      modelId: 'mock-embedding-1536',
      displayName: 'Mock vision embedding',
      requiredCapabilities: ['vision'],
      status: 'active',
      authorizedAt: now,
    },
  ]);
  await models.KnowledgeSource.updateOne({ _id: source._id }, { $inc: { version: 1 } });
}

beforeAll(async () => {
  const mongoUri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s8_index_${suffix}?directConnection=true`,
  );
  connection = mongoose.createConnection(mongoUri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  pool = new Pool({
    connectionString:
      process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
  });
  await ensurePgvectorDdl(pool);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await seed();
});

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await pool?.end();
});

describe('TEST-X-IMAGE-CAPTION / TEST-TRAIN-003-BLOCK image index', () => {
  it('writes caption/image ordered inputs and switches both indexes after successful CAS', async () => {
    const catalog = new S5MockModelCatalog();
    const indexes = new S8ImageIndexRepository(connection);
    const application = new S8CaptionApplication({
      store: new S6ProcessingRepository(connection),
      objects: new KnowledgeObjectRefRepository(connection),
      models: new S8ModelResolver(connection, catalog),
      gateway: {
        async invoke<T>(request) {
          if (request.kind === 'vlm') {
            return {
              data: {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ caption: 'A refund flow diagram' }),
                    },
                  },
                ],
              } as T,
              actualModelId: request.modelId,
              attempts: 1,
              fallbackUsed: false,
              degraded: false,
              usage: { inputTokens: 3, outputTokens: 2, quantity: 5 },
            };
          }
          const count = request.input?.length ?? 0;
          return {
            data: {
              data: Array.from({ length: count }, (_, itemIndex) => ({
                index: itemIndex,
                embedding: Array.from({ length: 1536 }, (_, vectorIndex) =>
                  vectorIndex === itemIndex ? 1 : 0,
                ),
              })),
            } as T,
            actualModelId: request.modelId,
            attempts: 1,
            fallbackUsed: false,
            degraded: false,
            usage: { inputTokens: 2, outputTokens: 0, quantity: 2 },
          };
        },
      },
      tickets: new S8FileTicketAdapter(
        new FileTicketService(
          's8-integration-ticket-secret-at-least-32-bytes',
          'http://127.0.0.1:3010',
        ),
      ),
      vectors: new KnowledgeVectorRepository(pool),
      fulltext: new KnowledgeFullTextRepository(connection),
      indexes,
    });

    const result = await application.execute(
      {
        _id: new mongoose.Types.ObjectId(),
        resourceId: sourceId,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          imageBlobRefId,
        },
      } as never,
      context,
    );
    expect(result.result).toMatchObject({
      captionStatus: 'indexed',
      vectorStatus: 'indexed',
      sourceVersion: 1,
    });
    const segment = await connection.models.KnowledgeSegment.findOne({
      workspaceId,
      sourceId,
    }).lean();
    expect(segment).toMatchObject({
      order: 0,
      imageDescription: 'A refund flow diagram',
      metadata: {
        captionStatus: 'indexed',
        vectorStatus: 'indexed',
        imageSourceVersion: 1,
        imageSource: true,
      },
    });
    expect(segment?.indexes.map((index: { indexId: string }) => index.indexId).sort()).toEqual([
      'image',
      'image_caption',
    ]);
    const rows = await pool.query(
      'SELECT index_id FROM knowledge_segment_vectors_1536 WHERE workspace_id = $1 AND source_id = $2 ORDER BY index_id',
      [workspaceId, sourceId],
    );
    expect(rows.rows.map((row) => row.index_id)).toEqual(['image', 'image_caption']);
    expect(segment?.fullTextVersion).toBeGreaterThan(0);
  }, 60_000);

  it('clears the previous searchable pointers atomically when sourceVersion advances', async () => {
    const models = registerKnowledgeModels(connection);
    const source = await models.KnowledgeSource.findById(sourceId).lean();
    if (!source) throw new Error('source missing');
    const indexes = new S8ImageIndexRepository(connection);
    await indexes.ensureImageSegment(
      {
        source: {
          id: String(source._id),
          workspaceId,
          knowledgeSpaceId: String(source.knowledgeSpaceId),
          kind: 'image',
          sourceVersion: 1,
          blobRefId: imageBlobRefId,
          name: source.name,
          mimeType: source.mimeType,
          parseProvider: source.parseProvider,
          searchEnabled: source.searchEnabled,
          processingStatus: source.processingStatus,
          version: source.version,
        },
        imageBlobRefId,
      },
      context,
    );
    await models.KnowledgeSegment.updateOne(
      { workspaceId, sourceId },
      {
        $set: {
          indexes: [
            {
              indexId: 'image',
              type: 'image',
              modelId: 'mock-embedding-1536',
              dimension: 1536,
              storageType: 'vector',
              vectorProfile: 'knowledge_segment_vectors_1536',
              vectorId: '00000000-0000-4000-8000-000000000001',
              text: 'old caption',
              version: 1,
            },
          ],
          fullTextTokens: 'old caption',
          fullTextVersion: 4,
          imageDescription: 'old caption',
          metadata: {
            captionStatus: 'indexed',
            vectorStatus: 'indexed',
            imageSourceVersion: 1,
          },
        },
      },
    );
    const nextBlob = new mongoose.Types.ObjectId().toString();
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      {
        $set: { sourceVersion: 2, blobRefId: new mongoose.Types.ObjectId(nextBlob) },
        $inc: { version: 1 },
      },
    );
    const reset = await indexes.ensureImageSegment(
      {
        source: {
          id: sourceId,
          workspaceId,
          knowledgeSpaceId: String(source.knowledgeSpaceId),
          kind: 'image',
          sourceVersion: 2,
          blobRefId: nextBlob,
          name: source.name,
          mimeType: source.mimeType,
          parseProvider: source.parseProvider,
          searchEnabled: source.searchEnabled,
          processingStatus: source.processingStatus,
          version: source.version + 1,
        },
        imageBlobRefId: nextBlob,
      },
      context,
    );
    expect(reset).toMatchObject({
      sourceVersion: 2,
      indexes: [],
      fullTextVersion: 0,
      imageDescription: null,
      metadata: {
        captionStatus: 'pending',
        vectorStatus: 'pending',
      },
    });
  });
});
