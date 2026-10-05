import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString =
  process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
const ddlPath = resolve(import.meta.dirname, '../../../../deploy/init/pgvector.sql');
const ddl = readFileSync(ddlPath, 'utf8');
const zeroVector = `[${Array.from({ length: 1536 }, () => '0').join(',')}]`;

const client = new Client({ connectionString });

beforeAll(async () => {
  await client.connect();
  await client.query(ddl);
  await client.query(ddl); // 幂等：重复执行不改变定义
});

afterAll(async () => {
  await client.end();
});

describe('pgvector DDL (10.16 / ADR-002)', () => {
  it('creates modeldata, HNSW and filter indexes idempotently', async () => {
    const table = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'modeldata' ORDER BY ordinal_position",
    );
    expect(table.rows.map((row) => row.column_name)).toEqual([
      'id',
      'vector',
      'team_id',
      'dataset_id',
      'collection_id',
      'index_version',
      'createtime',
    ]);

    const indexes = await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'modeldata' ORDER BY indexname",
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('modeldata_vector_hnsw');
    expect(names).toContain('modeldata_team_dataset_collection_idx');
    expect(names).toContain('modeldata_createtime_idx');
  });

  it('stores and recalls vectors under the full tenant predicate', async () => {
    const id = `kb-test-${Date.now()}`;
    await client.query(
      `INSERT INTO modeldata (id, vector, team_id, dataset_id, collection_id, index_version)
       VALUES ($1, $2::vector, 'team-a', 'ds-1', 'col-1', 'bge-m3:1536:v1')`,
      [id, zeroVector],
    );

    const hit = await client.query(
      `SELECT id FROM modeldata
       WHERE team_id = $1 AND dataset_id = $2 AND collection_id = $3 AND index_version = $4
       ORDER BY vector <=> $5::vector LIMIT 1`,
      ['team-a', 'ds-1', 'col-1', 'bge-m3:1536:v1', zeroVector],
    );
    expect(hit.rows[0]?.id).toBe(id);

    const crossTenant = await client.query(
      `SELECT id FROM modeldata WHERE team_id = $1 AND dataset_id = $2 AND collection_id = $3`,
      ['team-b', 'ds-1', 'col-1'],
    );
    expect(crossTenant.rowCount).toBe(0);

    await client.query('DELETE FROM modeldata WHERE id = $1', [id]);
  });
});
