import { ApiErrorException, createSkeletonError } from '@kb/contracts';
import type {
  AdminDatasetPort,
  ArchiveStatusPort,
  AuditPort,
  AuthSubjectProvider,
  BackupToolPort,
  DatasetEventPort,
  DatasetMetricsPort,
  DatasetNotificationPort,
  DatasetPermissionPort,
  DatasetSearchPort,
  DatasetSourceProvider,
  DatasetSyncPort,
  DegradationPolicy,
  FailureQueryPort,
  FeatureFlagProvider,
  FullTextStore,
  HealthProbePort,
  ImageTrainingProcessorPort,
  LoggerPort,
  MigrationRegistryPort,
  ModelRegistryPort,
  MongoIndexManagerPort,
  NotifyPort,
  ObjectStorePort,
  PdfEnhanceProviderPort,
  ReconcileResultPort,
  SBOMGeneratorPort,
  TenantContextProvider,
  TenantQuotaProvider,
  TrainingProcessorPort,
  TransferDatasetOwnerPort,
  UpdateDatasetCollaboratorsPort,
  VectorController,
} from './capabilities';
import type {
  CollectionRepository,
  DeleteJobRepository,
  KnowledgeBaseRepository,
  KnowledgeItemRepository,
  ProcessingJobRepository,
} from './repositories';

/**
 * 骨架期统一空实现（SKEL-ADR-007 / 设计文档 ADR-010）：
 * 任何未实现的 Port 调用都返回稳定错误 501999，禁止返回空值或伪造成功。
 */
export function createUnimplementedPort<T extends object>(port: string): T {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (property === 'then' || typeof property === 'symbol') return undefined;
      return (..._args: unknown[]) =>
        Promise.reject(new ApiErrorException(createSkeletonError({ port }, 'skeleton')));
    },
  }) as unknown as T;
}

/** 38 个 Port 的容器；键名与设计文档 7.6 / 任务书 8.2 对应。 */
export interface ServicePorts {
  knowledgeBaseRepository: KnowledgeBaseRepository;
  collectionRepository: CollectionRepository;
  knowledgeItemRepository: KnowledgeItemRepository;
  processingJobRepository: ProcessingJobRepository;
  deleteJobRepository: DeleteJobRepository;
  fullTextStore: FullTextStore;
  vectorController: VectorController;
  objectStore: ObjectStorePort;
  datasetPermission: DatasetPermissionPort;
  updateDatasetCollaborators: UpdateDatasetCollaboratorsPort;
  transferDatasetOwner: TransferDatasetOwnerPort;
  datasetSourceProvider: DatasetSourceProvider;
  trainingProcessor: TrainingProcessorPort;
  imageTrainingProcessor: ImageTrainingProcessorPort;
  datasetSync: DatasetSyncPort;
  pdfEnhanceProvider: PdfEnhanceProviderPort;
  datasetSearch: DatasetSearchPort;
  adminDataset: AdminDatasetPort;
  archiveStatus: ArchiveStatusPort;
  failureQuery: FailureQueryPort;
  reconcileResult: ReconcileResultPort;
  migrationRegistry: MigrationRegistryPort;
  mongoIndexManager: MongoIndexManagerPort;
  datasetEvent: DatasetEventPort;
  datasetNotification: DatasetNotificationPort;
  notify: NotifyPort;
  audit: AuditPort;
  tenantContextProvider: TenantContextProvider;
  tenantQuotaProvider: TenantQuotaProvider;
  featureFlagProvider: FeatureFlagProvider;
  degradationPolicy: DegradationPolicy;
  healthProbe: HealthProbePort;
  datasetMetrics: DatasetMetricsPort;
  logger: LoggerPort;
  authSubjectProvider: AuthSubjectProvider;
  modelRegistry: ModelRegistryPort;
  backupTool: BackupToolPort;
  sbomGenerator: SBOMGeneratorPort;
}

