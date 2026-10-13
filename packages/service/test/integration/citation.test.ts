import { CitationSchema } from '@kb/contracts';
import type { SearchRequest, SearchResult } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CitationService,
  type ResolvedCitationInput,
} from '../../src/modules/index/application/citation.service';
import { createDatasetSearchPort } from '../../src/modules/index/adapter/dataset-search.adapter';
import {
  DEFAULT_PREVIEW_TTL_SECONDS,
  PREVIEW_URL_MAX_TTL_SECONDS,
} from '../../src/modules/index/domain/citation';
import type { ObjectRef, RequestContext } from '../../src/ports/types';
import { registerMongoModels } from '../../src/shared/persistence/schemas';
import type { CollectionRepository } from '../../src/ports/repositories';
import { createPreviewSigner, type PreviewSigner } from '../../../../sdk/storage/src/presign';

const teamId = new mongoose.Types.ObjectId().toHexString();
const context: RequestContext = {
  requestId: 'req-citation',
  tenant: { teamId, tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const baseItem: ResolvedCitationInput = {
  dataId: 'data-1',
  chunkIndex: 2,
  datasetId: 'dataset-1',
  collectionId: 'collection-1',
  collectionName: '来源集合',
  sourceName: '来源文件',
  sourceType: 'file',
  quoteText: '引用内容',
  updateTime: new Date('2026-10-13T00:00:00.000Z').toISOString(),
  scores: [{ type: 'embedding', value: 0.9, index: 0 }],
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let models: ReturnType<typeof registerMongoModels>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_citation_it'));
  await connection.asPromise();
  models = registerMongoModels(connection);
  await models.DatasetData.init();
  await models.DatasetCollection.init();
  await models.ImageAsset.init();
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

function forbiddenKeyPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenKeyPresent);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      ['imageId', 'objectKey', 'providerResponse', 'providerRaw', 'storageKey'].includes(key) ||
      forbiddenKeyPresent(child),
  );
}

