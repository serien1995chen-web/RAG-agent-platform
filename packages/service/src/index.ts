/**
 * @kb/service — 领域 / 应用 / 仓储 / 适配器 / 任务五层业务内核（CR-REF-02）。
 * 权威来源：设计文档 5.2、7.5、7.6、18.1、18.2。
 * 显式导出面，禁止 export *。
 */
export const PACKAGE_NAME = '@kb/service' as const;

export {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createSkeletonError,
  defineIndex,
  getDeclaredIndexes,
  listDeclaredIndexes,
  toApiResponse,
  validateTenantContext,
} from './shared/index';
export type {
  ApiError,
  ApiResponse,
  AuthType,
  CreateApiErrorInput,
  IndexDeclaration,
  PermissionContext,
  RequestContext,
  TenantContext,
} from './shared/index';

export { DEFAULT_PORT_IDS, createDefaultPorts, createUnimplementedPort } from './ports/index';
export type {
  AdminDatasetPort,
  ArchiveStatusPort,
  AuditPort,
  AuditRecord,
  AuthSubject,
  AuthSubjectProvider,
  BackupToolPort,
  CallerPermissionContext,
  CollectionRepository,
  CollectionSnapshot,
  CollaboratorPermission,
  DatasetEvent,
  DatasetEventPort,
  DatasetMetricsPort,
  DatasetNotificationPort,
  DatasetPermissionPort,
  DatasetSearchPort,
  DatasetSourceProvider,
  DatasetSyncPort,
  DegradationMode,
  DegradationPolicy,
  DeleteJobRepository,
  DeleteJobSnapshot,
  DeleteJobState,
  FailureQueryPort,
  FailureRecord,
  FeatureFlagProvider,
  FullTextHit,
  FullTextStore,
  HealthProbePort,
  ImageTaskResult,
  ImageTrainingProcessorPort,
  IndexDiff,
  JobDefinition,
  JobEnvelope,
  JobHandler,
  KnowledgeBaseRepository,
  KnowledgeBaseSnapshot,
  KnowledgeItemIndexValue,
  KnowledgeItemRepository,
  KnowledgeItemSnapshot,
  LoggerPort,
  MigrationRegistryPort,
  ModelCapability,
  ModelRegistryPort,
  MongoIndexManagerPort,
  Notification,
  NotificationEvent,
  NotifyPort,
  ObjectRef,
  ObjectStorePort,
  PageResult,
  PdfEnhanceProviderPort,
  PdfResult,
  PermissionSnapshotValue,
  PortCallOptions,
  ProbeResult,
  ProcessingJobRepository,
  ProcessingJobSnapshot,
  ProviderImageQuery,
  ReconcileResultPort,
  SBOMGeneratorPort,
  ServicePorts,
  SourceReadRequest,
  SourceReadResult,
  SyncResult,
  TaskEnvelope,
  TaskResult,
  TenantContextProvider,
  TenantQuotaProvider,
  TrainingProcessorPort,
  TransferDatasetOwnerPort,
  UpdateDatasetCollaboratorsPort,
  VectorController,
  VectorRecord,
  VectorSearchHit,
} from './ports/index';

export {
  KNOWLEDGE_BASE_INVARIANTS,
  KnowledgeBaseApplicationService,
  KNOWLEDGE_BASE_JOB_DEFINITIONS,
  createKnowledgeBaseAdapter,
  createKnowledgeBaseJobHandler,
  createKnowledgeBaseRepository,
  validateKnowledgeBase,
} from './modules/knowledge-base';
export type {
  KnowledgeBase,
  KnowledgeBaseJobHandler,
  KnowledgeBaseServiceDeps,
} from './modules/knowledge-base';

export {
  SOURCE_COLLECTION_INVARIANTS,
  SourceCollectionApplicationService,
  SOURCE_COLLECTION_JOB_DEFINITIONS,
  ImportSourceService,
  createSourceCollectionAdapter,
  createSourceCollectionJobHandler,
  createSourceCollectionRepository,
  validateSourceCollection,
} from './modules/collection';
export type {
  ImportSourceServiceDeps,
  SourceCollection,
  SourceCollectionJobHandler,
  SourceCollectionServiceDeps,
} from './modules/collection';

export {
  KNOWLEDGE_ITEM_INVARIANTS,
  KnowledgeItemApplicationService,
  KNOWLEDGE_ITEM_JOB_DEFINITIONS,
  InsertDataService,
  createKnowledgeItemAdapter,
  createKnowledgeItemJobHandler,
  createKnowledgeItemRepository,
  validateKnowledgeItem,
} from './modules/item';
export type {
  InsertDataServiceDeps,
  KnowledgeItem,
  KnowledgeItemJobHandler,
  KnowledgeItemServiceDeps,
} from './modules/item';

export {
  KNOWLEDGE_ITEM_INDEX_INVARIANTS,
  IndexApplicationService,
  KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS,
  createKnowledgeItemIndexAdapter,
  createKnowledgeItemIndexJobHandler,
  createKnowledgeItemIndexRepository,
  validateKnowledgeItemIndex,
} from './modules/index';
export type {
  IndexServiceDeps,
  KnowledgeItemIndex,
  KnowledgeItemIndexJobHandler,
} from './modules/index';

export {
  PROCESSING_JOB_INVARIANTS,
  ProcessingApplicationService,
  PROCESSING_JOB_JOB_DEFINITIONS,
  PushDataService,
  createProcessingJobAdapter,
  createProcessingJobJobHandler,
  createProcessingJobRepository,
  validateProcessingJob,
} from './modules/processing';
export type {
  ProcessingJob,
  ProcessingJobJobHandler,
  ProcessingServiceDeps,
  PushDataServiceDeps,
} from './modules/processing';

export {
  DATASET_ACL_INVARIANTS,
  PermissionApplicationService,
  DATASET_ACL_JOB_DEFINITIONS,
  createDatasetAclAdapter,
  createDatasetAclJobHandler,
  createDatasetAclRepository,
  validateDatasetAcl,
} from './modules/permission';
export type { DatasetAcl, DatasetAclJobHandler, PermissionServiceDeps } from './modules/permission';

export {
  DELETE_JOB_INVARIANTS,
  DeleteApplicationService,
  DELETE_JOB_JOB_DEFINITIONS,
  createDeleteJobAdapter,
  createDeleteJobJobHandler,
  createDeleteJobRepository,
  validateDeleteJob,
} from './modules/delete';
export type { DeleteJob, DeleteJobJobHandler, DeleteServiceDeps } from './modules/delete';

export {
  MIGRATION_RUN_INVARIANTS,
  MigrationApplicationService,
  MIGRATION_RUN_JOB_DEFINITIONS,
  createMigrationRunAdapter,
  createMigrationRunJobHandler,
  createMigrationRunRepository,
  validateMigrationRun,
} from './modules/migration';
export type {
  MigrationRun,
  MigrationRunJobHandler,
  MigrationServiceDeps,
} from './modules/migration';
