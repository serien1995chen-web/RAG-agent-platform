import { describe, expect, it } from 'vitest';
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