describe('P5-05 citation service', () => {
  it('builds a complete masked Citation', async () => {
    const service = new CitationService({
      resolveImageRef: async () => null,
    });
    const citations = await service.build({ items: [baseItem], context });

    expect(citations).toHaveLength(1);
    expect(CitationSchema.safeParse(citations[0]).success).toBe(true);
    expect(citations[0]).toMatchObject({
      dataId: 'data-1',
      chunkIndex: 2,
      datasetId: 'dataset-1',
      collectionId: 'collection-1',
      collectionName: '来源集合',
      sourceName: '来源文件',
      sourceType: 'file',
      quoteText: '引用内容',
    });
  });

  it('does not expose internal image or provider fields', async () => {
    const service = new CitationService({
      resolveImageRef: async () => null,
    });
    const citations = await service.build({
      items: [{ ...baseItem, imageIds: ['img-1'] }],
      context,
    });
    expect(forbiddenKeyPresent(citations)).toBe(false);
    expect(JSON.stringify(citations)).not.toContain('objectKey');
    expect(JSON.stringify(citations)).not.toContain('providerResponse');
  });

  it('signs image previews last and only for final image count', async () => {
    let signCalls = 0;
    const service = new CitationService({
      resolveImageRef: async (imageId) => ({
        ref: { bucket: 'kb', key: `image/${teamId}/${imageId}` },
        datasetId: 'dataset-1',
      }),
      presignPreview: async () => {
        signCalls += 1;
        return `https://preview.test/${signCalls}`;
      },
    });
    const citations = await service.build({
      items: [{ ...baseItem, imageIds: ['img-1', 'img-2'] }],
      context,
    });
    expect(signCalls).toBe(2);
    expect(citations[0]?.imagePreviewUrls).toEqual([
      'https://preview.test/1',
      'https://preview.test/2',
    ]);
  });

  it('enforces preview expiry and tenant key scope', async () => {
    const signer = createPreviewSigner({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'test-key',
      secretKey: 'test-secret',
      region: 'us-east-1',
    });
    const ref: ObjectRef = { bucket: 'kb-test', key: `image/${teamId}/file.png` };

    expect(await signer(ref, { teamId }, 3600)).toContain('X-Amz-Expires=3600');
    expect(await signer(ref, { teamId }, 7200)).toContain('X-Amz-Expires=7200');
    await expect(signer(ref, { teamId }, 3599)).rejects.toMatchObject({
      error: { code: 501050 },
    });
    await expect(signer(ref, { teamId }, 7201)).rejects.toMatchObject({
      error: { code: 501050 },
    });
    await expect(
      signer(
        { bucket: 'kb-test', key: `temp/${new mongoose.Types.ObjectId().toHexString()}/x` },
        { teamId },
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    expect(DEFAULT_PREVIEW_TTL_SECONDS).toBe(3600);
    expect(PREVIEW_URL_MAX_TTL_SECONDS).toBe(7200);
  });

  it('keeps repeated builds stable apart from presigned URLs', async () => {
    let calls = 0;
    const signer: PreviewSigner = async () => {
      calls += 1;
      return `https://preview.test/${calls}`;
    };
    const service = new CitationService({
      resolveImageRef: async (imageId) => ({
        ref: { bucket: 'kb', key: `image/${teamId}/${imageId}` },
        datasetId: 'dataset-1',
      }),
      presignPreview: signer,
    });
    const first = await service.build({ items: [{ ...baseItem, imageIds: ['img-1'] }], context });
    const second = await service.build({ items: [{ ...baseItem, imageIds: ['img-1'] }], context });
    const normalize = (citations: typeof first) =>
      citations.map((citation) => ({ ...citation, imagePreviewUrls: ['<signed>'] }));
    expect(normalize(second)).toEqual(normalize(first));
  });

  it('keeps citationBuilder wired through createDatasetSearchPort', async () => {
    const datasetId = new mongoose.Types.ObjectId().toHexString();
    const collectionId = new mongoose.Types.ObjectId().toHexString();
    const dataId = new mongoose.Types.ObjectId().toHexString();
    const vectorId = `${dataId}:qa:bge-m3:1536:v1`;
    await models.DatasetData.create({
      _id: new mongoose.Types.ObjectId(dataId),
      teamId: new mongoose.Types.ObjectId(teamId),
      datasetId: new mongoose.Types.ObjectId(datasetId),
      collectionId: new mongoose.Types.ObjectId(collectionId),
      q: 'q',
      a: 'a',
      imageId: 'img-1',
      chunkIndex: 0,
      metadata: {},
      history: [],
      indexes: [{ type: 'default', dataId: vectorId, text: 'q a' }],
      dedupKey: null,
      rebuilding: false,
      createTime: new Date(),
      updateTime: new Date(),
    });

    let presignCalls = 0;
    const searchResult: SearchResult = {
      citations: [
        {
          dataId: vectorId,
          chunkIndex: 0,
          datasetId,
          collectionId,
          collectionName: 'pending',
          sourceName: 'pending',
          sourceType: 'virtual',
          quoteText: '',
          updateTime: new Date(0).toISOString(),
          scores: [],
        },
      ],
      stats: {
        searchMode: 'embedding',
        usingReRank: false,
        usingSimilarityFilter: false,
        embeddingTokens: 0,
        rerankInputTokens: 0,
        degraded: [],
        durationMs: 0,
      },
    };
    const engine = {
      search: async () => searchResult,
      searchBatch: async () => [searchResult],
    };
    const collections = {
      list: async () => ({
        total: 1,
        list: [
          {
            collectionId,
            teamId,
            datasetId,
            parentId: null,
            type: 'file',
            name: 'source.txt',
            tagIds: [],
            version: 1,
            createTime: new Date().toISOString(),
            updateTime: new Date().toISOString(),
          },
        ],
        cursor: null,
      }),
    } as unknown as CollectionRepository;
    const adapter = createDatasetSearchPort({
      engine,
      connection,
      collections,
      datasetIndexVersion: async () => 'bge-m3:1536:v1',
      citationBuilder: new CitationService({
        resolveImageRef: async () => ({
          ref: { bucket: 'kb-test', key: `image/${teamId}/img-1` },
          datasetId,
        }),
        presignPreview: async () => {
          presignCalls += 1;
          return `https://preview.test/${presignCalls}`;
        },
      }),
    });
    const request: SearchRequest = {
      requestId: 'req-port-citation',
      teamId,
      datasetIds: [datasetId],
      textQueries: ['q'],
      imageQueries: [],
      models: { embeddingModel: 'bge-m3' },
      searchMode: 'embedding',
      limit: 10,
      maxTokens: 4_000,
      similarity: 0,
    };

    const result = await adapter.search(request, context);
    expect(presignCalls).toBe(1);
    expect(result.citations[0]?.imagePreviewUrls).toEqual(['https://preview.test/1']);
  });
});
