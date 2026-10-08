import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoKnowledgeBaseRepository } from '../../src/modules/knowledge-base/repository/mongo-knowledge-base.repository';
import { DatasetSchema, type DatasetDoc } from '../../src/shared/persistence/schemas';
import type { RequestContext } from '../../src/ports/types';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const tmbId = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-kb-repo',
  tenant: { teamId: String(teamId), tmbId: String(tmbId), authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoKnowledgeBaseRepository;
let model: mongoose.Model<DatasetDoc>;

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
  connection = mongoose.createConnection(mongo.getUri('kb_kb_repository'));
  await connection.asPromise();
  model = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  await model.init();
  repository = new MongoKnowledgeBaseRepository(connection);
}, 60_000);

beforeEach(async () => {
  await model.deleteMany({});
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoKnowledgeBaseRepository (P2-08 / PORT-DATA-001)', () => {
  it('creates and lists only same-team root datasets with paging', async () => {
    await repository.create(
      {
        dataset: {
          teamId: String(teamId),
          parentId: null,
          type: 'knowledge',
          name: 'alpha',
          vectorModel: 'bge-m3',
          inheritPermission: true,
          autoSync: false,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await model.create({
      teamId: otherTeamId,
      createdBy: tmbId,
      parentId: null,
      type: 'knowledge',
      name: 'foreign',
      vectorModel: 'bge-m3',
      indexVersion: 'bge-m3:1536:v1',
      deleteTime: null,
    });

    const result = await repository.listByTeam(
      { parentId: null, type: null, page: 1, limit: 20 },
      context,
    );
    expect(result.total).toBe(1);
    expect(result.list.map((item) => item.name)).toEqual(['alpha']);
  });

  it('rejects duplicate names in one team and rejects websiteDataset', async () => {
    const input = {
      dataset: {
        teamId: String(teamId),
        parentId: null,
        type: 'knowledge' as const,
        name: 'same-name',
        vectorModel: 'bge-m3',
        inheritPermission: true,
        autoSync: false,
      },
      options: { timeoutMs: 5_000 },
    };
    await repository.create(input, context);
    await expectCode(() => repository.create(input, context), 501066);
    await expectCode(
      () =>
        repository.create(
          {
            dataset: { ...input.dataset, type: 'websiteDataset', name: 'website' },
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501001,
    );
  });

  it('enforces parent same-team, folder type and version CAS updates', async () => {
    const folder = await repository.create(
      {
        dataset: {
          teamId: String(teamId),
          parentId: null,
          type: 'folder',
          name: 'folder',
          vectorModel: 'bge-m3',
          inheritPermission: true,
          autoSync: false,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const dataset = await repository.create(
      {
        dataset: {
          teamId: String(teamId),
          parentId: folder.datasetId,
          type: 'knowledge',
          name: 'child',
          vectorModel: 'bge-m3',
          inheritPermission: true,
          autoSync: false,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );

    const updated = await repository.updateDataset(
      {
        datasetId: dataset.datasetId,
        version: dataset.version,
        patch: { name: 'renamed' },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(updated.version).toBe(dataset.version + 1);
    await expectCode(
      () =>
        repository.updateDataset(
          {
            datasetId: dataset.datasetId,
            version: dataset.version,
            patch: { name: 'stale' },
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501067,
    );
    await expectCode(
      () =>
        repository.create(
          {
            dataset: {
              teamId: String(teamId),
              parentId: dataset.datasetId,
              type: 'knowledge',
              name: 'invalid-parent',
              vectorModel: 'bge-m3',
              inheritPermission: true,
              autoSync: false,
            },
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
      501004,
    );
  });

  it('soft-deletes with CAS and never exposes deleted datasets', async () => {
    const created = await repository.create(
      {
        dataset: {
          teamId: String(teamId),
          parentId: null,
          type: 'knowledge',
          name: 'to-delete',
          vectorModel: 'bge-m3',
          inheritPermission: true,
          autoSync: false,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    await expectCode(
      () =>
        repository.softDelete(
          { datasetId: created.datasetId, version: 99, options: { timeoutMs: 5_000 } },
          context,
        ),
      501067,
    );
    const deleted = await repository.softDelete(
      { datasetId: created.datasetId, version: created.version, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(deleted.deleteJobId).toContain(created.datasetId);
    await expectCode(
      () =>
        repository.get({ datasetId: created.datasetId, options: { timeoutMs: 5_000 } }, context),
      501070,
    );
  });
});
