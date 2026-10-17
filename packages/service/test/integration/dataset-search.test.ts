import type { SearchRequest } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchEngine, dedupeCandidates, rrfFuseWeighted } from '../../../search/src/index';
import {
  createDatasetSearchPort,
  createTextResolver,
} from '../../src/modules/index/adapter/dataset-search.adapter';
import { createFullTextStoreAdapter } from '../../src/modules/index/adapter/full-text-store.adapter';
import { createVectorControllerAdapter } from '../../src/modules/index/adapter/vector-controller.adapter';
import { MongoKnowledgeItemRepository } from '../../src/modules/item/repository/mongo-knowledge-item.repository';
import type { CollectionRepository } from '../../src/ports/repositories';
import type { FullTextStore, VectorController } from '../../src/ports/capabilities';
import type { KnowledgeItemSnapshot, PortCallOptions, RequestContext } from '../../src/ports/types';
import { ensurePgvectorDdl } from '../../src/shared/persistence/pgvector';
import { registerMongoModels } from '../../src/shared/persistence/schemas';

// ISSUE-010：未配置测试依赖地址即显式跳过，禁止静默回落。
const connectionString = process.env.KB_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const options: PortCallOptions = { timeoutMs: 5_000 };
const indexVersion = 'bge-m3:1536:v1';

function unitVector(position: number): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === position ? 1 : 0));
}

function contextFor(teamId: string, requestId: string): RequestContext {
  return {
    requestId,
    tenant: {
      teamId,
      tmbId: new Types.ObjectId().toHexString(),
      authType: 'token',
      isRoot: false,
    },
    permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
  };
}

function requestFor(
  teamId: string,
  datasetId: string,
  collectionId: string,
  overrides: Partial<SearchRequest> = {},
): SearchRequest {
  return {
    requestId: `req-${new Types.ObjectId().toHexString()}`,
    teamId,
    datasetIds: [datasetId],
    collectionIds: [collectionId],
    textQueries: ['alpha'],
    imageQueries: [],
    models: { embeddingModel: 'bge-m3' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 4_000,
    similarity: 0,
    ...overrides,
  };
}

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let pool: Pool;
let items: MongoKnowledgeItemRepository;
let rawVectors: VectorController;
let rawFullText: FullTextStore;
const vectorLimits: number[] = [];
const fullTextLimits: number[] = [];
const datasetIds: string[] = [];
const seededCollections: { datasetId: string; collectionId: string; teamId: string }[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_dataset_search_it'));
  await connection.asPromise();
  registerMongoModels(connection);
  await connection.models.DatasetData.init();
  await connection.models.DatasetDataText.init();

  pool = new Pool({ connectionString: connectionString ?? '', max: 4 });
  await ensurePgvectorDdl(pool);
  items = new MongoKnowledgeItemRepository(connection);
  rawVectors = createVectorControllerAdapter(pool);
  rawFullText = createFullTextStoreAdapter(connection);
}, 300_000);

afterAll(async () => {
  if (datasetIds.length > 0) {
    await pool.query('DELETE FROM modeldata WHERE dataset_id = ANY($1::text[])', [datasetIds]);
  }
  await connection.dropDatabase();
  await connection.close();
  await pool.end();
  await mongo.stop();
});

interface SeededDocument {
  teamId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;
  context: RequestContext;
}

