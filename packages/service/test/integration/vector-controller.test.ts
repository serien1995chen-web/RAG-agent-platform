import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVectorControllerAdapter } from '../../src/modules/index/adapter/vector-controller.adapter';
import { PGVECTOR_DIMENSION, ensurePgvectorDdl } from '../../src/shared/persistence/pgvector';
import type { RequestContext, VectorController } from '../../src/index';

const connectionString =
  process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
const options = { timeoutMs: 5000 };
const datasetId = 'vec-it-ds';
const collectionId = 'vec-it-col';

const contextA: RequestContext = {
  requestId: 'req-vector-a',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const contextB: RequestContext = {
  requestId: 'req-vector-b',
  tenant: { teamId: 'team-b', tmbId: 'tmb-b', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

function unitVector(position: number): number[] {
  return Array.from({ length: PGVECTOR_DIMENSION }, (_, index) => (index === position ? 1 : 0));
}

let pool: Pool;
let client: Client;
let controller: VectorController;

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 4 });
  client = new Client({ connectionString });
  await client.connect();
  await ensurePgvectorDdl(pool);
  await ensurePgvectorDdl(pool);
  await pool.query('DELETE FROM modeldata WHERE dataset_id = $1', [datasetId]);
  controller = createVectorControllerAdapter(pool);
});

afterAll(async () => {
  await pool.query('DELETE FROM modeldata WHERE dataset_id = $1', [datasetId]);
  await client.end();
  await pool.end();
});

describe('VectorController adapter (10.16 / ADR-002)', () => {
  it('keeps the frozen DDL idempotent with 1536 dimensions and HNSW parameters', async () => {
    const dimension = await client.query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
       WHERE attrelid = 'modeldata'::regclass AND attname = 'vector'`,
    );
    expect(dimension.rows[0]?.type).toBe('vector(1536)');

    const hnsw = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'modeldata' AND indexname = 'modeldata_vector_hnsw'`,
    );
    expect(hnsw.rows[0]?.indexdef).toContain('vector_cosine_ops');
    expect(hnsw.rows[0]?.indexdef).toContain("m='32'");
    expect(hnsw.rows[0]?.indexdef).toContain("ef_construction='128'");

    const filterIndex = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'modeldata_team_dataset_collection_idx'`,
    );
    expect(filterIndex.rows[0]?.indexdef).toContain('index_version');
  });

  it('rejects missing tenant scope with 501012 and dimension mismatch with 501013', async () => {
    const record = {
      teamId: 'team-a',
      datasetId,
      collectionId,
      dataId: 'vec-it-guard',
      indexId: 'vec-it-guard',
      indexVersion: 'bge-m3:1536:v1',
      vector: unitVector(0),
    };

    await expect(
      controller.insert({ records: [{ ...record, datasetId: '' }], options }, contextA),
    ).rejects.toMatchObject({ error: { code: 501012 } });
    await expect(
      controller.insert({ records: [{ ...record, teamId: 'team-b' }], options }, contextA),
    ).rejects.toMatchObject({ error: { code: 501012 } });
    await expect(
      controller.insert({ records: [{ ...record, vector: [0, 0] }], options }, contextA),
    ).rejects.toMatchObject({ error: { code: 501013 } });

    await expect(
      controller.embRecall(
        { teamId: 'team-a', datasetId, vector: unitVector(0), limit: 5, options },
        contextA,
      ),
    ).rejects.toMatchObject({ error: { code: 501012 } });
    await expect(
      controller.embRecall(
        { teamId: 'team-a', datasetId: '', collectionId, vector: unitVector(0), limit: 5, options },
        contextA,
      ),
    ).rejects.toMatchObject({ error: { code: 501012 } });
    await expect(
      controller.embRecall(
        { teamId: '', datasetId, collectionId, vector: unitVector(0), limit: 5, options },
        contextA,
      ),
    ).rejects.toMatchObject({ error: { code: 501012 } });
  });

  it('isolates tenants and supports insert, recall, count, time scan and delete', async () => {
    const idA = `vec-it-a-${Date.now()}`;
    const idB = `vec-it-b-${Date.now()}`;
    const recordA = {
      teamId: 'team-a',
      datasetId,
      collectionId,
      dataId: idA,
      indexId: idA,
      indexVersion: 'bge-m3:1536:v1',
      vector: unitVector(0),
    };
    const recordB = {
      teamId: 'team-b',
      datasetId,
      collectionId,
      dataId: idB,
      indexId: idB,
      indexVersion: 'bge-m3:1536:v1',
      vector: unitVector(1),
    };

    expect((await controller.insert({ records: [recordA], options }, contextA)).inserted).toBe(1);
    expect((await controller.insert({ records: [recordA], options }, contextA)).inserted).toBe(1);
    expect((await controller.insert({ records: [recordB], options }, contextB)).inserted).toBe(1);

    const recall = await controller.embRecall(
      {
        teamId: 'team-a',
        datasetId,
        collectionId,
        vector: unitVector(0),
        indexVersion: 'bge-m3:1536:v1',
        limit: 5,
        options,
      },
      contextA,
    );
    expect(recall.map((hit) => hit.dataId)).toEqual([idA]);
    expect(recall[0]?.score).toBeCloseTo(1, 5);

    expect(
      await controller.getVectorCount(
        { teamId: 'team-a', datasetId, collectionId, options },
        contextA,
      ),
    ).toBe(1);
    expect(
      await controller.getVectorCount(
        { teamId: 'team-b', datasetId, collectionId, options },
        contextB,
      ),
    ).toBe(1);

    const timeScoped = await controller.getVectorDataByTime(
      {
        teamId: 'team-a',
        datasetId,
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
        options,
      },
      contextA,
    );
    expect(timeScoped.map((record) => record.dataId)).toEqual([idA]);
    expect(timeScoped[0]?.vector).toHaveLength(PGVECTOR_DIMENSION);

    await expect(
      controller.getVectorDataByTime(
        {
          teamId: 'team-a',
          datasetId,
          from: new Date(Date.now() + 60_000).toISOString(),
          to: new Date(Date.now() - 60_000).toISOString(),
          options,
        },
        contextA,
      ),
    ).rejects.toMatchObject({ error: { code: 501050 } });

    expect((await controller.delete({ datasetId, collectionId, options }, contextA)).deleted).toBe(
      1,
    );
    expect(
      await controller.getVectorCount(
        { teamId: 'team-a', datasetId, collectionId, options },
        contextA,
      ),
    ).toBe(0);
    expect(
      await controller.getVectorCount(
        { teamId: 'team-b', datasetId, collectionId, options },
        contextB,
      ),
    ).toBe(1);
  });

  it('maps an unreachable pgvector instance to 501014 instead of faking success', async () => {
    const brokenPool = new Pool({
      connectionString: 'postgresql://kb:kb_dev_password@127.0.0.1:59999/kb',
    });
    const broken = createVectorControllerAdapter(brokenPool);
    try {
      await expect(
        broken.insert(
          {
            records: [
              {
                teamId: 'team-a',
                datasetId,
                collectionId,
                dataId: 'vec-it-broken',
                indexId: 'vec-it-broken',
                indexVersion: 'bge-m3:1536:v1',
                vector: unitVector(0),
              },
            ],
            options,
          },
          contextA,
        ),
      ).rejects.toMatchObject({ error: { code: 501014, params: { store: 'pgvector' } } });
    } finally {
      await brokenPool.end();
    }
  });
});
