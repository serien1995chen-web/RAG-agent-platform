import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createImageJobHandler,
  whitelistImagePayload,
} from '../../src/modules/processing/jobs/image.handler';
import {
  ImageApplicationService,
  normalizeImageMode,
} from '../../src/modules/item/application/image.service';
import {
  MongoImageAssetRepository,
  DEFAULT_IMAGE_TTL_MS,
} from '../../src/modules/item/repository/mongo-image-asset.repository';
import type {
  FullTextStore,
  ImageTrainingProcessorPort,
  VectorController,
} from '../../src/ports/capabilities';
import type { KnowledgeItemRepository } from '../../src/ports/repositories';
import type { RequestContext } from '../../src/ports/types';

const teamA = String(new mongoose.Types.ObjectId());
const teamB = String(new mongoose.Types.ObjectId());
const datasetId = String(new mongoose.Types.ObjectId());
const collectionId = String(new mongoose.Types.ObjectId());

function ctx(teamId: string): RequestContext {
  return {
    requestId: 'req-image',
    tenant: {
      teamId,
      tmbId: String(new mongoose.Types.ObjectId()),
      authType: 'internal',
      isRoot: false,
    },
    permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
  };
}

let mongo: MongoMemoryReplSet;
let connection: mongoose.Connection;
let assets: MongoImageAssetRepository;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(mongo.getUri(), { dbName: 'image-test' });
  await connection.asPromise();
  assets = new MongoImageAssetRepository(connection);
}, 60_000);

afterAll(async () => {
  if (connection) await connection.close();
  if (mongo) await mongo.stop();
});

describe('TEST-IMAGE-DESC-001 image asset TTL lifecycle', () => {
  it('creates a temporary asset with a 7-day TTL and a TTL record', async () => {
    const created = await assets.createTemporary(
      {
        imageId: 'img-1',
        datasetId,
        collectionId,
        objectKey: 'team/img-1.png',
        bucketName: 'kb-images',
        mimeType: 'image/png',
        size: 1024,
        operationId: 'op-1',
      },
      ctx(teamA),
    );
    expect(created.state).toBe('temporary');
    expect(created.persistent).toBe(false);
    expect(created.ttlExpireAt).not.toBeNull();
    expect((created.ttlExpireAt as Date).getTime() - Date.now()).toBeGreaterThan(
      DEFAULT_IMAGE_TTL_MS - 60000,
    );
    expect(
      await connection.models.S3TtlRecord.countDocuments({ objectKey: 'team/img-1.png' }),
    ).toBe(1);
  });

  it('is idempotent by (teamId, imageId)', async () => {
    await assets.createTemporary(
      {
        imageId: 'img-1',
        datasetId,
        collectionId,
        objectKey: 'team/img-1.png',
        bucketName: 'kb-images',
        mimeType: 'image/png',
        size: 1024,
        operationId: 'op-2',
      },
      ctx(teamA),
    );
    expect(await connection.models.ImageAsset.countDocuments({ imageId: 'img-1' })).toBe(1);
  });

  it('promotes to referenced and removes the TTL record', async () => {
    const promoted = await assets.promoteToReferenced('img-1', collectionId, ctx(teamA));
    expect(promoted?.state).toBe('referenced');
    expect(promoted?.persistent).toBe(true);
    expect(promoted?.ttlExpireAt).toBeNull();
    expect(
      await connection.models.S3TtlRecord.countDocuments({ objectKey: 'team/img-1.png' }),
    ).toBe(0);
  });

  it('enforces tenant scope', async () => {
    expect(await assets.findById('img-1', ctx(teamB))).toBeNull();
  });

  it('purges idempotently and keeps failure visible', async () => {
    await assets.markFailed('img-1', 'boom', ctx(teamA));
    expect((await assets.findById('img-1', ctx(teamA)))?.state).toBe('failed');
    expect((await assets.purge('img-1', ctx(teamA))).deleted).toBe(true);
    expect((await assets.findById('img-1', ctx(teamA)))?.state).toBe('deleted');
    await assets.purge('img-1', ctx(teamA));
    expect((await assets.findById('img-1', ctx(teamA)))?.state).toBe('deleted');
  });
});

function itemsFake(events: string[]): KnowledgeItemRepository {
  return {
    bulkUpsert: async () => {
      events.push('data');
      return { upserted: 1, duplicates: 0 };
    },
    updateIndexes: async () => ({ version: 2 }),
    deleteByScope: async () => ({ deleted: 0 }),
  } as unknown as KnowledgeItemRepository;
}
function vectorsFake(events: string[]): VectorController {
  return {
    insert: async () => {
      events.push('vector');
      return { inserted: 1 };
    },
    delete: async () => ({ deleted: 0 }),
    embRecall: async () => [],
    getVectorDataByTime: async () => [],
    getVectorCount: async () => 0,
  } as unknown as VectorController;
}
function fullTextFake(events: string[]): FullTextStore {
  return {
    write: async () => {
      events.push('fulltext');
    },
    search: async () => [],
    deleteByDataId: async () => ({ deleted: 0 }),
    deleteByDatasetIds: async () => ({ deleted: 0 }),
    deleteByCollectionIds: async () => ({ deleted: 0 }),
  } as unknown as FullTextStore;
}

