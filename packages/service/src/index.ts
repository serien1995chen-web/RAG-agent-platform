/**
 * @kb/service public surface for the knowledge architecture baseline.
 * Only native knowledge modules and canonical persistence are exported here.
 */
export const PACKAGE_NAME = '@kb/service' as const;

export { loadKnowledgeRuntimeConfig } from './shared/config/knowledge-runtime-config';
export {
  canonicalJson,
  loadS10PricingProfile,
  loadS10QuotaProfile,
} from './shared/config/s10-profiles';
export { loadS5AiproxyConfig } from './shared/config/s5-aiproxy-config';
export { loadS5RuntimeEnvironment } from './shared/config/s5-runtime-env';
export type {
  KnowledgeMockAuthConfig,
  KnowledgeRuntimeConfig,
} from './shared/config/knowledge-runtime-config';
export type { S10PricingProfile, S10QuotaProfile } from './shared/config/s10-profiles';
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
  S10ApiKeyRepository,
  S10OperationsRepository,
  KnowledgeQuotaGate,
  KnowledgeScopedAuthAdapter,
  KnowledgeSharedUsageAdapter,
  S10ObjectInventoryAdapter,
  S10OpsWorkerApplication,
  S10StatusApplication,
  S10StatusProbesAdapter,
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
  S8CaptionApplication,
  S8ContentEnhancementApplication,
  S8DeepSearchApplication,
  S8DeepSearchRepository,
  S8FileTicketAdapter,
  S8ImageIndexRepository,
  S8ImageSearchApplication,
  S8ModelResolver,
  S8SearchOperationApplication,
  S8_OPERATION_IDS,
  isS8Operation,
  S09SynonymOperationApplication,
  S09SynonymApplication,
  S09QueryExpansionApplication,
  S09RebuildApplication,
  S09SynonymQueryExpansionAdapter,
  S09S6RebuildIndexAdapter,
  S09SynonymS6Adapter,
  KnowledgeSynonymRepository,
  S09_SYNONYM_OPERATION_IDS,
  isS09SynonymOperation,
  S10_OPERATION_IDS,
  S10OperationApplication,
  isS10Operation,
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
  S09QueryExpansionPort,
  S09QueryExpansionResult,
  S09S6RebuildPort,
  S09SynonymConfigView,
  S09SynonymRepositoryPort,
  S10ApiKeyAuthRecord,
  S10ApiKeyRecord,
  S10ApiKeyRepositoryPort,
  S10ApiKeyScope,
  S10ApiKeyStatus,
  S10OpsResult,
  S10OpsWorkerDependencies,
  S10ProbeState,
  S10StatusProbePort,
  S10StatusView,
  S10VerificationStatus,
} from './modules/knowledge';
export {
  KnowledgeApiKeyAuthProvider,
  KnowledgeCompositeAuthProvider,
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
