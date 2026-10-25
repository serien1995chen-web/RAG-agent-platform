export { KnowledgeApplication } from './application/knowledge.application';
export { FileApplication } from './application/file.application';
export { ObjectLifecycleService } from './application/object-lifecycle';
export { SourceFileApplication } from './application/source-preview';
export type { ObjectCleanupResult } from './application/object-lifecycle';
export type {
  KnowledgeOperationInput,
  KnowledgeOperationResult,
} from './application/knowledge.application';
export type {
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
export { KnowledgeObjectRefRepository } from './repository/object-ref.repository';
export { KnowledgeArchiveRepository } from './repository/archive.repository';
export { KnowledgeTagRepository } from './repository/tag.repository';
export {
  AiproxyMockAdapter,
  ConnectorMockAdapter,
  EXTERNAL_UNVERIFIED,
  OcrMockAdapter,
  classifyExternalFailure,
  redactExternalValue,
} from './adapter/external-providers';
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
