/**
 * @kb/service public surface for the knowledge architecture baseline.
 * Only native knowledge modules and canonical persistence are exported here.
 */
export const PACKAGE_NAME = '@kb/service' as const;

export { loadKnowledgeRuntimeConfig } from './shared/config/knowledge-runtime-config';
export type {
  KnowledgeMockAuthConfig,
  KnowledgeRuntimeConfig,
} from './shared/config/knowledge-runtime-config';
export { resolveSecretRef } from './shared/config/secret-ref';
export {
  createKnowledgeConnections,
  createKnowledgeMongoConnection,
} from './shared/runtime/knowledge-connections';
export type { KnowledgeConnections } from './shared/runtime/knowledge-connections';

export {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from './shared/persistence/schemas/knowledge-index';
export type {
  KnowledgeRegisteredModels,
  KnowledgeSchemaEntry,
} from './shared/persistence/schemas/knowledge-index';
export { workspaceCasUpdate } from './shared/persistence/knowledge/cas';
export {
  createKnowledgeOutboxEvent,
  KnowledgeOutboxDispatcher,
} from './shared/persistence/knowledge/outbox';
export type { CreateKnowledgeOutboxEventInput } from './shared/persistence/knowledge/outbox';
export {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
  workspaceFilter,
  workspaceScopedModel,
} from './shared/persistence/knowledge/tenant';
export type { TenantContext, WorkspaceFields } from './shared/persistence/knowledge/tenant';
export {
  KNOWLEDGE_VECTOR_PROFILES,
  PGVECTOR_DDL_STATEMENTS,
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
  vectorProfileOfDimension,
} from './shared/persistence/pgvector';
export type {
  KnowledgeVectorHit,
  KnowledgeVectorRecordInput,
  KnowledgeVectorSearchInput,
  VectorDimension,
  VectorProfile,
  VectorStorageType,
} from './shared/persistence/pgvector';
export { withMongoTransaction } from './shared/persistence/with-mongo-transaction';

export {
  KnowledgeApplication,
  KnowledgeAccessRepository,
  KnowledgeCatalogRepository,
  FileApplication,
  KnowledgeJobRepository,
  KnowledgeObjectRefRepository,
  KnowledgeArchiveRepository,
  ObjectLifecycleService,
  SourceFileApplication,
  KnowledgeTagRepository,
} from './modules/knowledge';
export type {
  AclResourceType,
  CreateDirectoryInput,
  CreateSegmentInput,
  CreateSourceInput,
  CreateSpaceInput,
  JobState,
  KnowledgeOperationInput,
  KnowledgeOperationResult,
  ObjectRefRepositoryPort,
  ObjectRefView,
  ObjectStoreApplicationPort,
  ObjectCleanupResult,
  FileBinaryResult,
  FileTicketClaims,
  FileTicketDisposition,
  FileTicketPort,
  UploadSessionView,
  PermissionLevel,
  SourcePermissionAction,
  SourcePermissionState,
} from './modules/knowledge';
export {
  KnowledgeMockAuthProvider,
  tenantContextOf,
} from './modules/knowledge/adapter/auth.adapter';
export type {
  KnowledgeAuthInput,
  KnowledgeSubject,
} from './modules/knowledge/adapter/auth.adapter';
export { RedisKnowledgeRateLimiter } from './modules/knowledge/adapter/rate-limit.adapter';
export type { KnowledgeRateLimitDecision } from './modules/knowledge/adapter/rate-limit.adapter';
export {
  createConsoleSession,
  verifyConsoleSession,
} from './modules/knowledge/adapter/console-session';
export type { ConsoleSessionPayload } from './modules/knowledge/adapter/console-session';