async function seedDocument(
  teamId = new Types.ObjectId().toHexString(),
  vectorPosition = 0,
  text = 'alpha beta',
): Promise<SeededDocument> {
  const datasetId = new Types.ObjectId().toHexString();
  const collectionId = new Types.ObjectId().toHexString();
  const dataId = new Types.ObjectId().toHexString();
  const context = contextFor(teamId, `req-seed-${dataId}`);
  datasetIds.push(datasetId);
  seededCollections.push({ datasetId, collectionId, teamId });

  const item: KnowledgeItemSnapshot = {
    dataId,
    teamId,
    datasetId,
    collectionId,
    q: 'alpha',
    a: 'beta',
    indexes: [
      {
        indexId: `${dataId}:qa`,
        type: 'default',
        dataId: `${dataId}:qa:${indexVersion}`,
        text,
      },
    ],
    rebuilding: false,
    version: 1,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
  };
  await items.bulkUpsert({ items: [item], options }, context);
  await rawVectors.insert(
    {
      records: [
        {
          teamId,
          datasetId,
          collectionId,
          dataId: `${dataId}:qa:${indexVersion}`,
          indexId: `${dataId}:qa`,
          indexVersion,
          vector: unitVector(vectorPosition),
        },
      ],
      options,
    },
    context,
  );
  await rawFullText.write({ datasetId, collectionId, dataId, text, options }, context);
  return { teamId, datasetId, collectionId, dataId, context };
}

function createAdapter(
  overrides: {
    vectors?: VectorController;
    fullText?: FullTextStore;
    collections?: CollectionRepository;
    includeFullText?: boolean;
  } = {},
) {
  const vectors =
    overrides.vectors ??
    ({
      ...rawVectors,
      embRecall: async (input, context) => {
        vectorLimits.push(input.limit);
        return rawVectors.embRecall(input, context);
      },
    } as VectorController);
  const fullText =
    overrides.fullText ??
    ({
      ...rawFullText,
      search: async (input, context) => {
        fullTextLimits.push(input.limit);
        return rawFullText.search(input, context);
      },
    } as FullTextStore);
  const collections =
    overrides.collections ??
    ({
      list: async (input) => ({
        total: seededCollections.filter((item) => item.datasetId === input.datasetId).length,
        list: seededCollections
          .filter((item) => item.datasetId === input.datasetId)
          .map((item) => ({
            collectionId: item.collectionId,
            teamId: item.teamId,
            datasetId: item.datasetId,
            parentId: null,
            type: 'file',
            name: 'source.txt',
            tagIds: [],
            version: 1,
            createTime: new Date().toISOString(),
            updateTime: new Date().toISOString(),
          })),
        cursor: null,
      }),
    } as unknown as CollectionRepository);

  const engine = createSearchEngine({
    vectors,
    ...(overrides.includeFullText === false ? {} : { fullText }),
    embedding: {
      embed: async ({ texts }) =>
        texts.map((text) => (text.includes('beta') ? unitVector(1) : unitVector(0))),
    },
    resolveTexts: createTextResolver(connection),
  });
  return createDatasetSearchPort({
    engine,
    connection,
    collections,
    datasetIndexVersion: async () => indexVersion,
  });
}

