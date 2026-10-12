import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFullTextStoreAdapter } from '../../src/modules/index/adapter/full-text-store.adapter';
import { createVectorControllerAdapter } from '../../src/modules/index/adapter/vector-controller.adapter';
import { IndexingService } from '../../src/modules/index/application/indexing.service';
import {
  generateIndexVersion,
  resolveQueryIndexVersion,
} from '../../src/modules/index/domain/index-version';
import { MongoKnowledgeItemRepository } from '../../src/modules/item/repository/mongo-knowledge-item.repository';
import { ensurePgvectorDdl } from '../../src/shared/persistence/pgvector';
import { registerMongoModels } from '../../src/shared/persistence/schemas';
import type { KnowledgeItemSnapshot, PortCallOptions, RequestContext } from '../../src/ports/types';
import type { FullTextStore, VectorController } from '../../src/ports/capabilities';

const connectionString =
  process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
const options: PortCallOptions = { timeoutMs: 5_000 };

function unitVector(position: number): number[] {
  return Array.from({ length: 1536 }, (_, index) => (index === position ? 1 : 0));
}

function requestContext(teamId: string, requestId: string): RequestContext {
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

async function expectCode(run: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await run();
    throw new Error(`expected ApiErrorException ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(code);
  }
}

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let pool: Pool;
let items: MongoKnowledgeItemRepository;
let vectors: VectorController;
let fullText: FullTextStore;
let service: IndexingService;
const touchedDatasets: string[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_index_write_it'));
  await connection.asPromise();
  registerMongoModels(connection);
  await connection.models.DatasetData.init();
  await connection.models.DatasetDataText.init();

  pool = new Pool({ connectionString, max: 4 });
  await ensurePgvectorDdl(pool);

  items = new MongoKnowledgeItemRepository(connection);
  vectors = createVectorControllerAdapter(pool);
  fullText = createFullTextStoreAdapter(connection);
  service = new IndexingService({ items, vectors, fullText });
}, 300_000);

afterAll(async () => {
  if (touchedDatasets.length > 0) {
    await pool.query('DELETE FROM modeldata WHERE dataset_id = ANY($1::text[])', [touchedDatasets]);
  }
  await connection.dropDatabase();
  await connection.close();
  await pool.end();
  await mongo.stop();
});

async function seedItem(): Promise<{
  context: RequestContext;
  item: KnowledgeItemSnapshot;
  dataId: string;
  datasetId: string;
  collectionId: string;
}> {
  const teamId = new Types.ObjectId().toHexString();
  const datasetId = new Types.ObjectId().toHexString();
  const collectionId = new Types.ObjectId().toHexString();
  const dataId = new Types.ObjectId().toHexString();
  const context = requestContext(teamId, `req-index-${dataId}`);
  touchedDatasets.push(datasetId);

  const item: KnowledgeItemSnapshot = {
    dataId,
    teamId,
    datasetId,
    collectionId,
    q: '问题',
    a: '答案',
    indexes: [],
    rebuilding: false,
    version: 1,
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
  };
  await items.bulkUpsert({ items: [item], options }, context);
  return {
    context,
    item: await items.get({ dataId, options }, context),
    dataId,
    datasetId,
    collectionId,
  };
}

describe('P5-01 index write', () => {
  it('TEST-INDEX-WRITE-001 writes the first vector and switches the Mongo reference', async () => {
    const seeded = await seedItem();
    const indexVersion = generateIndexVersion('bge-m3');
    const vectorId = `${seeded.dataId}:qa:${indexVersion}`;

    const result = await service.syncItemIndex(
      {
        item: seeded.item,
        indexVersion,
        entries: [{ type: 'qa', text: '问题 答案', vector: unitVector(0) }],
        fullText: '问题 答案',
        options,
      },
      seeded.context,
    );

    expect(result).toMatchObject({ written: 1, deleted: 0, degraded: [] });
    const vectorRow = await pool.query<{ index_version: string }>(
      'SELECT index_version FROM modeldata WHERE id = $1',
      [vectorId],
    );
    expect(vectorRow.rows[0]?.index_version).toBe('bge-m3:1536:v1');

    const stored = await connection.models.DatasetData.findById(seeded.dataId).lean();
    expect(stored?.indexes[0]?.dataId).toBe(vectorId);
  });

  it('TEST-INDEX-WRITE-001 switches versions and removes stale vectors after CAS succeeds', async () => {
    const seeded = await seedItem();
    const firstVersion = generateIndexVersion('bge-m3');
    const first = await service.syncItemIndex(
      {
        item: seeded.item,
        indexVersion: firstVersion,
        entries: [{ type: 'qa', text: 'v1', vector: unitVector(0) }],
        fullText: 'v1',
        options,
      },
      seeded.context,
    );
    const current = await items.get({ dataId: seeded.dataId, options }, seeded.context);
    const secondVersion = 'bge-m3:1536:v2';

    const second = await service.syncItemIndex(
      {
        item: current,
        indexVersion: secondVersion,
        entries: [{ type: 'qa', text: 'v2', vector: unitVector(1) }],
        fullText: 'v2',
        options,
      },
      seeded.context,
    );

    const firstVectorId = `${seeded.dataId}:qa:${firstVersion}`;
    const secondVectorId = `${seeded.dataId}:qa:${secondVersion}`;
    expect(second.deleted).toBe(1);
    expect(
      (await pool.query('SELECT id FROM modeldata WHERE id = $1', [firstVectorId])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('SELECT id FROM modeldata WHERE id = $1', [secondVectorId])).rowCount,
    ).toBe(1);
    const stored = await connection.models.DatasetData.findById(seeded.dataId).lean();
    expect(stored?.indexes[0]?.dataId).toBe(secondVectorId);
    expect(first.version).toBeGreaterThan(0);
  });

  it('TEST-INDEX-WRITE-001 keeps one full-text row across repeated syncs', async () => {
    const seeded = await seedItem();
    const indexVersion = generateIndexVersion('bge-m3');
    const input = {
      item: seeded.item,
      indexVersion,
      entries: [{ type: 'qa', text: '问题 答案', vector: unitVector(0) }],
      fullText: '问题 答案',
      options,
    };

    await service.syncItemIndex(input, seeded.context);
    const current = await items.get({ dataId: seeded.dataId, options }, seeded.context);
    await service.syncItemIndex({ ...input, item: current }, seeded.context);

    const count = await connection.models.DatasetDataText.countDocuments({
      dataId: new Types.ObjectId(seeded.dataId),
    });
    expect(count).toBe(1);
  });

  it('TEST-SEARCH-INDEXVERSION-001 preserves the old reference when CAS fails', async () => {
    const seeded = await seedItem();
    const firstVersion = generateIndexVersion('bge-m3');
    await service.syncItemIndex(
      {
        item: seeded.item,
        indexVersion: firstVersion,
        entries: [{ type: 'qa', text: 'old', vector: unitVector(0) }],
        fullText: 'old',
        options,
      },
      seeded.context,
    );
    const oldVectorId = `${seeded.dataId}:qa:${firstVersion}`;

    await expectCode(
      () =>
        service.syncItemIndex(
          {
            item: seeded.item,
            indexVersion: 'bge-m3:1536:v9',
            entries: [{ type: 'qa', text: 'new', vector: unitVector(2) }],
            fullText: 'new',
            options,
          },
          seeded.context,
        ),
      501067,
    );

    expect(
      (await pool.query('SELECT id FROM modeldata WHERE id = $1', [oldVectorId])).rowCount,
    ).toBe(1);
    const stored = await connection.models.DatasetData.findById(seeded.dataId).lean();
    expect(stored?.indexes[0]?.dataId).toBe(oldVectorId);
  });

  it('TEST-SEARCH-INDEXVERSION-001 validates pinned versions and keeps tenant recall isolated', async () => {
    const seeded = await seedItem();
    const indexVersion = generateIndexVersion('bge-m3');
    await service.syncItemIndex(
      {
        item: seeded.item,
        indexVersion,
        entries: [{ type: 'qa', text: 'tenant', vector: unitVector(0) }],
        fullText: 'tenant',
        options,
      },
      seeded.context,
    );

    expect(
      resolveQueryIndexVersion({ mode: 'latest', currentVersion: indexVersion }, seeded.context),
    ).toBe(indexVersion);
    await expectCode(
      () =>
        resolveQueryIndexVersion(
          { mode: 'pinned', pinned: 'bge-m3:1536:v9', currentVersion: indexVersion },
          seeded.context,
        ),
      501050,
    );

    const otherContext = requestContext(
      new Types.ObjectId().toHexString(),
      `req-index-other-${seeded.dataId}`,
    );
    const hits = await vectors.embRecall(
      {
        teamId: otherContext.tenant.teamId,
        datasetId: seeded.datasetId,
        collectionId: seeded.collectionId,
        vector: unitVector(0),
        indexVersion,
        limit: 10,
        options,
      },
      otherContext,
    );
    expect(hits).toEqual([]);
  });
});
