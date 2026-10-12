import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHUNK_POLICY, chunkText } from '../../packages/chunk/src/index';
import {
  createDefaultDocumentParser,
  type DocumentParseContext,
} from '../../packages/parse/src/index';
import {
  EmbeddingService,
  type EmbeddingGateway,
  InsertDataService,
  type KnowledgeItemRepository,
  type KnowledgeItemSnapshot,
  type RequestContext,
  type VectorController,
  type VectorRecord,
  type FullTextStore,
} from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-ingest-full-chain',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const routeState = vi.hoisted(() => ({
  runtime: undefined as unknown,
  items: [] as { dataId: string }[],
  vectors: [] as { dataId: string }[],
  fullText: [] as { dataId: string }[],
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => routeState.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({
    subject: {
      teamId: '000000000000000000000001',
      tmbId: '000000000000000000000002',
      authType: 'token',
      isRoot: false,
    },
    context: {
      requestId: 'req-route-chain',
      tenant: {
        teamId: '000000000000000000000001',
        tmbId: '000000000000000000000002',
        authType: 'token',
        isRoot: false,
      },
      permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
    },
  }),
}));

/** TEST-E2E-INGEST-001 全链路：文件 -> Parse -> Chunk -> Vector/Mongo/FullText -> 可检索。 */
describe('TEST-E2E-INGEST-001 ingest full chain', () => {
  it('parses, chunks and inserts a document into a searchable projection', async () => {
    const markdown = '# Title\n\nfirst paragraph about ingestion.\n\nsecond paragraph.';
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: '0000000000000000000000d1',
      fileRef: 'doc.md',
      extension: 'md',
      timeoutMs: 5_000,
      bytes: Buffer.from(markdown, 'utf8'),
    };
    const parsed = await createDefaultDocumentParser().parse(parseRequest);
    expect(parsed.format).toBe('markdown');
    expect(parsed.rawText).toContain('ingestion');

    const chunked = chunkText({ text: parsed.rawText, policy: DEFAULT_CHUNK_POLICY });
    expect(chunked.chunks.length).toBeGreaterThan(0);

    const items = new Map<string, KnowledgeItemSnapshot>();
    const vectors: VectorRecord[] = [];
    const fullText: { dataId: string; text: string }[] = [];
    const itemRepository: KnowledgeItemRepository = {
      bulkUpsert: async ({ items: batch }) => {
        for (const item of batch) items.set(item.dataId, item);
        return { upserted: batch.length, duplicates: 0 };
      },
      updateIndexes: async () => ({ version: 1 }),
      deleteByScope: async () => ({ deleted: 0 }),
    };
    const vectorController: VectorController = {
      insert: async ({ records }) => {
        vectors.push(...records);
        return { inserted: records.length };
      },
      delete: async () => ({ deleted: 0 }),
      embRecall: async ({ limit }) =>
        vectors
          .slice(0, limit)
          .map((record) => ({ dataId: record.dataId, indexId: record.indexId, score: 0.9 })),
      getVectorDataByTime: async () => [],
      getVectorCount: async () => vectors.length,
    };
    const fullTextStore: FullTextStore = {
      search: async () => [],
      write: async ({ dataId, text }) => {
        fullText.push({ dataId, text });
      },
      deleteByDataId: async () => ({ deleted: 0 }),
      deleteByDatasetIds: async () => ({ deleted: 0 }),
      deleteByCollectionIds: async () => ({ deleted: 0 }),
    };
    const gateway: EmbeddingGateway = {
      embed: async ({ texts }) => texts.map(() => new Array<number>(1536).fill(0.1)),
    };
    const embedding = new EmbeddingService({ gateway });
    const service = new InsertDataService({
      items: itemRepository,
      vectors: vectorController,
      fullText: fullTextStore,
    });

    const dataId = '0000000000000000000000aa';
    const vectors1536 = await embedding.embed(
      {
        models: { embeddingModel: 'bge-m3' },
        texts: [chunked.chunks[0]?.text ?? ''],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    const result = await service.insertDirect(
      {
        dataId,
        datasetId: '0000000000000000000000d1',
        collectionId: '0000000000000000000000c1',
        q: chunked.chunks[0]?.text ?? '',
        vector: vectors1536[0] ?? [],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(result.inserted).toBe(1);
    expect(vectors.length).toBe(1);
    expect(fullText[0]?.dataId).toBe(dataId);

    const recall = await vectorController.embRecall(
      {
        teamId: context.tenant.teamId,
        datasetId: '0000000000000000000000d1',
        vector: vectors1536[0] ?? [],
        limit: 5,
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(recall[0]?.dataId).toBe(dataId);

    expect(items.get(dataId)?.q).toBe(chunked.chunks[0]?.text);
  });
});

function routeRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { data?: unknown; code?: number } };
} {
  let status = 200;
  let body: { data?: unknown; code?: number } = {};
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value as { data?: unknown; code?: number };
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body }) };
}

function routeRequest(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/core/dataset/data/insertData',
    query: {},
    headers: {},
    body,
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  routeState.items = [];
  routeState.vectors = [];
  routeState.fullText = [];
  routeState.runtime = {
    collectionService: {
      getCollection: async (input: { collectionId: string }) => ({
        collectionId: input.collectionId,
        teamId: '000000000000000000000001',
        datasetId: '0000000000000000000000d1',
        parentId: null,
        type: 'virtual',
        name: 'n',
        tagIds: [],
        sourceRef: 's',
        version: 1,
        createTime: 'now',
        updateTime: 'now',
      }),
    },
    embeddingService: { embed: async () => [new Array<number>(1536).fill(0.1)] },
    vectorController: {
      insert: async (input: { records: { dataId: string }[] }) => {
        routeState.vectors.push(...input.records.map((record) => ({ dataId: record.dataId })));
        return { inserted: input.records.length };
      },
      embRecall: async () =>
        routeState.vectors.map((v) => ({ dataId: v.dataId, indexId: 'i', score: 1 })),
    },
    knowledgeItemRepository: {
      bulkUpsert: async (input: { items: { dataId: string }[] }) => {
        routeState.items.push(...input.items.map((item) => ({ dataId: item.dataId })));
        return { upserted: input.items.length, duplicates: 0 };
      },
    },
    fullTextStore: {
      write: async (input: { dataId: string }) => {
        routeState.fullText.push({ dataId: input.dataId });
      },
    },
    ports: { fullTextStore: { write: async () => undefined } },
  };
});

describe('TEST-E2E-INGEST-001 route-level chain', () => {
  it('runs insertData route through embedding -> vector -> mongo -> fulltext -> recall', async () => {
    const insertData = (
      await import('../../projects/app/src/pages/api/core/dataset/data/insertData')
    ).default;
    const res = routeRecorder();
    await insertData(
      routeRequest({ collectionId: '0000000000000000000000c1', q: 'route chain question' }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    const dataId = (res.result().body.data as { dataId: string }).dataId;
    expect(routeState.vectors[0]?.dataId).toBe(dataId);
    expect(routeState.items[0]?.dataId).toBe(dataId);
    expect(routeState.fullText[0]?.dataId).toBe(dataId);

    const runtime = routeState.runtime as {
      vectorController: { embRecall: () => Promise<{ dataId: string }[]> };
    };
    const recall = await runtime.vectorController.embRecall();
    expect(recall[0]?.dataId).toBe(dataId);
  });
});
