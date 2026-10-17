import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeImageMode } from '../../src/modules/item/application/image.service';
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
const context: RequestContext = {
  requestId: 'req-training-mode',
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
let datasetId: string;

/**
 * ISSUE-002：训练模式（chunk/qa/image/imageParse）与切分模式（auto/paragraph/custom）
 * 必须是两个独立字段；auto 改写落库为 trainingMode=chunk + autoIndexes。
 */
describe('training mode vocabulary (ISSUE-002)', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    connection = mongoose.createConnection(mongo.getUri());
    await connection.asPromise();
    collections =
      (connection.models.DatasetCollection as mongoose.Model<DatasetCollectionDoc>) ??
      connection.model<DatasetCollectionDoc>('DatasetCollection', DatasetCollectionSchema);
    const datasets =
      (connection.models.Dataset as mongoose.Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
    repository = new MongoCollectionRepository(connection);

    const dataset = await datasets.create({
      teamId,
      createdBy: new mongoose.Types.ObjectId(),
      parentId: null,
      type: 'knowledge',
      name: 'training-mode-ds',
      intro: '',
      avatar: '',
      vectorModel: 'bge-m3',
      indexVersion: 'v1',
      agentModel: null,
      vlmModel: null,
      chunkPolicy: DEFAULT_CHUNK_POLICY,
      apiDatasetConfig: null,
      inheritPermission: true,
      autoSync: false,
      deleteTime: null,
      version: 1,
      createTime: new Date(),
      updateTime: new Date(),
    });
    datasetId = String(dataset._id);
  }, 60_000);

  afterAll(async () => {
    await connection.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await collections.deleteMany({});
  });

  it('normalizeImageMode maps auto to trainingMode=chunk and never to a chunkPolicy value', () => {
    expect(normalizeImageMode('auto')).toEqual({ trainingMode: 'chunk', autoIndexes: true });
    expect(normalizeImageMode('image')).toEqual({ trainingMode: 'image', autoIndexes: false });
    expect(normalizeImageMode('imageParse')).toEqual({
      trainingMode: 'imageParse',
      autoIndexes: false,
    });
  });

  it('persists trainingMode separately from chunkPolicy.mode', async () => {
    const normalized = normalizeImageMode('auto');
    const { collectionId } = await repository.create(
      {
        collection: {
          teamId: String(teamId),
          datasetId,
          parentId: null,
          type: 'image',
          name: 'auto-images',
          tagIds: [],
          trainingMode: normalized.trainingMode,
          autoIndexes: normalized.autoIndexes,
          trainingPolicy: DEFAULT_CHUNK_POLICY,
        },
        options: { timeoutMs: 10_000 },
      },
      context,
    );

    const stored = await collections.findById(collectionId).lean();
    expect(stored?.type).toBe('images');
    expect(stored?.trainingMode).toBe('chunk');
    expect(stored?.autoIndexes).toBe(true);
    // 切分模式保持自身词汇，不再被训练模式污染
    expect(stored?.trainingPolicy?.mode).toBe('auto');
  });

  it('infers trainingMode for historical documents that lack the field', async () => {
    const legacy = await collections.create({
      teamId,
      datasetId,
      parentId: null,
      type: 'file',
      name: 'legacy',
      tagIds: [],
      sourceRef: null,
      externalFileId: null,
      externalFileIdNormalized: null,
      hashRawText: null,
      trainingPolicy: DEFAULT_CHUNK_POLICY,
      indexVersion: null,
      forbid: false,
      trainingState: 'ready',
      remainingTraining: 0,
    } as DatasetCollectionDoc);

    const snapshot = await repository.get(
      { collectionId: String(legacy._id), options: { timeoutMs: 10_000 } },
      context,
    );
    expect(snapshot.trainingMode).toBe('chunk');
  });
});
