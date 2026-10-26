export { KnowledgeApplication } from './application/knowledge.application';
export { FileApplication } from './application/file.application';
export { ObjectLifecycleService } from './application/object-lifecycle';
export { SourceFileApplication } from './application/source-preview';
export {
  FixtureScopedAuthPort,
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
export { createConsoleSession, verifyConsoleSession } from './adapter/console-session';
export type { ConsoleSessionPayload } from './adapter/console-session';