const options = { timeoutMs: 5000 };

describe('TEST-IMAGE-AUTO-001 image pipeline and handler', () => {
  it('rewrites auto to chunk + autoIndexes', () => {
    const rewritten = normalizeImageMode('auto');
    expect(rewritten.mode).toBe('chunk');
    expect(rewritten.autoIndexes).toBe(true);
    expect(normalizeImageMode('image').mode).toBe('image');
  });

  it('writes vector, data and removes TTL on success', async () => {
    const events: string[] = [];
    const service = new ImageApplicationService({
      assets,
      items: itemsFake(events),
      vectors: vectorsFake(events),
      fullText: fullTextFake(events),
      processor: {
        processImage: async (task) => ({
          imageId: task.payload.imageRef.key,
          state: 'success',
          description: 'desc',
        }),
      },
    });
    await service.createImage(
      {
        imageId: 'img-2',
        datasetId,
        collectionId,
        dataId: 'data-2',
        bucketName: 'kb-images',
        objectKey: 'team/img-2.png',
        mimeType: 'image/png',
        size: 10,
        mode: 'image',
        vector: [0.5],
        options,
      },
      ctx(teamA),
    );
    expect(events).toEqual(['vector', 'data', 'fulltext']);
    expect((await assets.findById('img-2', ctx(teamA)))?.state).toBe('referenced');
  });

  it('keeps a single-image failure visible', async () => {
    const events: string[] = [];
    const service = new ImageApplicationService({
      assets,
      items: itemsFake(events),
      vectors: vectorsFake(events),
      fullText: fullTextFake(events),
      processor: {
        processImage: async () => ({ imageId: 'img-3', state: 'failed', errorMsg: 'vlm_down' }),
      },
    });
    const result = await service.createImage(
      {
        imageId: 'img-3',
        datasetId,
        collectionId,
        dataId: 'data-3',
        bucketName: 'kb-images',
        objectKey: 'team/img-3.png',
        mimeType: 'image/png',
        size: 10,
        mode: 'imageParse',
        options,
      },
      ctx(teamA),
    );
    expect(result.state).toBe('failed');
    expect(result.errorMsg).toBe('vlm_down');
    expect((await assets.findById('img-3', ctx(teamA)))?.state).toBe('failed');
    expect(events).toHaveLength(0);
  });

  it('dispatches image/imageParse and drops unknown payload fields (TEST-E2E-IMAGE-001)', async () => {
    const seen: string[] = [];
    const processor: ImageTrainingProcessorPort = {
      processImage: async (task) => {
        seen.push(task.mode);
        return { imageId: task.payload.imageRef.key, state: 'success', description: 'ok' };
      },
    };
    const handler = createImageJobHandler({ processor });
    const base = {
      jobId: 'job-1',
      teamId: teamA,
      datasetId,
      collectionId,
      dataId: 'data-1',
      retryCount: 0,
      lockTime: null,
      payload: { imageRef: { bucket: 'kb-images', key: 'k' }, secret: 'leak' },
    };
    const a = await handler.handle(
      { ...base, queue: 'dataset-image', mode: 'image' } as never,
      ctx(teamA),
    );
    const b = await handler.handle(
      { ...base, queue: 'dataset-image-parse', mode: 'imageParse' } as never,
      ctx(teamA),
    );
    expect(a.state).toBe('success');
    expect(b.state).toBe('success');
    expect(seen).toEqual(['image', 'imageParse']);
    expect(whitelistImagePayload({ imageRef: {}, secret: 'x' })).not.toHaveProperty('secret');
  });
});


