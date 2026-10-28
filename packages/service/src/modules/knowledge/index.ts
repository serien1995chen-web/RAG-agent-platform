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
