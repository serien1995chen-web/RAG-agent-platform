import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../sdk/storage/src';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5AiproxyCatalogAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S8ModelResolver } from '../../packages/service/src/modules/knowledge/adapter/s8-model-resolver';
import { S8CaptionApplication } from '../../packages/service/src/modules/knowledge/application/s8-caption.application';
import { KnowledgeFullTextRepository } from '../../packages/service/src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeObjectRefRepository } from '../../packages/service/src/modules/knowledge/repository/object-ref.repository';
import { S6ProcessingRepository } from '../../packages/service/src/modules/knowledge/repository/s06-processing.repository';
import { S8ImageIndexRepository } from '../../packages/service/src/modules/knowledge/repository/s8-image-index.repository';
import {
  createKnowledgeConnections,
  loadKnowledgeRuntimeConfig,
  type KnowledgeConnections,
} from '../../packages/service/src';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';
import {
  ensurePgvectorDdl,
  KnowledgeVectorRepository,
} from '../../packages/service/src/shared/persistence/pgvector';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { requiredProviderEnv, safeHostHash, writeProviderEvidence } from './s11-real-helpers';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = join(root, 'test/fixtures/b12');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b12_real_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b12_real_${suffix}`,
  requestId: `req_b12_real_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write'],
  isWorkspaceOwner: true,
};

interface ImageCase {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  encodedFile: string;
}

const imageCases: readonly ImageCase[] = [
  {
    name: 'b12-real-caption.png',
    mimeType: 'image/png',
    encodedFile: 'valid-1x1.png.b64',
  },
  {
    name: 'b12-real-caption.jpg',
    mimeType: 'image/jpeg',
    encodedFile: 'valid-1x1.jpg.b64',
  },
];

let connections: KnowledgeConnections;
let connection: KnowledgeConnections['mongo'];
let pool: KnowledgeConnections['pg'];
let objectStore: MinioKnowledgeObjectStore;
const createdObjectKeys = new Set<string>();

function fixtureBytes(image: ImageCase): Buffer {
  return Buffer.from(readFileSync(join(fixtureRoot, image.encodedFile), 'utf8').trim(), 'base64');
}

function dataUrl(image: ImageCase): string {
  return `data:${image.mimeType};base64,${fixtureBytes(image).toString('base64')}`;
}

