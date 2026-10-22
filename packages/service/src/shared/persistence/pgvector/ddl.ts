import type { Pool } from 'pg';

export type VectorDimension = 768 | 1024 | 1536 | 3072;
export type VectorStorageType = 'vector' | 'halfvec';

export interface VectorProfile {
  profileId: string;
  dimension: VectorDimension;
  storageType: VectorStorageType;
  tableName: string;
  distanceMetric: 'cosine';
  opclass: 'vector_cosine_ops' | 'halfvec_cosine_ops';
}

export const KNOWLEDGE_VECTOR_PROFILES: readonly VectorProfile[] = [
  {
    profileId: 'kb-vector-768',
    dimension: 768,
    storageType: 'vector',
    tableName: 'knowledge_segment_vectors_768',
    distanceMetric: 'cosine',
    opclass: 'vector_cosine_ops',
  },
  {
    profileId: 'kb-vector-1024',
    dimension: 1024,
    storageType: 'vector',
    tableName: 'knowledge_segment_vectors_1024',
    distanceMetric: 'cosine',
    opclass: 'vector_cosine_ops',
  },
  {
    profileId: 'kb-vector-1536',
    dimension: 1536,
    storageType: 'vector',
    tableName: 'knowledge_segment_vectors_1536',
    distanceMetric: 'cosine',
    opclass: 'vector_cosine_ops',
  },
  {
    profileId: 'kb-vector-3072',
    dimension: 3072,
    storageType: 'halfvec',
    tableName: 'knowledge_segment_vectors_3072',
    distanceMetric: 'cosine',
    opclass: 'halfvec_cosine_ops',
  },
];