describePg('P5-02 dataset search adapter', () => {
  it('returns embedding, full-text and mixed recall citations', async () => {
    const seeded = await seedDocument();
    const adapter = createAdapter();

    const embedding = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId),
      seeded.context,
    );
    expect(embedding.stats.degraded).toEqual([]);
    expect(embedding.citations.map((citation) => citation.dataId)).toContain(seeded.dataId);

    const fullText = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'fullTextRecall',
      }),
      seeded.context,
    );
    expect(fullText.citations.map((citation) => citation.dataId)).toContain(seeded.dataId);

    const mixed = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'mixedRecall',
      }),
      seeded.context,
    );
    expect(mixed.citations.map((citation) => citation.dataId)).toContain(seeded.dataId);

    const duplicateCandidates = [
      {
        docId: 'doc-a',
        itemId: 'item-a',
        collectionId: 'collection-a',
        score: 1,
        scores: [],
        text: 'same-answer',
      },
      {
        docId: 'doc-b',
        itemId: 'item-b',
        collectionId: 'collection-a',
        score: 1,
        scores: [],
        text: 'same-answer',
      },
    ];
    expect(dedupeCandidates(duplicateCandidates, (candidate) => candidate.text)).toHaveLength(1);
  });

  it('uses the frozen candidate counts for all modes', async () => {
    const seeded = await seedDocument();
    const adapter = createAdapter();
    vectorLimits.length = 0;
    fullTextLimits.length = 0;

    await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, { searchMode: 'embedding' }),
      seeded.context,
    );
    expect(vectorLimits).toContain(100);
    expect(fullTextLimits).toEqual([]);

    vectorLimits.length = 0;
    await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'fullTextRecall',
      }),
      seeded.context,
    );
    expect(vectorLimits).toEqual([]);
    expect(fullTextLimits).toContain(100);

    vectorLimits.length = 0;
    fullTextLimits.length = 0;
    await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'mixedRecall',
      }),
      seeded.context,
    );
    expect(vectorLimits).toContain(80);
    expect(fullTextLimits).toContain(60);
  });

  it('keeps the corrected RRF frozen expectations', () => {
    const first = rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]]);
    expect(first.get('a')?.rrf).toBe(1 / 61);

    const threeLists = rrfFuseWeighted([
      [{ id: 'a', rank: 1, weight: 1, type: 'embedding' }],
      [{ id: 'a', rank: 1, weight: 1, type: 'fullText' }],
      [{ id: 'a', rank: 1, weight: 1, type: 'image' }],
    ]);
    expect(threeLists.get('a')?.rrf).toBe(3 / 61);

    const rankThree = rrfFuseWeighted([[{ id: 'b', rank: 3, weight: 1, type: 'embedding' }]]);
    expect(rankThree.get('b')?.rrf).toBe(1 / 63);
  });

  it('keeps full-text results when the vector path fails', async () => {
    const seeded = await seedDocument();
    const failingVectors = {
      ...rawVectors,
      embRecall: async () => {
        throw new Error('vector_down');
      },
    } as VectorController;
    const adapter = createAdapter({ vectors: failingVectors });

    const result = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'mixedRecall',
      }),
      seeded.context,
    );
    expect(result.stats.degraded).toContainEqual({ stage: 'vector', reason: 'vector_down' });
    expect(result.citations.map((citation) => citation.dataId)).toContain(seeded.dataId);
  });

  it('keeps tenant recall isolated', async () => {
    const seeded = await seedDocument();
    const otherTeam = new Types.ObjectId().toHexString();
    const otherContext = contextFor(otherTeam, 'req-other-team');
    const adapter = createAdapter();

    const result = await adapter.search(
      requestFor(otherTeam, seeded.datasetId, seeded.collectionId),
      otherContext,
    );
    expect(result.citations).toEqual([]);
  });

  it('rejects invalid collectionFilterMatch operators and handles null $and', async () => {
    const seeded = await seedDocument();
    const adapter = createAdapter();

    await expect(
      adapter.search(
        requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
          collectionFilterMatch: "{tags:{$not:['t1']}}",
        }),
        seeded.context,
      ),
    ).rejects.toMatchObject({ error: { code: 501050 } });

    const empty = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        collectionFilterMatch: "{tags:{$and:['t1',null]}}",
      }),
      seeded.context,
    );
    expect(empty.citations).toEqual([]);
    expect(empty.stats.degraded).toEqual([]);
  });

  it('degrades with full_text_store_unavailable when the full-text store is absent', async () => {
    const seeded = await seedDocument();
    const adapter = createAdapter({ includeFullText: false });

    const result = await adapter.search(
      requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId, {
        searchMode: 'mixedRecall',
      }),
      seeded.context,
    );
    expect(result.citations.map((citation) => citation.dataId)).toContain(seeded.dataId);
    expect(result.stats.degraded).toContainEqual({
      stage: 'fullText',
      reason: 'full_text_store_unavailable',
    });
  });

  it('rejects searchBatch over ten requests with 501050', async () => {
    const seeded = await seedDocument();
    const adapter = createAdapter();
    await expect(
      adapter.searchBatch(
        Array.from({ length: 11 }, () =>
          requestFor(seeded.teamId, seeded.datasetId, seeded.collectionId),
        ),
        seeded.context,
      ),
    ).rejects.toMatchObject({ error: { code: 501050 } });
  });
});
