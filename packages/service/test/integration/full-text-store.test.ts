import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFullTextStoreAdapter } from '../../src/modules/index/adapter/full-text-store.adapter';
import {
  FULL_TEXT_BATCH_SIZE,
  FullTextRepository,
  normalizeText,
  tokenizeForSearch,
} from '../../src/shared/persistence/full-text';
import {
  DatasetDataTextSchema,
  registerMongoModels,
  type RegisteredModels,
} from '../../src/shared/persistence/schemas';
import type { FullTextStore, RequestContext } from '../../src/index';

const uri = process.env.KB_TEST_MONGO_FULLTEXT_URI ?? 'mongodb://127.0.0.1:27017/kb_fulltext_it';
const options = { timeoutMs: 5000 };
const teamA = new mongoose.Types.ObjectId().toHexString();
const teamB = new mongoose.Types.ObjectId().toHexString();

const contextA: RequestContext = {
  requestId: 'req-fulltext-a',
  tenant: { teamId: teamA, tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const contextB: RequestContext = {
  requestId: 'req-fulltext-b',
  tenant: { teamId: teamB, tmbId: 'tmb-b', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

function oid(): string {
  return new mongoose.Types.ObjectId().toHexString();
}

let connection: mongoose.Connection;
let models: RegisteredModels;
let repository: FullTextRepository;
let store: FullTextStore;

beforeAll(async () => {
  connection = mongoose.createConnection(uri);
  await connection.asPromise();
  await connection.dropDatabase();
  models = registerMongoModels(connection);
  await models.DatasetDataText.init();
  repository = new FullTextRepository(connection);
  store = createFullTextStoreAdapter(connection);
});

afterAll(async () => {
  await connection.dropDatabase();
  await connection.close();
});

describe('FullTextStore adapter (10.6 / PORT-STORE-001)', () => {
  it('keeps deterministic normalization and jieba search-mode output', () => {
    expect(normalizeText('　知识库　 系统 ')).toBe('知识库 系统');
    expect(tokenizeForSearch('知识库 系统 测试')).toBe('知识 知识库 系统 测试');
    expect(tokenizeForSearch('   ')).toBe('');
  });

  it('keeps the frozen full-text index definition', () => {
    const entry = DatasetDataTextSchema.indexes().find(
      ([, indexOptions]) => indexOptions?.name === 'teamId_1_fullTextToken_text',
    );
    expect(entry?.[0]).toMatchObject({ teamId: 1, fullTextToken: 'text' });
    expect(entry?.[1]?.default_language).toBe('none');
  });

  it('upserts by dataId and batches writes at 50 with ordered=false', async () => {
    const spy = vi.spyOn(models.DatasetDataText, 'bulkWrite');
    const datasetId = oid();
    const collectionId = oid();
    const dataId = oid();

    await repository.write(
      [{ datasetId, collectionId, dataId, text: '知识库 系统 测试' }],
      contextA,
    );
    await repository.write(
      [{ datasetId, collectionId, dataId, text: '知识库 系统 测试' }],
      contextA,
    );
    expect(
      await models.DatasetDataText.countDocuments({ dataId: new mongoose.Types.ObjectId(dataId) }),
    ).toBe(1);

    const items = Array.from({ length: FULL_TEXT_BATCH_SIZE + 1 }, () => ({
      datasetId: oid(),
      collectionId: oid(),
      dataId: oid(),
      text: '批量 写入 测试',
    }));
    await repository.write(items, contextA);

    const lastTwo = spy.mock.calls.slice(-2);
    expect(lastTwo[0]?.[0]).toHaveLength(FULL_TEXT_BATCH_SIZE);
    expect(lastTwo[0]?.[1]).toMatchObject({ ordered: false });
    expect(lastTwo[1]?.[0]).toHaveLength(1);
    expect(lastTwo[1]?.[1]).toMatchObject({ ordered: false });
    spy.mockRestore();
  });

  it('searches within the current team only and honours collection filters', async () => {
    const datasetId = oid();
    const collectionId = oid();
    const dataId = oid();
    await store.write(
      { datasetId, collectionId, dataId, text: '知识库 系统 检索', options },
      contextA,
    );

    const hits = await store.search({ datasetId, text: '知识库', limit: 10, options }, contextA);
    expect(hits.map((hit) => hit.dataId)).toContain(dataId);

    const foreignHits = await store.search(
      { datasetId, text: '知识库', limit: 10, options },
      contextB,
    );
    expect(foreignHits).toEqual([]);

    const filtered = await store.search(
      { datasetId, collectionIds: [oid()], text: '知识库', limit: 10, options },
      contextA,
    );
    expect(filtered).toEqual([]);
  });

  it('deletes projections by id, dataset and collection with tenant predicate', async () => {
    const datasetId = oid();
    const collectionId = oid();
    const firstId = oid();
    const secondId = oid();
    const foreignDatasetId = oid();
    const foreignCollectionId = oid();
    const foreignDataId = oid();

    await repository.write(
      [
        { datasetId, collectionId, dataId: firstId, text: '第一条' },
        { datasetId, collectionId, dataId: secondId, text: '第二条' },
      ],
      contextA,
    );
    await repository.write(
      [
        {
          datasetId: foreignDatasetId,
          collectionId: foreignCollectionId,
          dataId: foreignDataId,
          text: '外部数据',
        },
      ],
      contextB,
    );

    expect(await store.deleteByDataId({ dataId: firstId, options }, contextA)).toEqual({
      deleted: 1,
    });
    expect(
      await store.deleteByDatasetIds({ datasetIds: [foreignDatasetId], options }, contextA),
    ).toEqual({ deleted: 0 });
    expect(
      await store.deleteByCollectionIds(
        { collectionIds: [foreignCollectionId], options },
        contextA,
      ),
    ).toEqual({ deleted: 0 });
    expect(
      await models.DatasetDataText.countDocuments({
        dataId: new mongoose.Types.ObjectId(foreignDataId),
      }),
    ).toBe(1);

    expect(
      await store.deleteByCollectionIds({ collectionIds: [collectionId], options }, contextA),
    ).toEqual({ deleted: 1 });
  });
});
