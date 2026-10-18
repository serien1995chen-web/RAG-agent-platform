import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioObjectStore, type TenantObjectContext } from '../../../../sdk/storage/src/index';
import { createMockImageCapability } from '../../src/modules/collection/adapter/image-capability.mock';
import { createImageProcessorAdapter } from '../../src/modules/collection/adapter/image-processor.adapter';
import { ImageApplicationService } from '../../src/modules/item/application/image.service';
import { MongoImageAssetRepository } from '../../src/modules/item/repository/mongo-image-asset.repository';
import { createKnowledgeItemRepository } from '../../src/modules/item/repository/index';
import { createFullTextStoreAdapter } from '../../src/modules/index/adapter/full-text-store.adapter';
import { PgVectorRepository } from '../../src/shared/persistence/pgvector';
import { MongoKnowledgeBaseRepository } from '../../src/modules/knowledge-base/repository/mongo-knowledge-base.repository';
import { createSourceCollectionRepository } from '../../src/modules/collection/repository/index';
import type { ObjectStorePort, RequestContext } from '../../src/ports';

const mongoUri =
  process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27019/kb_image_e2e?directConnection=true';
const pgUrl = process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_demo_password@127.0.0.1:5434/kb';
const bucket = process.env.KB_S3_BUCKET ?? 'kb-demo';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC',
  'base64',
);