beforeAll(async () => {
  const config = loadKnowledgeRuntimeConfig({
    ...process.env,
    KB_ENV: 'test',
    KB_MONGO_URI:
      process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_b12_real_${suffix}?directConnection=true`,
    KB_REDIS_URL: process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    KB_PG_URL: process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
    KB_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    KB_S3_BUCKET: process.env.KB_TEST_S3_BUCKET ?? 'kb-local',
    KB_S3_ACCESS_KEY_REF: 'env:KB_B12_REAL_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_B12_REAL_S3_SECRET',
    KB_B12_REAL_S3_ACCESS: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
    KB_B12_REAL_S3_SECRET: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
    API_KEY_HMAC_SECRET_FILE: join(root, 'test/fixtures/s10/api-key-hmac.secret'),
  });
  connections = await createKnowledgeConnections(config);
  connection = connections.mongo;
  pool = connections.pg;
  await ensureKnowledgeCollections(connection);
  await ensurePgvectorDdl(pool);
  const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-local',
  });
}, 60_000);

afterAll(async () => {
  for (const key of createdObjectKeys) {
    await objectStore?.deleteObject(key, context).catch(() => ({ deleted: false }));
  }
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
  }
  if (connections) {
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
    await connections.close();
  }
});

describe('TEST-X-IMAGE-CAPTION / L1-B12-MULTI-001-P01 real provider', () => {
  it('captions PNG and JPEG fixtures, persists 1024 vectors and recalls the correct image identities', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await models.KnowledgeSpace.create({
      workspaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'space',
      parentSpaceId: null,
      name: `B12 real ${suffix}`,
      normalizedName: `b12-real-${suffix}`,
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
    const spaceId = String(space._id);
    const vlmModelId = requiredProviderEnv('S11_AIPROXY_VLM_MODEL');
    const embeddingModelId = requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL');
    await models.KnowledgeModelBinding.create([
      {
        workspaceId,
        knowledgeSpaceId: space._id,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        modelType: 'vlm',
        modelId: vlmModelId,
        displayName: 'TokenDance VLM',
        requiredCapabilities: ['vision'],
        status: 'active',
        authorizedAt: new Date(),
      },
      {
        workspaceId,
        knowledgeSpaceId: space._id,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        modelType: 'embedding',
        modelId: embeddingModelId,
        displayName: 'TokenDance caption embedding',
        requiredCapabilities: ['caption-embedding', 'dimension:1024'],
        status: 'active',
        authorizedAt: new Date(),
      },
    ]);

    await objectStore.ensureBucket({
      workspaceId,
      knowledgeSpaceId: spaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });

    const config = loadS5AiproxyConfig(process.env);
    const transport = new AxiosS5HttpTransport();
    const catalog = new S5AiproxyCatalogAdapter({
      config,
      transport,
      env: process.env,
    });
    const gateway = new S5AiproxyHttpAdapter({
      baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport,
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const vlmResponseShapes: Array<Record<string, unknown>> = [];
    const gatewayPort = {
      async invoke<T>(
        request: Parameters<typeof gateway.invoke>[0],
        requestContext: TenantContext,
      ) {
        const result = await gateway.invoke(request, requestContext);
        if (request.kind === 'vlm') {
          const content = (
            result.data as {
              choices?: Array<{ message?: { content?: unknown } }>;
            }
          ).choices?.[0]?.message?.content;
          const text = typeof content === 'string' ? content.trim() : '';
          vlmResponseShapes.push({
            contentLength: text.length,
            startsWithJsonObject: text.startsWith('{'),
            endsWithJsonObject: text.endsWith('}'),
            hasMarkdownFence: text.startsWith('```') || text.includes('```json'),
          });
        }
        return result as T;
      },
    };
    const vectorRepository = new KnowledgeVectorRepository(pool);
    const indexes = new S8ImageIndexRepository(connection);
    const imageDataUrls = new Map<string, string>();
    const application = new S8CaptionApplication({
      store: new S6ProcessingRepository(connection),
      objects: new KnowledgeObjectRefRepository(connection),
      models: new S8ModelResolver(connection, catalog),
      gateway: gatewayPort,
      tickets: {
        issueImage(input) {
          return {
            url: imageDataUrls.get(input.blobId) ?? '',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          };
        },
      },
      vectors: vectorRepository,
      fulltext: new KnowledgeFullTextRepository(connection),
      indexes,
    });

    const evidence: Array<Record<string, unknown>> = [];
    for (const [order, image] of imageCases.entries()) {
      const bytes = fixtureBytes(image);
      const source = await models.KnowledgeSource.create({
        workspaceId,
        knowledgeSpaceId: space._id,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        kind: 'image',
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: bytes.byteLength,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
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
      const sourceId = String(source._id);
      const blobId = new connection.base.Types.ObjectId().toString();
      const objectKey = `ws/${workspaceId}/space/${spaceId}/source/${sourceId}/${image.name}`;
      createdObjectKeys.add(objectKey);
      await objectStore.putObject(
        {
          key: objectKey,
          body: bytes,
          sizeBytes: bytes.byteLength,
          contentType: image.mimeType,
          workspaceId,
          knowledgeSpaceId: spaceId,
        },
        {
          workspaceId,
          knowledgeSpaceId: spaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        },
      );
      await models.KnowledgeObjectRef.create({
        _id: new connection.base.Types.ObjectId(blobId),
        workspaceId,
        knowledgeSpaceId: space._id,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        provider: 'minio',
        bucket: objectStore.bucket,
        objectKey,
        purpose: 'image',
        sourceId: source._id,
        mimeType: image.mimeType,
        sizeBytes: bytes.byteLength,
        etag: `b12-real-${order}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        state: 'active',
        expiresAt: null,
        upload: {
          mode: 'single',
          status: 'completed',
          providerUploadId: null,
          pendingObjectKey: null,
          finalObjectKey: objectKey,
          finalizedAt: new Date(),
          pendingUrlExpiresAt: null,
          partSizeBytes: bytes.byteLength,
          partCount: 1,
          parts: [],
          originalName: image.name,
          completedAt: new Date(),
          abortedAt: null,
        },
      });
      imageDataUrls.set(blobId, dataUrl(image));
      await models.KnowledgeSource.updateOne({ _id: source._id }, { $inc: { version: 1 } });
      const job = await models.KnowledgeJob.create({
        workspaceId,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        kind: 'caption',
        resourceType: 'source',
        resourceId: sourceId,
        status: 'queued',
        priority: 0,
        idempotencyKey: `b12-real-caption-${suffix}-${order}`,
        inputSnapshot: {
          sourceId,
          sourceVersion: 1,
          imageBlobRefId: blobId,
        },
        progress: {},
        attempts: 0,
        maxAttempts: 3,
        attemptEpoch: 0,
        fencingToken: `fence-${suffix}-${order}`,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: new Date(),
        cancelRequestedAt: null,
        pausedAt: null,
        error: null,
        result: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      let result;
      try {
        result = await application.execute(job.toObject(), context);
      } catch (error) {
        writeProviderEvidence('b12-image-caption-real.json', {
          provider: 'aiproxy',
          status: 'FAIL',
          endpointHostHash: safeHostHash(requiredProviderEnv('AIPROXY_BASE_URL')),
          models: {
            vlm: vlmModelId,
            visionEmbedding: embeddingModelId,
            mode: 'caption-embedding',
            dimension: 1024,
          },
          image: image.name,
          vlmResponseShapes,
          errorCode:
            typeof error === 'object' &&
            error !== null &&
            'problem' in error &&
            typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code ===
              'string'
              ? String((error as { problem: { error: { code: string } } }).problem.error.code)
              : 'UNKNOWN',
          blockers: ['provider caption output did not satisfy the production caption contract'],
        });
        throw error;
      }
      expect(result).toMatchObject({
        result: {
          captionStatus: 'indexed',
          vectorStatus: 'indexed',
          captionPromptVersion: 's8.image-caption.v1',
          visionEmbeddingModelId: embeddingModelId,
          visionEmbeddingMode: 'caption-embedding',
          sourceVersion: 1,
        },
      });
      const segment = await models.KnowledgeSegment.findOne({ workspaceId, sourceId }).lean();
      expect(segment?.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            indexId: 'image_caption',
            modelId: embeddingModelId,
            dimension: 1024,
            storageType: 'vector',
            vectorProfile: 'knowledge_segment_vectors_1024',
          }),
        ]),
      );
      const vectorRow = await pool.query<{
        vector_id: string;
        index_id: string;
        dimension: number;
      }>(
        `SELECT id::text AS vector_id, index_id, vector_dims(embedding) AS dimension
           FROM knowledge_segment_vectors_1024
          WHERE workspace_id = $1 AND source_id = $2 AND index_id = 'image_caption'`,
        [workspaceId, sourceId],
      );
      expect(vectorRow.rows).toEqual([
        {
          vector_id: expect.any(String),
          index_id: 'image_caption',
          dimension: 1024,
        },
      ]);

      const queryEmbedding = await gateway.invoke(
        {
          kind: 'embedding',
          modelId: embeddingModelId,
          input: [
            {
              type: 'text',
              text: String(segment?.imageDescription ?? ''),
            },
          ],
          dimension: 1024,
        },
        context,
      );
      const queryVector = queryEmbedding.data.data[0]?.embedding;
      expect(queryVector).toHaveLength(1024);
      const recall = await vectorRepository.recall(
        {
          workspaceId,
          knowledgeSpaceId: spaceId,
          sourceIds: [sourceId],
          dimension: 1024,
          embeddingModelId,
          vector: queryVector!,
          limit: 5,
        },
        context,
      );
      expect(recall).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId,
            segmentId: String(segment?._id),
            indexId: 'image_caption',
          }),
        ]),
      );
      evidence.push({
        fixture: image.name,
        fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
        sourceId,
        segmentId: String(segment?._id),
        captionSha256: createHash('sha256')
          .update(String(segment?.imageDescription ?? ''))
          .digest('hex'),
        captionLength: String(segment?.imageDescription ?? '').length,
        vectorId: vectorRow.rows[0]?.vector_id,
        vectorProfile: 'knowledge_segment_vectors_1024',
        vectorDimension: 1024,
        recallTopSegmentId: recall[0]?.segmentId,
        usage: result.result.usage,
        queryEmbeddingUsage: queryEmbedding.usage,
      });
    }

    writeProviderEvidence('b12-image-caption-real.json', {
      provider: 'aiproxy',
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(requiredProviderEnv('AIPROXY_BASE_URL')),
      models: {
        vlm: vlmModelId,
        visionEmbedding: embeddingModelId,
        mode: 'caption-embedding',
        dimension: 1024,
      },
      objectStorage: {
        provider: 'minio',
        objectCount: createdObjectKeys.size,
        providerImageTransfer: 'data-url-boundary',
      },
      images: evidence,
      blockers: [],
    });

    const evidencePath = join(
      requiredProviderEnv('S11_EVIDENCE_DIR'),
      'b12-image-caption-real.json',
    );
    expect(readFileSync(evidencePath, 'utf8')).toContain('"status": "REAL_VERIFIED"');
  }, 120_000);

  it('TEST-X-IMAGE-CAPTION / L1-B12-SEARCH-006-Q01 writes and recalls a real 1024-dimensional provider vector', async () => {
    const config = loadS5AiproxyConfig(process.env);
    const transport = new AxiosS5HttpTransport();
    const gateway = new S5AiproxyHttpAdapter({
      baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport,
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const modelId = requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL');
    const embedding = await gateway.invoke(
      {
        kind: 'embedding',
        modelId,
        input: [
          {
            type: 'text',
            text: 'A synthetic refund flow image for B12 retrieval verification.',
          },
        ],
        dimension: 1024,
      },
      context,
    );
    const vector = embedding.data.data[0]?.embedding;
    expect(vector).toHaveLength(1024);
    const vectorRepository = new KnowledgeVectorRepository(pool);
    const knowledgeSpaceId = new connection.base.Types.ObjectId().toString();
    const sourceId = new connection.base.Types.ObjectId().toString();
    const segmentId = new connection.base.Types.ObjectId().toString();
    const inserted = await vectorRepository.insert(
      [
        {
          workspaceId,
          knowledgeSpaceId,
          sourceId,
          segmentId,
          indexId: 'image_caption',
          embeddingModelId: modelId,
          dimension: 1024,
          vector: vector!,
          searchEnabled: true,
          contentHash: createHash('sha256')
            .update('A synthetic refund flow image for B12 retrieval verification.')
            .digest('hex'),
          version: 1,
        },
      ],
      context,
    );
    const recall = await vectorRepository.recall(
      {
        workspaceId,
        knowledgeSpaceId,
        sourceIds: [sourceId],
        dimension: 1024,
        embeddingModelId: modelId,
        vector: vector!,
        limit: 5,
      },
      context,
    );
    expect(recall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segmentId,
          sourceId,
          vectorId: inserted.vectorIds[0],
          indexId: 'image_caption',
        }),
      ]),
    );
    writeProviderEvidence('b12-image-embedding-real.json', {
      provider: 'aiproxy',
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(requiredProviderEnv('AIPROXY_BASE_URL')),
      modelId,
      mode: 'caption-embedding',
      dimension: 1024,
      vectorProfile: 'knowledge_segment_vectors_1024',
      vectorId: inserted.vectorIds[0],
      recallTopSegmentId: recall[0]?.segmentId,
      usage: embedding.usage,
      blockers: [],
    });
  }, 120_000);
});
