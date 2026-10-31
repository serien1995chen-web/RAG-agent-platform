export { KnowledgeApplication } from './application/knowledge.application';
export { FileApplication } from './application/file.application';
export { ObjectLifecycleService } from './application/object-lifecycle';
export { SourceFileApplication } from './application/source-preview';
export {
  FixtureScopedAuthPort,
  FixtureQuotaGatePort,
  S04IngestionApplication,
  isS04Operation,
} from './application/operations/s04-ingestion';
export type { S04IngestionDependencies } from './application/operations/s04-ingestion';
export type {
  CloudConnectorProvider,
  CloudProviderClientPort,
  ConnectorProvider,
  ConnectorRepositoryPort,
  CustomApiClientPort,
  ImportKind,
  ImportPlanningPort,
  ImportObjectDraft,
  ImportSourceDraft,
  ImportSubmissionCommand,
  ImportSubmissionPort,
  ImportSubmissionResult,
  IngestionObjectStorePort,
  IngestionContentPort,
  QuotaGatePort,
  ProviderCatalogResult,
  ProviderContent,
  ScopedAuthPort,
  UrlImportAdapterPort,
  UrlSnapshot,
} from './application/ingestion.ports';
export type { ObjectCleanupResult } from './application/object-lifecycle';
export type {
  KnowledgeOperationInput,
  KnowledgeOperationResult,
} from './application/knowledge.application';
export type {
  ArchiveSafetyInput,
  ArchiveSafetyPort,
  ArchiveSafetyResult,
  ObjectRefRepositoryPort,
  ObjectRefView,
  ObjectStoreApplicationPort,
  FileBinaryResult,
  FileTicketClaims,
  FileTicketDisposition,
  FileTicketPort,
  UploadSessionView,
} from './application/ports';
export {
  JOB_STATES,
  MAX_DIRECTORY_DEPTH,
  PERMISSION_LEVEL,
  assertDirectoryDepth,
  assertJobTransition,
  assertResourceName,
  assertSameKnowledgeSpace,
  canTransitionJob,
  permissionAllows,
  strongerPermission,
  transitionSourcePermission,
} from './domain';
export type {
  AclResourceType,
  JobState,
  PermissionLevel,
  SourcePermissionAction,
  SourcePermissionState,
} from './domain';
export { KnowledgeAccessRepository } from './repository/access.repository';
export { S10ApiKeyRepository } from './repository/s10-api-key.repository';
export { S10OperationsRepository } from './repository/s10-operations.repository';
export { KnowledgeQuotaGate } from './adapter/s10-quota.adapter';
export { KnowledgeScopedAuthAdapter } from './adapter/s10-scoped-auth.adapter';
export { KnowledgeSharedUsageAdapter } from './adapter/s10-shared-usage.adapter';
export {
  S10ObjectInventoryAdapter,
  isObjectHeadNotFound,
} from './adapter/s10-object-inventory.adapter';
export { S10OpsWorkerApplication } from './application/s10-ops-worker.application';
export type {
  S10OpsResult,
  S10OpsWorkerDependencies,
} from './application/s10-ops-worker.application';
export { S10StatusApplication } from './application/s10-status.application';
export type {
  S10ProbeState,
  S10StatusProbePort,
  S10StatusView,
  S10VerificationStatus,
} from './application/s10-status.application';
export { S10StatusProbesAdapter } from './adapter/s10-status-probes.adapter';
export { KnowledgeCatalogRepository } from './repository/catalog.repository';
export type {
  CreateDirectoryInput,
  CreateSegmentInput,
  CreateSourceInput,
  CreateSpaceInput,
} from './repository/catalog.repository';
export { KnowledgeJobRepository } from './repository/job.repository';
export { KnowledgeJobExecutionRepository } from './repository/job-execution.repository';
export { KnowledgeSegmentIndexRepository } from './repository/segment-index.repository';
export { KnowledgeFullTextRepository } from './repository/fulltext.repository';
export { S6ProcessingRepository } from './repository/s06-processing.repository';
export { KnowledgeImportRepository } from './repository/import.repository';
export { KnowledgeConnectorRepository } from './repository/connector.repository';
export { KnowledgeObjectRefRepository } from './repository/object-ref.repository';
export { KnowledgeArchiveRepository } from './repository/archive.repository';
export { KnowledgeTagRepository } from './repository/tag.repository';
export { KnowledgeReferenceRepository } from './repository/reference.repository';
export { ReferenceApplication } from './application/reference.application';
export { KnowledgeCredentialCipher } from './adapter/credential-cipher';
export { KnowledgeIngestionContentAdapter } from './adapter/ingestion-content';
export { KnowledgeUrlImportAdapter } from './adapter/url-import';
export { CustomApiLibraryClient } from './adapter/api-library';
export { FeishuConnectorClient } from './adapter/connectors/feishu';
export { YuqueConnectorClient } from './adapter/connectors/yuque';
export { DingtalkConnectorClient } from './adapter/connectors/dingtalk';
export {
  AiproxyMockAdapter,
  ConnectorMockAdapter,
  EXTERNAL_UNVERIFIED,
  OcrMockAdapter,
  classifyExternalFailure,
  redactExternalValue,
} from './adapter/external-providers';
export { MockReferenceRegistryAdapter } from './adapter/reference-registry.mock';
export { S5AiproxyCatalogAdapter, S5MockModelCatalog } from './adapter/s5-aiproxy-catalog.adapter';
export {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
  S5MockAiproxyTransport,
} from './adapter/s5-aiproxy-http.adapter';
export { S5KeyedSemaphore } from './adapter/s5-keyed-semaphore';
export { S5OcrHttpAdapter, AxiosS5OcrHttpTransport } from './adapter/s5-ocr-http.adapter';
export { S5OcrCredentialProfileAdapter } from './adapter/s5-ocr-profile.adapter';
export { S5RemoteAssetAdapter } from './adapter/s5-remote-asset.adapter';
export { S5ModelApplication } from './application/s5-model.application';
export { S5ModelBindingApplication } from './application/s5-model-binding.application';
export { S5ModelGateway, createS5ModelGateway } from './application/s5-model-gateway';
export { S5ProcessingApplication } from './application/s5-processing.application';
export { S8CaptionApplication } from './application/s8-caption.application';
export { S8ContentEnhancementApplication } from './application/s8-content-enhancement.application';
export { S8DeepSearchApplication } from './application/s8-deep-search.application';
export { S8ModelResolver } from './adapter/s8-model-resolver';
export { S8FileTicketAdapter } from './adapter/s8-file-ticket.adapter';
export { S8ImageIndexRepository } from './repository/s8-image-index.repository';
export { S8DeepSearchRepository } from './repository/s8-deep-search.repository';
export type {
  S8CaptionDependencies,
  S8CaptionExecutorPort,
  S8ImageIndexStorePort,
  S8ImageModelResolverPort,
} from './application/s8-image-deep.ports';
export { S06ProcessingApplication } from './application/s06-processing.application';
export type { S6ProcessingPort } from './application/s06-processing.application';
export { KnowledgeConnectorSyncApplication } from './application/s06-connector-sync.application';
export type {
  ConnectorChangeSetApplyInput,
  ConnectorChangeSetApplyResult,
} from './application/s06-connector-sync.application';
export type {
  S6ArtifactPort,
  S6ConnectorSyncPort,
  S6ConnectorSyncResult,
  S6ExternalProcessingPort,
  S6FullTextPort,
  S6JobPort,
  S6ProcessingStorePort,
  S6SegmentRecord,
  S6SourceRecord,
  S6VectorPort,
} from './application/s06-processing-ports';
export {
  S06JobApplication,
  S06_OPERATION_IDS,
  isS06Operation,
} from './application/operations/s06-jobs';
export {
  S7SearchOperationApplication,
  S7_OPERATION_IDS,
  isS7Operation,
} from './application/s7-search-operation.application';
export { S7SearchApplication } from './application/s7-search.application';
export {
  S8SearchOperationApplication,
  S8_OPERATION_IDS,
  isS8Operation,
} from './application/s8-search-operation.application';
export { S8ImageSearchApplication } from './application/s8-image-search.application';
export { S7CitationApplication } from './application/s7-citation.application';
export type {
  S7BoundModel,
  S7CitationIssueInput,
  S7ResolvedModels,
  S7SearchApplicationDependencies,
} from './application/s7-search.ports';
export { S7SearchAuthorizationAdapter } from './adapter/s7-search-authorization.adapter';
export { S7FullTextSearchAdapter } from './adapter/s7-fulltext-search.adapter';
export { S7ModelGatewaySearchAdapter } from './adapter/s7-model-gateway-search.adapter';
export { S7VectorSearchAdapter } from './adapter/s7-vector-search.adapter';
export { S7SearchPipelineFactory } from './adapter/s7-search-pipeline.factory';
export {
  S09SynonymOperationApplication,
  S09_SYNONYM_OPERATION_IDS,
  isS09SynonymOperation,
} from './application/operations/s09-synonyms';
export { S09SynonymApplication } from './application/s09-synonym.application';
export { S09QueryExpansionApplication } from './application/s09-query-expansion.application';
export { S09RebuildApplication } from './application/s09-rebuild.application';
export { S09SynonymQueryExpansionAdapter } from './adapter/s09-synonym-query-expansion.adapter';
export { S09S6RebuildIndexAdapter, S09SynonymS6Adapter } from './adapter/s09-synonym-s6.adapter';
export { KnowledgeSynonymRepository } from './repository/s09-synonym.repository';
export type {
  S09QueryExpansionPort,
  S09QueryExpansionResult,
  S09S6RebuildPort,
  S09SynonymConfigView,
  S09SynonymRepositoryPort,
} from './application/s09-synonym.ports';
export { S7CitationSigner } from './adapter/s7-citation-signer';
export { S7CitationRepository } from './repository/s7-citation.repository';
export { S7FilterSourceRepository } from './repository/s7-filter-source.repository';
export { S7SearchRepository } from './repository/s7-search.repository';
export { S5QaPipelineAdapter } from './application/s5-qa-pipeline';
export { S5OcrApplication } from './application/s5-ocr.application';
export { S5ArtifactRepository } from './repository/s5-artifact.repository';
export { S5ModelBindingRepository } from './repository/s5-model-binding.repository';
export { S5UsageRepository } from './repository/s5-usage.repository';
export { projectFullText } from './adapter/s06-jieba.tokenizer';
export type {
  FullTextProjectionInput,
  FullTextProjectionOutput,
} from './adapter/s06-jieba.tokenizer';
export { KnowledgeAuditRepository, safeAuditDiff } from '../../shared/persistence/knowledge/audit';
export {
  S10_OPERATION_IDS,
  S10OperationApplication,
  isS10Operation,
} from './application/operations/s10-operations';
export {
  S10_API_KEY_SCOPES,
  defaultApiKeyExpiry,
  effectiveApiKeyStatus,
  generateApiKeySecret,
  hashApiKeySecret,
  isApiKeyUsable,
  isWorkspaceWideApiKey,
  matchesApiKeySecretHash,
  rotateApiKeyState,
  validateApiKeyScopes,
} from './domain/s10-api-key';
export type {
  S10ApiKeyAuthRecord,
  S10ApiKeyRecord,
  S10ApiKeyScope,
  S10ApiKeyStatus,
} from './domain/s10-api-key';
export type { S10ApiKeyRepositoryPort } from './application/s10-operations.ports';
export type {
  AiproxyProviderConfig,
  ConnectorMockResult,
  ConnectorProviderConfig,
  ExternalModelDescriptor,
  ExternalProviderConfig,
  ExternalProviderError,
  OcrMockResult,
  OcrProviderConfig,
} from './adapter/external-providers';
export type { S5ModelGatewayPort, S5UsageRecorderPort } from './application/s5-model-gateway.port';
export type {
  S5OcrAssetSinkPort,
  S5OcrHttpTransportPort,
  S5ProviderUsageRecorderPort,
} from './application/s5-ocr-ports';
export type {
  S5ArtifactMaterializeResult,
  S5ArtifactStorePort,
  S5ObjectArtifactRef,
  S5ProcessingResult,
} from './application/s5-processing-ports';
export { createConsoleSession, verifyConsoleSession } from './adapter/console-session';
export type { ConsoleSessionPayload } from './adapter/console-session';