export const DEFAULT_PORT_IDS = [
  'KnowledgeBaseRepository',
  'CollectionRepository',
  'KnowledgeItemRepository',
  'ProcessingJobRepository',
  'DeleteJobRepository',
  'FullTextStore',
  'VectorController',
  'ObjectStorePort',
  'DatasetPermissionPort',
  'UpdateDatasetCollaboratorsPort',
  'TransferDatasetOwnerPort',
  'DatasetSourceProvider',
  'TrainingProcessorPort',
  'ImageTrainingProcessorPort',
  'DatasetSyncPort',
  'PdfEnhanceProviderPort',
  'DatasetSearchPort',
  'AdminDatasetPort',
  'ArchiveStatusPort',
  'FailureQueryPort',
  'ReconcileResultPort',
  'MigrationRegistryPort',
  'MongoIndexManagerPort',
  'DatasetEventPort',
  'DatasetNotificationPort',
  'NotifyPort',
  'AuditPort',
  'TenantContextProvider',
  'TenantQuotaProvider',
  'FeatureFlagProvider',
  'DegradationPolicy',
  'HealthProbePort',
  'DatasetMetricsPort',
  'LoggerPort',
  'AuthSubjectProvider',
  'ModelRegistryPort',
  'BackupToolPort',
  'SBOMGeneratorPort',
] as const;

export function createDefaultPorts(): ServicePorts {
  return {
    knowledgeBaseRepository: createUnimplementedPort('KnowledgeBaseRepository'),
    collectionRepository: createUnimplementedPort('CollectionRepository'),
    knowledgeItemRepository: createUnimplementedPort('KnowledgeItemRepository'),
    processingJobRepository: createUnimplementedPort('ProcessingJobRepository'),
    deleteJobRepository: createUnimplementedPort('DeleteJobRepository'),
    fullTextStore: createUnimplementedPort('FullTextStore'),
    vectorController: createUnimplementedPort('VectorController'),
    objectStore: createUnimplementedPort('ObjectStorePort'),
    datasetPermission: createUnimplementedPort('DatasetPermissionPort'),
    updateDatasetCollaborators: createUnimplementedPort('UpdateDatasetCollaboratorsPort'),
    transferDatasetOwner: createUnimplementedPort('TransferDatasetOwnerPort'),
    datasetSourceProvider: createUnimplementedPort('DatasetSourceProvider'),
    trainingProcessor: createUnimplementedPort('TrainingProcessorPort'),
    imageTrainingProcessor: createUnimplementedPort('ImageTrainingProcessorPort'),
    datasetSync: createUnimplementedPort('DatasetSyncPort'),
    pdfEnhanceProvider: createUnimplementedPort('PdfEnhanceProviderPort'),
    datasetSearch: createUnimplementedPort('DatasetSearchPort'),
    adminDataset: createUnimplementedPort('AdminDatasetPort'),
    archiveStatus: createUnimplementedPort('ArchiveStatusPort'),
    failureQuery: createUnimplementedPort('FailureQueryPort'),
    reconcileResult: createUnimplementedPort('ReconcileResultPort'),
    migrationRegistry: createUnimplementedPort('MigrationRegistryPort'),
    mongoIndexManager: createUnimplementedPort('MongoIndexManagerPort'),
    datasetEvent: createUnimplementedPort('DatasetEventPort'),
    datasetNotification: createUnimplementedPort('DatasetNotificationPort'),
    notify: createUnimplementedPort('NotifyPort'),
    audit: createUnimplementedPort('AuditPort'),
    tenantContextProvider: createUnimplementedPort('TenantContextProvider'),
    tenantQuotaProvider: createUnimplementedPort('TenantQuotaProvider'),
    featureFlagProvider: createUnimplementedPort('FeatureFlagProvider'),
    degradationPolicy: createUnimplementedPort('DegradationPolicy'),
    healthProbe: createUnimplementedPort('HealthProbePort'),
    datasetMetrics: createUnimplementedPort('DatasetMetricsPort'),
    logger: createUnimplementedPort('LoggerPort'),
    authSubjectProvider: createUnimplementedPort('AuthSubjectProvider'),
    modelRegistry: createUnimplementedPort('ModelRegistryPort'),
    backupTool: createUnimplementedPort('BackupToolPort'),
    sbomGenerator: createUnimplementedPort('SBOMGeneratorPort'),
  };
}
