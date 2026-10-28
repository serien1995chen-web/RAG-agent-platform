import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileTicketService } from '../../../../sdk/storage/src/file-ticket';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S8FileTicketAdapter } from '../../src/modules/knowledge/adapter/s8-file-ticket.adapter';
import { S8ModelResolver } from '../../src/modules/knowledge/adapter/s8-model-resolver';
import { S8CaptionApplication } from '../../src/modules/knowledge/application/s8-caption.application';
import { S8ContentEnhancementApplication } from '../../src/modules/knowledge/application/s8-content-enhancement.application';
import { KnowledgeFullTextRepository } from '../../src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { S8ImageIndexRepository } from '../../src/modules/knowledge/repository/s8-image-index.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import {
  ensurePgvectorDdl,
  KnowledgeVectorRepository,
} from '../../src/shared/persistence/pgvector';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s8_auto_image_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s8_auto_image_${suffix}`,
  requestId: `req_s8_auto_image_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
};

let connection: mongoose.Connection;
let pool: Pool;

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s8_auto_image_${suffix}?directConnection=true`,
  );
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  pool = new Pool({
    connectionString:
      process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
  });
  await ensurePgvectorDdl(pool);
}, 60_000);

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  if (pool) {
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
    await pool.end();
  }
});

describe('TEST-PARSE-005-BLOCK document image asset indexing', () => {
  it('indexes a file asset without changing the parent Source processing state', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await models.KnowledgeSpace.create({
      workspaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'space',
      parentSpaceId: null,
      name: `S8 auto image ${suffix}`,
      normalizedName: `s8-auto-image-${suffix}`,
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
      version: 2,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'policy.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      contentHash: 'sha256',
      parseProvider: 'liteparse',
      processingStatus: 'parsing',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'inherited',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
      metadata: {},
      tagValues: [],
    });
    const object = new mongoose.Types.ObjectId();
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
      objectKey: `ws/${workspaceId}/space/${space._id}/asset/image.png`,
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
        finalObjectKey: `ws/${workspaceId}/space/${space._id}/asset/image.png`,
        finalizedAt: now,
        pendingUrlExpiresAt: null,
        partSizeBytes: 128,
        partCount: 1,
        parts: [],
        originalName: 'image.png',
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

    const catalog = new S5MockModelCatalog();
    const modelsPort = new S8ModelResolver(connection, catalog);
    const indexes = new S8ImageIndexRepository(connection);
    const caption = new S8CaptionApplication({
      store: new S6ProcessingRepository(connection),
      objects: new KnowledgeObjectRefRepository(connection),
      models: modelsPort,
      gateway: {
        async invoke<T>(request) {
          if (request.kind === 'vlm') {
            return {
              data: {
                choices: [
                  {
                    message: { content: JSON.stringify({ caption: 'Document diagram' }) },
                  },
                ],
              } as T,
              actualModelId: request.modelId,
              attempts: 1,
              fallbackUsed: false,
              degraded: false,
              usage: { inputTokens: 2, outputTokens: 1, quantity: 3 },
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
          `s8-auto-image-ticket-${suffix}-at-least-32-bytes`,
          'http://127.0.0.1:3010',
        ),
      ),
      vectors: new KnowledgeVectorRepository(pool),
      fulltext: new KnowledgeFullTextRepository(connection),
      indexes,
    });
    const enhancement = new S8ContentEnhancementApplication({
      gateway: {
        async invoke() {
          throw new Error('paragraph enhancement not expected');
        },
      },
      models: modelsPort,
      caption,
    });
    const result = await enhancement.indexAssets({
      sourceId: String(source._id),
      sourceVersion: 1,
      assets: [
        {
          assetId: 'asset-1',
          mimeType: 'image/png',
          sha256: 'sha256',
          sizeBytes: 128,
          objectRefId: String(object._id),
        },
      ],
      orderOffset: 3,
      context,
    });
    expect(result).toMatchObject({
      segmentIds: [expect.any(String)],
      partial: false,
    });
    const segment = await models.KnowledgeSegment.findOne({
      workspaceId,
      sourceId: source._id,
    }).lean();
    expect(segment).toMatchObject({
      order: 3,
      imageDescription: 'Document diagram',
      metadata: {
        imageAssetId: 'asset-1',
        captionStatus: 'indexed',
        vectorStatus: 'indexed',
      },
    });
    const currentSource = await models.KnowledgeSource.findById(source._id).lean();
    expect(currentSource?.processingStatus).toBe('parsing');
  }, 60_000);
});
