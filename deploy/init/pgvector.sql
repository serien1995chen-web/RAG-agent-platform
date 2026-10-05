-- 设计文档 10.16 / ADR-002 冻结 DDL。必须幂等：重复启动不改变已有索引定义。
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS modeldata (
  id             TEXT PRIMARY KEY,
  vector         VECTOR(1536),
  team_id        TEXT NOT NULL,
  dataset_id     TEXT NOT NULL,
  collection_id  TEXT NOT NULL,
  index_version  TEXT NOT NULL,
  createtime     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS modeldata_vector_hnsw
  ON modeldata USING hnsw (vector vector_cosine_ops)
  WITH (m = 32, ef_construction = 128);

CREATE INDEX IF NOT EXISTS modeldata_team_dataset_collection_idx
  ON modeldata (team_id, dataset_id, collection_id, index_version);

CREATE INDEX IF NOT EXISTS modeldata_createtime_idx
  ON modeldata (createtime);
