import type { Pool } from 'pg';

/** 设计文档 10.16 / ADR-002：固定向量维度。 */
export const PGVECTOR_DIMENSION = 1536;

/**
 * 与 deploy/init/pgvector.sql 语义逐字一致的冻结 DDL；
 * 重复执行不改变已有表与索引定义。
 */
export const PGVECTOR_DDL_STATEMENTS: readonly string[] = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS modeldata (
  id             TEXT PRIMARY KEY,
  vector         VECTOR(${PGVECTOR_DIMENSION}),
  team_id        TEXT NOT NULL,
  dataset_id     TEXT NOT NULL,
  collection_id  TEXT NOT NULL,
  index_version  TEXT NOT NULL,
  createtime     TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `CREATE INDEX IF NOT EXISTS modeldata_vector_hnsw
  ON modeldata USING hnsw (vector vector_cosine_ops)
  WITH (m = 32, ef_construction = 128)`,
  `CREATE INDEX IF NOT EXISTS modeldata_team_dataset_collection_idx
  ON modeldata (team_id, dataset_id, collection_id, index_version)`,
  `CREATE INDEX IF NOT EXISTS modeldata_createtime_idx
  ON modeldata (createtime)`,
];

export async function ensurePgvectorDdl(pool: Pool): Promise<void> {
  for (const statement of PGVECTOR_DDL_STATEMENTS) {
    await pool.query(statement);
  }
}