export const PGVECTOR_DDL_STATEMENTS: readonly string[] = [
  'CREATE EXTENSION IF NOT EXISTS vector',
  `CREATE TABLE IF NOT EXISTS knowledge_vector_profiles (
  profile_id text PRIMARY KEY,
  embedding_model_id text NOT NULL,
  dimension integer NOT NULL CHECK (dimension IN (768, 1024, 1536, 3072)),
  storage_type text NOT NULL CHECK (storage_type IN ('vector', 'halfvec')),
  table_name text NOT NULL UNIQUE,
  distance_metric text NOT NULL DEFAULT 'cosine',
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (dimension = 3072 AND storage_type = 'halfvec')
    OR (dimension IN (768, 1024, 1536) AND storage_type = 'vector')
  )
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_segment_vectors_768 (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_space_id text NOT NULL,
  source_id text NOT NULL,
  segment_id text NOT NULL,
  index_id text NOT NULL,
  embedding_model_id text NOT NULL,
  embedding vector(768) NOT NULL,
  norm double precision NOT NULL CHECK (norm BETWEEN 0.990001 AND 1.01),
  search_enabled boolean NOT NULL DEFAULT true,
  content_hash text NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id,
    knowledge_space_id,
    segment_id,
    index_id,
    embedding_model_id,
    version
  )
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_segment_vectors_1024 (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_space_id text NOT NULL,
  source_id text NOT NULL,
  segment_id text NOT NULL,
  index_id text NOT NULL,
  embedding_model_id text NOT NULL,
  embedding vector(1024) NOT NULL,
  norm double precision NOT NULL CHECK (norm BETWEEN 0.990001 AND 1.01),
  search_enabled boolean NOT NULL DEFAULT true,
  content_hash text NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id, knowledge_space_id, segment_id, index_id, embedding_model_id, version
  )
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_segment_vectors_1536 (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_space_id text NOT NULL,
  source_id text NOT NULL,
  segment_id text NOT NULL,
  index_id text NOT NULL,
  embedding_model_id text NOT NULL,
  embedding vector(1536) NOT NULL,
  norm double precision NOT NULL CHECK (norm BETWEEN 0.990001 AND 1.01),
  search_enabled boolean NOT NULL DEFAULT true,
  content_hash text NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id, knowledge_space_id, segment_id, index_id, embedding_model_id, version
  )
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_segment_vectors_3072 (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  knowledge_space_id text NOT NULL,
  source_id text NOT NULL,
  segment_id text NOT NULL,
  index_id text NOT NULL,
  embedding_model_id text NOT NULL,
  embedding halfvec(3072) NOT NULL,
  norm double precision NOT NULL CHECK (norm BETWEEN 0.990001 AND 1.01),
  search_enabled boolean NOT NULL DEFAULT true,
  content_hash text NOT NULL,
  version bigint NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    workspace_id, knowledge_space_id, segment_id, index_id, embedding_model_id, version
  )
)`,
  `CREATE INDEX IF NOT EXISTS ix_vec768_scope
  ON knowledge_segment_vectors_768 (
    workspace_id, knowledge_space_id, source_id, search_enabled, deleted_at
  )`,
  `CREATE INDEX IF NOT EXISTS ix_vec768_segment
  ON knowledge_segment_vectors_768 (workspace_id, segment_id)`,
  `CREATE INDEX IF NOT EXISTS ix_vec768_hnsw
  ON knowledge_segment_vectors_768
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)`,
  `CREATE INDEX IF NOT EXISTS ix_vec1024_scope
  ON knowledge_segment_vectors_1024 (
    workspace_id, knowledge_space_id, source_id, search_enabled, deleted_at
  )`,
  `CREATE INDEX IF NOT EXISTS ix_vec1024_segment
  ON knowledge_segment_vectors_1024 (workspace_id, segment_id)`,
  `CREATE INDEX IF NOT EXISTS ix_vec1024_hnsw
  ON knowledge_segment_vectors_1024
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)`,
  `CREATE INDEX IF NOT EXISTS ix_vec1536_scope
  ON knowledge_segment_vectors_1536 (
    workspace_id, knowledge_space_id, source_id, search_enabled, deleted_at
  )`,
  `CREATE INDEX IF NOT EXISTS ix_vec1536_segment
  ON knowledge_segment_vectors_1536 (workspace_id, segment_id)`,
  `CREATE INDEX IF NOT EXISTS ix_vec1536_hnsw
  ON knowledge_segment_vectors_1536
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)`,
  `CREATE INDEX IF NOT EXISTS ix_vec3072_scope
  ON knowledge_segment_vectors_3072 (
    workspace_id, knowledge_space_id, source_id, search_enabled, deleted_at
  )`,
  `CREATE INDEX IF NOT EXISTS ix_vec3072_segment
  ON knowledge_segment_vectors_3072 (workspace_id, segment_id)`,
  `CREATE INDEX IF NOT EXISTS ix_vec3072_hnsw
  ON knowledge_segment_vectors_3072
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)`,
  `INSERT INTO knowledge_vector_profiles (
  profile_id, embedding_model_id, dimension, storage_type, table_name, distance_metric, status
)
VALUES
  ('kb-vector-768', 'mock-embedding-768', 768, 'vector', 'knowledge_segment_vectors_768', 'cosine', 'active'),
  ('kb-vector-1024', 'mock-embedding-1024', 1024, 'vector', 'knowledge_segment_vectors_1024', 'cosine', 'active'),
  ('kb-vector-1536', 'mock-embedding-1536', 1536, 'vector', 'knowledge_segment_vectors_1536', 'cosine', 'active'),
  ('kb-vector-3072', 'mock-embedding-3072', 3072, 'halfvec', 'knowledge_segment_vectors_3072', 'cosine', 'active')
ON CONFLICT (profile_id) DO NOTHING`,
];

export function vectorProfileOfDimension(dimension: number): VectorProfile | undefined {
  return KNOWLEDGE_VECTOR_PROFILES.find((profile) => profile.dimension === dimension);
}

export async function ensurePgvectorDdl(pool: Pool): Promise<void> {
  for (const statement of PGVECTOR_DDL_STATEMENTS) {
    await pool.query(statement);
  }
}