const teamId = String(new mongoose.Types.ObjectId());
const tmbId = String(new mongoose.Types.ObjectId());
const context: RequestContext = {
  requestId: 'req-image-collection-e2e',
  tenant: { teamId, tmbId, authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

let connection: mongoose.Connection;
let pool: Pool;
let store: MinioObjectStore;
let assets: MongoImageAssetRepository;
let service: ImageApplicationService;
let datasetId = '';
let collectionId = '';
let datasetIndexVersion = '';
const tenantContext: TenantObjectContext = { teamId };

async function upload(key: string, body: Buffer): Promise<{ bucket: string; key: string }> {
  const ref = { bucket, key };
  const prepared = await store.prepareMultipart({ ref, parts: 1 }, { ...tenantContext, datasetId });
  if (!prepared.multipartUploadId) throw new Error('missing uploadId');
  const part = await store.uploadPart(
    {
      ref,
      uploadId: prepared.multipartUploadId,
      partNumber: 1,
      body,
      checksum: createHash('sha256').update(body).digest('hex'),
    },
    { ...tenantContext, datasetId },
  );
  const hash = `${createHash('md5').update(Buffer.from(part.etag, 'hex')).digest('hex')}-1`;
  const completed = await store.completeMultipart(
    {
      ref,
      uploadId: prepared.multipartUploadId,
      parts: [{ partNumber: 1, etag: part.etag, size: body.length }],
      hash,
    },
    { ...tenantContext, datasetId },
  );
  return { bucket: completed.bucket, key: completed.key };
}

beforeAll(async () => {
  connection = mongoose.createConnection(mongoUri);
  await connection.asPromise();
  pool = new Pool({ connectionString: pgUrl, max: 4 });
  store = new MinioObjectStore({
    endPoint: '127.0.0.1',
    port: 9004,
    useSSL: false,
    accessKey: process.env.MINIO_ROOT_USER ?? 'kb_demo_minio',
    secretKey: process.env.MINIO_ROOT_PASSWORD ?? 'kb_demo_minio_password',
    region: 'us-east-1',
    bucket,
  });
  const bases = await new MongoKnowledgeBaseRepository(connection).create(
    {
      dataset: {
        teamId,
        parentId: null,
        type: 'knowledge',
        name: `[TEST] image-e2e-${Date.now()}`,
        vectorModel: 'bge-m3',
        inheritPermission: true,
        autoSync: false,
      },
      options: { timeoutMs: 10_000 },
    },
    context,
  );
  datasetId = bases.datasetId;
  const detail = await new MongoKnowledgeBaseRepository(connection).findByDatasetId(
    { datasetId },
    context,
  );
  datasetIndexVersion = detail?.indexVersion ?? '';
  const collection = await createSourceCollectionRepository(connection).create(
    {
      collection: {
        teamId,
        datasetId,
        parentId: null,
        type: 'image',
        name: 'images',
        tagIds: [],
        trainingMode: 'chunk',
        autoIndexes: true,
      },
      options: { timeoutMs: 10_000 },
    },
    context,
  );
  collectionId = collection.collectionId;
  assets = new MongoImageAssetRepository(connection);
  const objectStorePort = {
    get: async (input: { ref: { bucket: string; key: string }; datasetId?: string }) =>
      store.get({ ref: input.ref }, { teamId, datasetId: input.datasetId }),
  } as unknown as ObjectStorePort;
  service = new ImageApplicationService({
    assets,
    items: createKnowledgeItemRepository(connection),
    vectors: new PgVectorRepository(pool),
    fullText: createFullTextStoreAdapter(connection),
    processor: createImageProcessorAdapter({
      capability: createMockImageCapability({ objectStore: objectStorePort }),
      configured: true,
      mock: true,
      environment: 'development',
    }),
  });
}, 60_000);

afterAll(async () => {
  if (connection && datasetId) {
    const oid = new mongoose.Types.ObjectId(datasetId);
    await Promise.all([
      connection.models.ImageAsset.deleteMany({ datasetId: oid }),
      connection.models.S3TtlRecord.deleteMany({ teamId: new mongoose.Types.ObjectId(teamId) }),
      connection.models.DatasetData.deleteMany({ datasetId: oid }),
      connection.models.DatasetCollection.deleteMany({ datasetId: oid }),
      connection.models.Dataset.deleteOne({ _id: oid }),
    ]);
    await pool.query('DELETE FROM modeldata WHERE dataset_id = $1', [datasetId]);
  }
  await pool?.end().catch(() => undefined);
  await connection?.close().catch(() => undefined);
});

describe('image collection real-store E2E (Mongo + pgvector + MinIO, model=mock)', () => {
  it('writes referenced asset, Data, and versioned vector; repeats are idempotent', async () => {
    const ref = await upload(
      `dataset/${datasetId}/uploads/${new mongoose.Types.ObjectId().toHexString()}.png`,
      png,
    );
    const imageId = new mongoose.Types.ObjectId().toHexString();
    const input = {
      imageId,
      datasetId,
      collectionId,
      dataId: imageId,
      bucketName: ref.bucket,
      objectKey: ref.key,
      mimeType: 'image/png',
      size: png.length,
      mode: 'chunk' as const,
      indexVersion: datasetIndexVersion,
      options: { timeoutMs: 30_000 },
    };
    const first = await service.createImage(input, context);
    expect(first.state).toBe('success');
    const second = await service.createImage(input, context);
    expect(second.state).toBe('success');

    const asset = await connection.models.ImageAsset.findOne({
      teamId: new mongoose.Types.ObjectId(teamId),
      imageId,
    }).lean();
    expect(asset).toMatchObject({ state: 'referenced', persistent: true, ttlExpireAt: null });
    const data = await connection.models.DatasetData.find({
      datasetId: new mongoose.Types.ObjectId(datasetId),
    }).lean();
    expect(data).toHaveLength(1);
    expect(data[0]?.imageId).toBe(imageId);
    expect((data[0]?.indexes as { type: string }[]).map((index) => index.type)).toEqual([
      'image',
      'imageEmbedding',
    ]);
    const vectors = await pool.query(
      'SELECT index_version, vector_dims(vector) AS dims FROM modeldata WHERE dataset_id = $1',
      [datasetId],
    );
    expect(vectors.rowCount).toBe(1);
    expect(vectors.rows[0]?.index_version).toBe(datasetIndexVersion);
    expect(Number(vectors.rows[0]?.dims)).toBe(1536);
    await store.delete({ ref }, { ...tenantContext, datasetId });
  }, 60_000);

  it('rejects non-image bytes without leaving referenced asset or Data', async () => {
    const ref = await upload(
      `dataset/${datasetId}/uploads/${new mongoose.Types.ObjectId().toHexString()}.txt`,
      Buffer.from('not an image'),
    );
    const imageId = new mongoose.Types.ObjectId().toHexString();
    const result = await service.createImage(
      {
        imageId,
        datasetId,
        collectionId,
        dataId: imageId,
        bucketName: ref.bucket,
        objectKey: ref.key,
        mimeType: 'text/plain',
        size: 12,
        mode: 'chunk',
        indexVersion: datasetIndexVersion,
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    expect(result.state).toBe('failed');
    const asset = await connection.models.ImageAsset.findOne({ imageId }).lean();
    expect(asset?.state).toBe('failed');
    expect(await connection.models.DatasetData.countDocuments({ imageId })).toBe(0);
    await store.delete({ ref }, { ...tenantContext, datasetId });
  }, 60_000);
});