describe('TEST-IMAGE-AUTO-001 (RK-08a) embedding, index type, imageDescMap, stable operationId, idempotency', () => {
  interface RecordedAsset {
    imageId: string;
    teamId: string;
    datasetId: string;
    collectionId: string | null;
    objectKey: string;
    mimeType: string;
    size: number;
    ttlExpireAt: Date | null;
    persistent: boolean;
    state: 'temporary' | 'referenced' | 'deleting' | 'deleted' | 'failed';
  }

  function makeHarness() {
    const ops: string[] = [];
    const vectorCalls: Array<{ records: Array<{ indexId: string; vector: number[] }> }> = [];
    const itemCalls: Array<{ dataId: string; metadata?: unknown; indexes: Array<{ type: string }> }> = [];
    const base = (imageId: string): RecordedAsset => ({
      imageId,
      teamId: teamA,
      datasetId,
      collectionId,
      objectKey: 'team/x.png',
      mimeType: 'image/png',
      size: 10,
      ttlExpireAt: new Date(Date.now() + DEFAULT_IMAGE_TTL_MS),
      persistent: false,
      state: 'temporary',
    });
    const assets = {
      createTemporary: async (input: { imageId: string; operationId: string }) => {
        ops.push(input.operationId);
        return base(input.imageId);
      },
      findById: async () => null,
      promoteToReferenced: async (imageId: string) => ({
        ...base(imageId),
        state: 'referenced' as const,
        persistent: true,
        ttlExpireAt: null,
      }),
      markFailed: async () => undefined,
    };
    const items = {
      bulkUpsert: async (input: { items: Array<{ dataId: string; metadata?: unknown; indexes: Array<{ type: string }> }> }) => {
        itemCalls.push(input.items[0]!);
        return { upserted: 1, duplicates: 0 };
      },
    } as unknown as KnowledgeItemRepository;
    const vectors = {
      insert: async (input: { records: Array<{ indexId: string; vector: number[] }> }) => {
        vectorCalls.push({ records: input.records });
        return { inserted: 1 };
      },
    } as unknown as VectorController;
    const fullText = { write: async () => undefined } as unknown as FullTextStore;
    return { ops, vectorCalls, itemCalls, assets, items, vectors, fullText };
  }

  const baseProcessor = (embedding?: number[]): ImageTrainingProcessorPort => ({
    processImage: async (task) => ({
      imageId: task.payload.imageRef.key,
      state: 'success',
      description: '图像描述',
      ...(embedding ? { embedding } : {}),
    }),
  } as unknown as ImageTrainingProcessorPort);

  it('persists the processor embedding as an imageEmbedding vector with imageDescMap', async () => {
    const h = makeHarness();
    const service = new ImageApplicationService({
      assets: h.assets as never,
      items: h.items,
      vectors: h.vectors,
      fullText: h.fullText,
      processor: baseProcessor([0.11, 0.22, 0.33]),
    });
    await service.createImage(
      {
        imageId: 'img-e',
        datasetId,
        collectionId,
        dataId: 'data-e',
        bucketName: 'kb-images',
        objectKey: 'team/img-e.png',
        mimeType: 'image/png',
        size: 10,
        mode: 'image',
        options: { timeoutMs: 5000 },
      },
      ctx(teamA),
    );
    expect(h.vectorCalls[0]?.records[0]?.vector).toEqual([0.11, 0.22, 0.33]);
    expect(h.vectorCalls[0]?.records[0]?.indexId).toBe('data-e:imageEmbedding');
    const item = h.itemCalls[0];
    expect(item?.indexes.map((index) => index.type)).toEqual(['image', 'imageEmbedding']);
    expect((item?.metadata as { imageDescMap?: { image?: string } })?.imageDescMap?.image).toBe('图像描述');
  });

  it('uses a stable operationId derived from buildImageJobId (no process-local counter)', async () => {
    const h = makeHarness();
    const service = new ImageApplicationService({
      assets: h.assets as never,
      items: h.items,
      vectors: h.vectors,
      fullText: h.fullText,
      processor: baseProcessor(),
    });
    const input = {
      imageId: 'img-op',
      datasetId,
      collectionId,
      dataId: 'data-op',
      bucketName: 'kb-images',
      objectKey: 'team/img-op.png',
      mimeType: 'image/png',
      size: 10,
      mode: 'image' as const,
      options: { timeoutMs: 5000 },
    };
    await service.createImage(input, ctx(teamA));
    await service.createImage(input, ctx(teamA));
    expect(h.ops).toHaveLength(2);
    expect(h.ops[0]).toBe(h.ops[1]);
    expect(h.ops[0]).toBe(teamA + ':' + datasetId + ':img-op:image');
  });

  it('is idempotent for the same image/mode: repeated processing reuses one Data id', async () => {
    const h = makeHarness();
    const service = new ImageApplicationService({
      assets: h.assets as never,
      items: h.items,
      vectors: h.vectors,
      fullText: h.fullText,
      processor: baseProcessor([0.5]),
    });
    const input = {
      imageId: 'img-idem',
      datasetId,
      collectionId,
      dataId: 'data-idem',
      bucketName: 'kb-images',
      objectKey: 'team/img-idem.png',
      mimeType: 'image/png',
      size: 10,
      mode: 'imageParse' as const,
      options: { timeoutMs: 5000 },
    };
    await service.createImage(input, ctx(teamA));
    await service.createImage(input, ctx(teamA));
    const distinctDataIds = new Set(h.itemCalls.map((entry) => entry.dataId));
    expect(distinctDataIds.size).toBe(1);
  });
});
