import { describe, expect, it } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import {
  createDefaultDocumentParser,
  type DocumentParseContext,
} from '../../packages/parse/src/index';
import {
  EmbeddingService,
  type FullTextStore,
  ImportSourceService,
  InsertDataService,
  type KnowledgeItemRepository,
  type RequestContext,
  type VectorController,
  type VectorRecord,
} from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-ingest-fault',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

function providerError(code: number, params: Record<string, unknown>): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId: 'object-store', params }));
}

function noopFullText(): FullTextStore {
  return {
    search: async () => [],
    write: async () => undefined,
    deleteByDataId: async () => ({ deleted: 0 }),
    deleteByDatasetIds: async () => ({ deleted: 0 }),
    deleteByCollectionIds: async () => ({ deleted: 0 }),
  };
}

/** TEST-FI-INGEST-001 故障分类与无残留。 */
describe('TEST-FI-INGEST-001 ingest fault classification', () => {
  it('classifies an unsupported parser format as 501056 and never fakes success', async () => {
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: '0000000000000000000000d1',
      fileRef: 'file.unknown',
      extension: 'unknown',
      timeoutMs: 1_000,
      bytes: Buffer.from('x', 'utf8'),
    };
    await expect(createDefaultDocumentParser().parse(parseRequest)).rejects.toMatchObject({
      error: { code: 501056 },
    });
  });

  it('classifies a model (embedding gateway) fault as 501062 without a fake vector', async () => {
    const embedding = new EmbeddingService();
    await expect(
      embedding.embed(
        { models: { embeddingModel: 'bge-m3' }, texts: ['hello'], options: { timeoutMs: 1_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501062 } });
  });

  it('classifies S3 storage faults and creates no collection (no orphan)', async () => {
    let created = 0;
    const service = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
        list: async () => ({ total: 0, list: [], cursor: null }),
        update: async () => ({ version: 1 }),
        deleteTree: async () => ({ deleteJobId: 'd1' }),
      },
      sourceProvider: {
        read: async () => {
          throw providerError(501016, { store: 's3', operation: 'get' });
        },
        preview: async () => {
          throw providerError(501016, { store: 's3', operation: 'get' });
        },
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        {
          collection: {
            teamId: context.tenant.teamId,
            datasetId: '0000000000000000000000d1',
            parentId: null,
            type: 'file',
            name: 'f',
            tagIds: [],
          },
          sourceType: 'file',
          sourceRef: 'dataset/d1/a.md',
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501016 } });
    expect(created).toBe(0);
  });

  it('classifies PG vector faults before any Mongo write (no orphan data)', async () => {
    let upserts = 0;
    const items: KnowledgeItemRepository = {
      bulkUpsert: async ({ items: batch }) => {
        upserts += 1;
        return { upserted: batch.length, duplicates: 0 };
      },
      updateIndexes: async () => ({ version: 1 }),
      deleteByScope: async () => ({ deleted: 0 }),
    };
    const vectors: VectorController = {
      insert: async (_input: { records: VectorRecord[]; options: { timeoutMs: number } }) => {
        throw providerError(501016, { store: 'pgvector', operation: 'insert' });
      },
      delete: async () => ({ deleted: 0 }),
      embRecall: async () => [],
      getVectorDataByTime: async () => [],
      getVectorCount: async () => 0,
    };
    const service = new InsertDataService({ items, vectors, fullText: noopFullText() });
    await expect(
      service.insertDirect(
        {
          dataId: '0000000000000000000000aa',
          datasetId: '0000000000000000000000d1',
          collectionId: '0000000000000000000000c1',
          q: 'hello',
          vector: new Array<number>(3).fill(0),
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501016 } });
    expect(upserts).toBe(0);
  });
});
