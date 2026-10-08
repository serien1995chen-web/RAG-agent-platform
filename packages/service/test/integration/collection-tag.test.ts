import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { MongoCollectionTagRepository } from '../../src/modules/collection/repository/mongo-collection-tag.repository';
import {
  DatasetCollectionSchema,
  DatasetTagSchema,
  type DatasetCollectionDoc,
  type DatasetTagDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const datasetId = new mongoose.Types.ObjectId();
const otherDatasetId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-tag-repo',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let mongo: MongoMemoryReplSet;
let connection: mongoose.Connection;
let repository: MongoCollectionTagRepository;
let tags: mongoose.Model<DatasetTagDoc>;
let collections: mongoose.Model<DatasetCollectionDoc>;
let collectionA: string;
let collectionB: string;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(mongo.getUri('kb_collection_tag_repository'));
  await connection.asPromise();
  tags = connection.model<DatasetTagDoc>('DatasetTag', DatasetTagSchema);
  collections = connection.model<DatasetCollectionDoc>(
    'DatasetCollection',
    DatasetCollectionSchema,
  );
  await Promise.all([tags.init(), collections.init()]);
  repository = new MongoCollectionTagRepository(connection);
}, 120_000);

beforeEach(async () => {
  await Promise.all([tags.deleteMany({}), collections.deleteMany({})]);
  const docs = await collections.create([
    {
      teamId,
      datasetId,
      parentId: null,
      type: 'folder',
      name: 'a',
      tagIds: [],
      trainingPolicy: {
        mode: 'auto',
        chunkSize: 1000,
        minSize: 100,
        maxSize: 8000,
        overlapRatio: 0.15,
        paragraphDeep: 5,
        customRegs: [],
        lengthUnit: 'token',
        forceSplit: true,
        maxChunks: 50000,
      },
    },
    {
      teamId,
      datasetId,
      parentId: null,
      type: 'folder',
      name: 'b',
      tagIds: [],
      trainingPolicy: {
        mode: 'auto',
        chunkSize: 1000,
        minSize: 100,
        maxSize: 8000,
        overlapRatio: 0.15,
        paragraphDeep: 5,
        customRegs: [],
        lengthUnit: 'token',
        forceSplit: true,
        maxChunks: 50000,
      },
    },
  ]);
  collectionA = String(docs[0]?._id);
  collectionB = String(docs[1]?._id);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoCollectionTagRepository (P2-15)', () => {
  it('enforces unique names and binds/unbinds collections atomically', async () => {
    const created = await repository.create(
      { datasetId: String(datasetId), name: 'tag', options: { timeoutMs: 5_000 } },
      context,
    );
    await expect(
      repository.create(
        { datasetId: String(datasetId), name: 'tag', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501043 } });
    const bound = await repository.addToCollections(
      {
        datasetId: String(datasetId),
        tagId: created.tagId,
        collectionIds: [collectionA, collectionB],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(bound.updated).toHaveLength(2);
    const removed = await repository.removeFromCollections(
      {
        datasetId: String(datasetId),
        tagId: created.tagId,
        collectionIds: [collectionA],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(removed.updated).toEqual([collectionA]);
  });

  it('rejects cross-dataset collections, cleans references and updates tags with CAS', async () => {
    const created = await repository.create(
      { datasetId: String(datasetId), name: 'tag-2', options: { timeoutMs: 5_000 } },
      context,
    );
    await collections.create({
      teamId,
      datasetId: otherDatasetId,
      parentId: null,
      type: 'folder',
      name: 'foreign',
      tagIds: [],
      trainingPolicy: {
        mode: 'auto',
        chunkSize: 1000,
        minSize: 100,
        maxSize: 8000,
        overlapRatio: 0.15,
        paragraphDeep: 5,
        customRegs: [],
        lengthUnit: 'token',
        forceSplit: true,
        maxChunks: 50000,
      },
    });
    const foreign = await collections.findOne({ datasetId: otherDatasetId }).lean();
    await expect(
      repository.addToCollections(
        {
          datasetId: String(datasetId),
          tagId: created.tagId,
          collectionIds: [String(foreign?._id)],
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501045 } });
    await repository.addToCollections(
      {
        datasetId: String(datasetId),
        tagId: created.tagId,
        collectionIds: [collectionA],
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const tag = (
      await repository.list(
        { datasetId: String(datasetId), options: { timeoutMs: 5_000 } },
        context,
      )
    )[0]!;
    const updated = await repository.update(
      {
        datasetId: String(datasetId),
        tagId: tag.tagId,
        version: tag.version,
        name: 'tag-renamed',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(updated.version).toBeGreaterThan(tag.version);
    const deleted = await repository.delete(
      {
        datasetId: String(datasetId),
        tagId: updated.tagId,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(deleted.affectedCollections).toBe(1);
    expect((await collections.findById(collectionA).lean())?.tagIds).toEqual([]);
  });
});
