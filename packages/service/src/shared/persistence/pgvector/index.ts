export {
  KNOWLEDGE_VECTOR_PROFILES,
  PGVECTOR_DDL_STATEMENTS,
  ensurePgvectorDdl,
  vectorProfileOfDimension,
} from './ddl';
export type { VectorDimension, VectorProfile, VectorStorageType } from './ddl';
export { KnowledgeVectorRepository } from './vector-repository';
export type {
  KnowledgeVectorHit,
  KnowledgeVectorRecordInput,
  KnowledgeVectorSearchInput,
} from './vector-repository';
