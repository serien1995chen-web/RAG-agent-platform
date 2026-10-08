import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { buildQaDedupKey } from '../../src/modules/item/domain/dedup-key';
import { MongoKnowledgeItemRepository } from '../../src/modules/item/repository/mongo-knowledge-item.repository';
import { DatasetDataSchema, type DatasetDataDoc } from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-item-repo',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};
const datasetId = String(new mongoose.Types.ObjectId());
const collectionA = String(new mongoose.Types.ObjectId());
const collectionB = String(new mongoose.Types.ObjectId());

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoKnowledgeItemRepository;
let model: mongoose.Model<DatasetDataDoc>;

async function expectCode(run: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await run();
    throw new Error(`expected ApiErrorException ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(code);
  }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_item_repository'));
  await connection.asPromise();
  model = connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
  await model.init();
  repository = new MongoKnowledgeItemRepository(connection);
}, 60_000);

beforeEach(async () => {
  await model.deleteMany({});
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoKnowledgeItemRepository (P2-10 / PORT-DATA-003)', () => {
  it('keeps QA upserts idempotent and uses the frozen dedup hash', async () => {
    const item = {
      dataId: String(new mongoose.Types.ObjectId()),
      teamId: String(teamId),
      datasetId,
      collectionId: collectionA,
      q: '问题',
      a: '答案',
      indexes: [],
      rebuilding: false,
      version: 1,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
    };
    const first = await repository.bulkUpsert(
      { items: [item], options: { timeoutMs: 5_000 } },
      context,
    );
    const second = await repository.bulkUpsert(
      {
        items: [{ ...item, dataId: String(new mongoose.Types.ObjectId()) }],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(first).toEqual({ upserted: 1, duplicates: 0 });
    expect(second).toEqual({ upserted: 0, duplicates: 1 });
    expect(await model.countDocuments({ dedupKey: buildQaDedupKey('问题', '答案') })).toBe(1);
  });

  it('updates indexes with CAS and keeps history at ten entries', async () => {
    const dataId = new mongoose.Types.ObjectId();
    await model.create({
      _id: dataId,
      teamId,
      datasetId: new mongoose.Types.ObjectId(datasetId),
      collectionId: new mongoose.Types.ObjectId(collectionA),
      q: 'old',
      a: 'old',
      indexes: [],
      history: Array.from({ length: 12 }, (_, index) => ({
        oldQuestion: `q${index}`,
        oldAnswer: `a${index}`,
        updatedAt: new Date(),
      })),
      dedupKey: buildQaDedupKey('old', 'old'),
    });
    await repository.bulkUpsert(
      {
        items: [
          {
            dataId: String(dataId),
            teamId: String(teamId),
            datasetId,
            collectionId: collectionA,
            q: 'new',
            a: 'answer',
            indexes: [],
            rebuilding: false,
            version: 1,
            createTime: new Date().toISOString(),
            updateTime: new Date().toISOString(),
          },
        ],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const stored = await model.findById(dataId).lean();
    expect(stored?.history).toHaveLength(10);

    const snapshot = await repository.get(
      { dataId: String(dataId), options: { timeoutMs: 5_000 } },
      context,
    );
    const updated = await repository.updateIndexes(
      {
        dataId: String(dataId),
        version: snapshot.version,
        indexes: [
          {
            indexId: 'idx-1',
            type: 'summary',
            dataId: String(dataId),
            text: 'summary',
          },
        ],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(updated.version).toBeGreaterThan(snapshot.version);
    await expectCode(
      () =>
        repository.updateIndexes(
          {
            dataId: String(dataId),
            version: snapshot.version,
            indexes: [],
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501067,
    );
  });

  it('deletes by scope without crossing collection boundaries', async () => {
    await model.insertMany([
      {
        teamId,
        datasetId: new mongoose.Types.ObjectId(datasetId),
        collectionId: new mongoose.Types.ObjectId(collectionA),
        q: 'a',
        a: '',
        indexes: [],
      },
      {
        teamId,
        datasetId: new mongoose.Types.ObjectId(datasetId),
        collectionId: new mongoose.Types.ObjectId(collectionB),
        q: 'b',
        a: '',
        indexes: [],
      },
    ]);
    const deleted = await repository.deleteByScope(
      {
        datasetId,
        collectionId: collectionA,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(deleted.deleted).toBe(1);
    expect(
      await model.countDocuments({
        collectionId: new mongoose.Types.ObjectId(collectionB),
      }),
    ).toBe(1);
  });
});
