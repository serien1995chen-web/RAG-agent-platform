import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoCollectionRepository } from '../../src/modules/collection/repository/mongo-collection.repository';
import {
  DatasetCollectionSchema,
  DatasetSchema,
  type DatasetCollectionDoc,
  type DatasetDoc,
} from '../../src/shared/persistence/schemas';
import { DEFAULT_CHUNK_POLICY } from '../../src/shared/persistence/schemas/common';
import type { RequestContext } from '../../src/ports/types';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-collection-repo',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoCollectionRepository;
let collections: mongoose.Model<DatasetCollectionDoc>;
let datasets: mongoose.Model<DatasetDoc>;
let datasetId: string;

async function expectCode(run: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await run();
    throw new Error(`expected ApiErrorException ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(code);
  }
}

async function createCollection(input: {
  name: string;
  parentId?: string | null;
  type?: 'folder' | 'file';
  externalFileIdNormalized?: string;
}): Promise<string> {
  const created = await repository.create(
    {
      collection: {
        teamId: String(teamId),
        datasetId,
        parentId: input.parentId ?? null,
        type: input.type ?? (input.parentId ? 'file' : 'folder'),
        name: input.name,
        tagIds: [],
        ...(input.externalFileIdNormalized !== undefined
          ? { externalFileId: input.externalFileIdNormalized, sourceRef: 'source' }
          : {}),
      },
      options: { timeoutMs: 5_000 },
    },
    context,
  );
  return created.collectionId;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_collection_repository'));
  await connection.asPromise();
  datasets = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  collections = connection.model<DatasetCollectionDoc>(
    'DatasetCollection',
    DatasetCollectionSchema,
  );
  await Promise.all([datasets.init(), collections.init()]);
  repository = new MongoCollectionRepository(connection);
}, 60_000);

beforeEach(async () => {
  await Promise.all([datasets.deleteMany({}), collections.deleteMany({})]);
  const dataset = await datasets.create({
    teamId,
    createdBy: new mongoose.Types.ObjectId(),
    parentId: null,
    type: 'knowledge',
    name: 'dataset',
    vectorModel: 'bge-m3',
    indexVersion: 'bge-m3:1536:v1',
    deleteTime: null,
  });
  datasetId = String(dataset._id);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoCollectionRepository (P2-09 / PORT-DATA-002)', () => {
  it('creates folders/files and returns a root-to-source path', async () => {
    const folder = await createCollection({ name: 'folder' });
    const file = await createCollection({ name: 'file', parentId: folder });
    const path = await repository.paths({ datasetId, sourceId: file, type: 'collection' }, context);
    expect(path.map((node) => node.name)).toEqual(['folder', 'file']);
  });

  it('rejects invalid parents, cycles and duplicate external file ids', async () => {
    const folder = await createCollection({ name: 'folder' });
    const fileChild = await createCollection({
      name: 'file-child',
      parentId: folder,
      type: 'file',
    });
    const folderChild = await createCollection({
      name: 'folder-child',
      parentId: folder,
      type: 'folder',
    });
    await expectCode(() => createCollection({ name: 'bad', parentId: fileChild }), 501004);
    const folderSnapshot = await repository.get(
      { collectionId: folder, options: { timeoutMs: 5_000 } },
      context,
    );
    const childSnapshot = await repository.get(
      { collectionId: folderChild, options: { timeoutMs: 5_000 } },
      context,
    );
    await expectCode(
      () =>
        repository.move(
          {
            collectionId: folder,
            version: folderSnapshot.version,
            targetParentId: folderChild,
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501046,
    );
    expect(childSnapshot.parentId).toBe(folder);
    await createCollection({ name: 'external', externalFileIdNormalized: 'ABC' });
    await expectCode(
      () => createCollection({ name: 'external-2', externalFileIdNormalized: ' abc ' }),
      501002,
    );
  });

  it('scopes list/deleteTree to the current tenant and enforces CAS', async () => {
    const folder = await createCollection({ name: 'folder' });
    const foreign = await collections.create({
      teamId: otherTeamId,
      datasetId: new mongoose.Types.ObjectId(),
      parentId: null,
      type: 'folder',
      name: 'foreign',
      trainingPolicy: DEFAULT_CHUNK_POLICY,
    });

    const own = await repository.list(
      { datasetId, page: 1, limit: 20, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(own.total).toBe(1);
    await expectCode(
      () =>
        repository.deleteTree(
          {
            collectionId: String(foreign._id),
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501070,
    );
    const snapshot = own.list[0]!;
    const updated = await repository.update(
      {
        collectionId: folder,
        version: snapshot.version,
        patch: { name: 'renamed' },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(updated.version).toBeGreaterThan(snapshot.version);
    await expectCode(
      () =>
        repository.update(
          {
            collectionId: folder,
            version: snapshot.version,
            patch: { name: 'stale' },
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501067,
    );
    const deleted = await repository.deleteTree(
      { collectionId: folder, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(deleted.deleteJobId).toContain(folder);
  });
});
