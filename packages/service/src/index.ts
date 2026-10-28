/**
 * @kb/service public surface for the knowledge architecture baseline.
 * Only native knowledge modules and canonical persistence are exported here.
 */
export const PACKAGE_NAME = '@kb/service' as const;

export { loadKnowledgeRuntimeConfig } from './shared/config/knowledge-runtime-config';
export { loadS5AiproxyConfig } from './shared/config/s5-aiproxy-config';
export { loadS5RuntimeEnvironment } from './shared/config/s5-runtime-env';
export type {
  KnowledgeMockAuthConfig,
  KnowledgeRuntimeConfig,
} from './shared/config/knowledge-runtime-config';
export { resolveSecretRef } from './shared/config/secret-ref';
export { loadS7CitationConfig } from './shared/config/s7-citation-config';
export type { S7CitationConfig } from './shared/config/s7-citation-config';
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
export { KnowledgeAuditRepository, safeAuditDiff } from './shared/persistence/knowledge/audit';
export type { KnowledgeAuditInput } from './shared/persistence/knowledge/audit';
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
  stableKnowledgeVectorId,
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
  S04IngestionApplication,
  FixtureScopedAuthPort,
  FixtureQuotaGatePort,
  KnowledgeAccessRepository,
  KnowledgeCatalogRepository,
  KnowledgeConnectorRepository,
  KnowledgeCredentialCipher,
  KnowledgeImportRepository,
  KnowledgeIngestionContentAdapter,
  KnowledgeUrlImportAdapter,
  CustomApiLibraryClient,
  FeishuConnectorClient,
  YuqueConnectorClient,
  DingtalkConnectorClient,
  FileApplication,
  KnowledgeJobRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeFullTextRepository,
  S6ProcessingRepository,
  KnowledgeObjectRefRepository,
  KnowledgeArchiveRepository,
  ObjectLifecycleService,
  SourceFileApplication,
  KnowledgeTagRepository,
  KnowledgeReferenceRepository,
  ReferenceApplication,
  MockReferenceRegistryAdapter,
  isS04Operation,
  S5AiproxyCatalogAdapter,
  S5MockModelCatalog,
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
  S5MockAiproxyTransport,
  S5KeyedSemaphore,
  S5ModelApplication,
  S5ModelBindingApplication,
  S5ModelGateway,
  createS5ModelGateway,
  S5UsageRepository,
  S5ModelBindingRepository,
  S5ArtifactRepository,
  S5ProcessingApplication,
  S06ProcessingApplication,
  KnowledgeConnectorSyncApplication,
  S06JobApplication,
  S06_OPERATION_IDS,
  isS06Operation,
  S7SearchOperationApplication,
  S7_OPERATION_IDS,
  isS7Operation,
  S7SearchApplication,
  S7CitationApplication,
  S7SearchAuthorizationAdapter,
  S7FullTextSearchAdapter,
  S7ModelGatewaySearchAdapter,
  S7VectorSearchAdapter,
  S7SearchPipelineFactory,
  S7CitationSigner,
  S7CitationRepository,
  S7FilterSourceRepository,
  S7SearchRepository,
  S5QaPipelineAdapter,
  S5OcrApplication,
  S5OcrHttpAdapter,
  AxiosS5OcrHttpTransport,
  S5OcrCredentialProfileAdapter,
  S5RemoteAssetAdapter,
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
  ArchiveSafetyInput,
  ArchiveSafetyPort,
  ArchiveSafetyResult,
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
  S04IngestionDependencies,
  ConnectorRepositoryPort,
  CustomApiClientPort,
  ImportKind,
  ImportPlanningPort,
  ImportSourceDraft,
  ImportSubmissionCommand,
  ImportSubmissionPort,
  ImportSubmissionResult,
  IngestionContentPort,
  QuotaGatePort,
  ScopedAuthPort,
  UrlImportAdapterPort,
  S5ModelGatewayPort,
  S5UsageRecorderPort,
  S5OcrAssetSinkPort,
  S5OcrHttpTransportPort,
  S5ProviderUsageRecorderPort,
  S5ArtifactMaterializeResult,
  S5ArtifactStorePort,
  S5ObjectArtifactRef,
  S5ProcessingResult,
  S6ProcessingPort,
  S7BoundModel,
  S7CitationIssueInput,
  S7ResolvedModels,
  S7SearchApplicationDependencies,
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
