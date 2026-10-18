import {
  ApiErrorException,
  DatasetApiService,
  EmbeddingService,
  IndexApplicationService,
  InsertDataService,
  KnowledgeItemApplicationService,
  MigrationApplicationService,
  MongoKnowledgeBaseRepository,
  ProcessingApplicationService,
  SourceCollectionApplicationService,
  createArchiveStatusAdapter,
  createAuditAdapter,
  createDatasetAclRepository,
  createDefaultPorts,
  createFailureQueryAdapter,
  createImageProcessorAdapter,
  createKnowledgeItemIndexAdapter,
  createKnowledgeItemRepository,
  createMigrationRunAdapter,
  createMigrationRunRepository,
  createMockEmbeddingGateway,
  createMockImageCapability,
  createProcessingJobRepository,
  createSourceCollectionRepository,
  createSourceProviderRegistry,
  createTrainingProcessor,
  createApiError,
  type AuthSubjectProvider,
  type DatasetSourceProvider,
  type EmbeddingGateway,
  type FileParserLike,
  type FullTextStore,
  type ImageCapabilityPort,
  type ImageTrainingProcessorPort,
  type ServicePorts,
  type VectorController,
} from '@kb/service';
import { BullMqQueueAdapter, QUEUE_NAMES } from '@kb/dal';
import { Queue } from 'bullmq';
import { createDefaultDocumentParser } from '@kb/parse';
import { MinioObjectStore } from '@kb/storage';
import { DeleteApplicationService } from '../../../../packages/service/src/modules/delete/application/index';
import { CompensationApplicationService } from '../../../../packages/service/src/modules/delete/application/compensation.service';
import { ReconcileApplicationService } from '../../../../packages/service/src/modules/delete/application/reconcile.service';
import { S3TtlService } from '../../../../packages/service/src/modules/delete/application/s3-ttl.service';
import {
  MongoCrossStoreOperationRepository,
  MongoDeleteFactsRepository,
  MongoReconcileReportRepository,
  MongoS3TtlRepository,
} from '../../../../packages/service/src/modules/delete/repository/index';
import { ReconcileResultAdapter } from '../../../../packages/service/src/modules/delete/adapter/reconcile-result.adapter';
import type { S3OrphanScanner } from '../../../../packages/service/src/modules/delete/domain/findings';
import { MongoDeleteJobRepository } from '../../../../packages/service/src/modules/delete/repository/mongo-delete-job.repository';
import { createBackupToolAdapter } from '../../../../packages/service/src/modules/migration/adapter/backup-tool.adapter';
import { MigrationExecutor } from '../../../../packages/service/src/modules/migration/application/executor';
import { createDatasetNotificationAdapter } from '../../../../packages/service/src/modules/processing/adapter/dataset-notification.adapter';
import { MongoIndexManager } from '../../../../packages/service/src/shared/persistence/mongo-index-manager';
import { reconcileDatasetSyncSchedulers } from '../../../../packages/service/src/shared/runtime/dataset-sync-scheduler';
import { createLeaderLock } from '../../../../packages/service/src/shared/runtime/leader-lock';
import { DatasetSyncApplicationService } from '../../../../packages/service/src/modules/collection/application/sync.service';
import {
  createDatasetSearchPort,
  createTextResolver,
} from '../../../../packages/service/src/modules/index/adapter/dataset-search.adapter';
import { createRerankAdapter } from '../../../../packages/service/src/modules/index/adapter/rerank.adapter';
import { createModelRegistryAdapter } from '../../../../packages/service/src/modules/index/adapter/model-registry.adapter';
import { createSearchEngine } from '../../../../packages/search/src/index';
import { closeRuntimeClients, type RuntimeClients } from './clients';
import { createRuntimeObjectStorePort } from './object-store-adapter';
import { createCitationBuilder, getRuntime as getBaseRuntime, type AppRuntime } from './health';

export interface RuntimeBootstrapOptions {
  getBaseRuntime?: () => Promise<AppRuntime>;
  drain?: () => Promise<void>;
  closeClients?: (clients: RuntimeClients) => Promise<void>;
  ports?: ServicePorts;
  /** BASE-B3：可选 embedding 网关注入；未注入时 embeddingService 返回 501062。 */
  embeddingGateway?: EmbeddingGateway;
  /**
   * BASE-B2/P1：来源 Provider 运行时注入口（例如 createSourceProviderRegistry(...)）。
   * 未注入时由 bootstrap 默认装配 SourceProviderRegistry（apiFile 未配置返回 501017，
   * 未知来源返回 501035），不再回落到骨架错误 501999。
   * 优先级：本字段 > 默认 Registry；不从 options.ports.datasetSourceProvider 取值，
   * 以免 createDefaultPorts() 的未实现 Port 覆盖默认 Registry。
   */
  datasetSourceProvider?: DatasetSourceProvider;
  /** 文件来源 Provider 所需解析器；未注入时使用 @kb/parse 默认解析器。 */
  fileParser?: FileParserLike;
  /** P6-03 可缺省的 S3 孤儿扫描器；P6-04 起由 MinioObjectStore 判型默认注入。 */
  s3OrphanScanner?: S3OrphanScanner;
  /** P7-05 独立 Root/Admin 身份 provider；不得用 identity extension 替代。 */
  adminAuthProvider?: AuthSubjectProvider;
  /** S6：图片处理器注入（测试可覆盖）；默认按 mock/real 模式装配。 */
  imageTrainingProcessor?: ImageTrainingProcessorPort;
}

export interface ExtendedAppRuntime extends AppRuntime {
  knowledgeBaseRepository: MongoKnowledgeBaseRepository;
  collectionRepository: ReturnType<typeof createSourceCollectionRepository>;
  collectionService: SourceCollectionApplicationService;
  knowledgeItemRepository: ReturnType<typeof createKnowledgeItemRepository>;
  knowledgeItemService: KnowledgeItemApplicationService;
  processingRepository: ReturnType<typeof createProcessingJobRepository>;
  processingService: ProcessingApplicationService;
  datasetSyncService: DatasetSyncApplicationService;
  deleteRepository: MongoDeleteJobRepository;
  deleteJobStore: MongoDeleteJobRepository;
  deleteService: DeleteApplicationService;
  reconcileService: ReconcileApplicationService;
  s3TtlService: S3TtlService;
  compensationService: CompensationApplicationService;
  migrationRepository: ReturnType<typeof createMigrationRunRepository>;
  migrationService: MigrationApplicationService;
  adminAuthProvider?: AuthSubjectProvider;
  datasetPermission: ReturnType<typeof createDatasetAclRepository>;
  embeddingService: EmbeddingService;
  indexService: IndexApplicationService;
  datasetSourceProvider: DatasetSourceProvider;
  vectorController: VectorController;
  fullTextStore?: FullTextStore;
  /** mock 模式下的图片能力；real 未配置时为空，路由据此返回 501010。 */
  imageCapability?: ImageCapabilityPort;
  ports: ServicePorts;
  drain: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export async function bootstrapRuntime(
  options: RuntimeBootstrapOptions = {},
): Promise<ExtendedAppRuntime> {
  const base = await (options.getBaseRuntime ?? getBaseRuntime)();
  const clients = base.clients;
  const knowledgeBaseRepository = new MongoKnowledgeBaseRepository(clients.mongo);
  const collectionRepository = createSourceCollectionRepository(clients.mongo);
  const knowledgeItemRepository = createKnowledgeItemRepository(clients.mongo);
  const processingRepository = createProcessingJobRepository(clients.mongo);
  const deleteJobStore = new MongoDeleteJobRepository(clients.mongo);
  const deleteRepository = deleteJobStore;
  const deleteFactsRepository = new MongoDeleteFactsRepository(clients.mongo);
  const crossStoreRepository = new MongoCrossStoreOperationRepository(clients.mongo);
  const migrationRepository = createMigrationRunRepository(clients.mongo);
  const datasetPermission = createDatasetAclRepository(clients.mongo);
  // P5-03-S09：从（可能被契约测试精简 mock 的）base.config 读取装配所需字段，缺省回落冻结默认值。
  const runtimeConfig = base.config as
    | {
        system?: { environment?: string };
        externalMockMode?: { model?: 'mock' | 'real' };
        datasetRuntime?: { search?: { rerankFailureMode?: 'fallback' | 'strict' } };
      }
    | undefined;
  const modelEnvironment = runtimeConfig?.system?.environment ?? 'production';
  const modelMockMode = runtimeConfig?.externalMockMode?.model ?? 'mock';
  const rerankFailureMode = runtimeConfig?.datasetRuntime?.search?.rerankFailureMode ?? 'fallback';
  // DEMO-002：`model: mock` 时必须给出确定性本地向量；否则文本导入会在训练阶段
  // 以 501062 静默失败，而集合已被标记 ready。real 模式仍回落到未接入（501062）。
  const embeddingMockMode = modelMockMode;
  const embeddingService = new EmbeddingService({
    gateway:
      options.embeddingGateway ??
      (embeddingMockMode === 'mock' ? createMockEmbeddingGateway() : undefined),
  });
  const objectStorePort = createRuntimeObjectStorePort(clients.objectStore);
  const fileParser = options.fileParser ?? createDefaultDocumentParser();
  const basePorts = options.ports ?? createDefaultPorts();
  // 优先级固定：显式 datasetSourceProvider > 默认真实 Registry。
  // 不从 options.ports.datasetSourceProvider 取值，避免 createDefaultPorts() 的未实现 Port
  // 覆盖默认 Registry 导致 501999 回归。
  const datasetSourceProvider =
    options.datasetSourceProvider ??
    createSourceProviderRegistry({
      objectStore: objectStorePort,
      fileParser,
    });
  const adapters = createKnowledgeItemIndexAdapter({
    pool: clients.pg,
    connection: clients.mongo,
  });

  // 训练链最小闭环：parse 处理器负责 切分 → Embedding → 写 Data/向量/全文。
  const insertDataService = new InsertDataService({
    items: knowledgeItemRepository,
    vectors: adapters,
    fullText: adapters.fullText ?? basePorts.fullTextStore,
  });
  const trainingProcessor = createTrainingProcessor({
    collections: collectionRepository,
    datasets: knowledgeBaseRepository,
    sourceProvider: datasetSourceProvider,
    embedding: embeddingService,
    inserts: insertDataService,
  });
  // S6：mock 模式提供真实读取 S3 + 图片魔数校验的确定性能力；real 模式未配置 Provider 时
  // 不装配能力，路由返回 501010，禁止回退 mock。
  const imageCapability =
    modelMockMode === 'mock'
      ? createMockImageCapability({ objectStore: objectStorePort })
      : undefined;
  const imageTrainingProcessor =
    options.imageTrainingProcessor ??
    createImageProcessorAdapter({
      capability: imageCapability,
      configured: imageCapability !== undefined,
      mock: modelMockMode === 'mock',
      environment: modelEnvironment,
    });

  const datasetApi = new DatasetApiService({ repository: knowledgeBaseRepository });
  const collectionService = new SourceCollectionApplicationService({
    repository: collectionRepository,
  });
  const knowledgeItemService = new KnowledgeItemApplicationService({
    repository: knowledgeItemRepository,
  });
  const indexService = new IndexApplicationService({
    repository: adapters,
    items: knowledgeItemRepository,
  });
  const processingService = new ProcessingApplicationService({
    repository: processingRepository,
  });
  const syncQueue = new BullMqQueueAdapter({ connection: clients.redis });
  const datasetSyncService = new DatasetSyncApplicationService({
    collections: collectionRepository,
    knowledgeBase: knowledgeBaseRepository,
    processingJobs: processingRepository,
    queue: syncQueue,
  });
  const deleteQueue = new BullMqQueueAdapter({ connection: clients.redis });
  const deleteSchedulerQueue = new Queue(QUEUE_NAMES.sync, { connection: clients.redis });
  const deleteSchedulerLock = createLeaderLock({
    redis: clients.redis,
    key: 'runtime:delete-scheduler-cleanup',
    ttlMs: 30_000,
  });
  const deleteService = new DeleteApplicationService({
    jobs: deleteJobStore,
    crossStore: crossStoreRepository,
    facts: deleteFactsRepository,
    queue: deleteQueue,
    vectorController: adapters,
    objectStore: objectStorePort,
    syncSchedulerCleanup: async (datasetId, context) => {
      try {
        const result = await reconcileDatasetSyncSchedulers({
          queue: deleteSchedulerQueue,
          lock: deleteSchedulerLock,
          listExpectedDatasetIds: async () => [],
          listRemovedDatasetIds: async () => [datasetId],
          logger: clients.logger,
        });
        clients.logger.log('delete.scheduler_cleanup', { datasetId, ...result });
      } catch (error) {
        clients.logger.log('delete.scheduler_cleanup_failed', {
          datasetId,
          requestId: context.requestId,
          error: error instanceof Error ? error.name : typeof error,
        });
      }
    },
  });
  const reconcileReportRepository = new MongoReconcileReportRepository(clients.mongo);
  const reconcileResultAdapter = new ReconcileResultAdapter(reconcileReportRepository);
  const s3TtlRepository = new MongoS3TtlRepository(clients.mongo);
  // 附加授权②：仅当底层为 MinioObjectStore 时提供枚举能力；判型失败时孤儿扫描转 pending_review。
  const minioObjectStore =
    clients.objectStore instanceof MinioObjectStore ? clients.objectStore : undefined;
  const orphanObjectLister =
    minioObjectStore !== undefined
      ? {
          listByPrefix: (input: { prefix: string; limit: number }) =>
            minioObjectStore.listObjectsByPrefix(input),
        }
      : undefined;
  const s3TtlService = new S3TtlService({
    repository: s3TtlRepository,
    objectStore: objectStorePort,
    logger: clients.logger,
    ...(orphanObjectLister !== undefined ? { orphanObjectLister } : {}),
  });
  const s3OrphanScanner =
    options.s3OrphanScanner ?? (orphanObjectLister !== undefined ? s3TtlService : undefined);
  const reconcileService = new ReconcileApplicationService({
    facts: deleteFactsRepository,
    reports: reconcileReportRepository,
    vectorController: adapters,
    ...(adapters.fullText ? { fullTextStore: adapters.fullText } : {}),
    ...(s3OrphanScanner !== undefined ? { s3OrphanScanner } : {}),
    s3TtlBackfill: s3TtlRepository,
    deleteQueue,
  });
  const audit = createAuditAdapter({ connection: clients.mongo });
  const datasetNotification = createDatasetNotificationAdapter({ notify: basePorts.notify });
  const archiveStatus = createArchiveStatusAdapter();
  const failureQuery = createFailureQueryAdapter({ connection: clients.mongo });
  const mongoIndexManager = new MongoIndexManager(clients.mongo);
  const migrationRegistry = createMigrationRunAdapter({ connection: clients.mongo });
  const backupTool = createBackupToolAdapter();
  const migrationExecutor = new MigrationExecutor({
    registry: migrationRegistry,
    backupTool,
    mongoIndexManager,
    audit,
  });
  const migrationService = new MigrationApplicationService({ executor: migrationExecutor });
  const compensationService = new CompensationApplicationService({
    crossStore: crossStoreRepository,
    vectorController: adapters,
    objectStore: objectStorePort,
    hasFormalReference: (input) => s3TtlRepository.hasFormalReference(input),
    hasLiveReference: (input, context) => deleteFactsRepository.hasLiveReference(input, context),
  });
  const ports: ServicePorts = {
    ...basePorts,
    trainingProcessor,
    imageTrainingProcessor,
    deleteJobRepository: deleteRepository,
    objectStore: objectStorePort,
    reconcileResult: reconcileResultAdapter,
    audit,
    datasetNotification,
    archiveStatus,
    failureQuery,
    mongoIndexManager,
    migrationRegistry,
    backupTool,
    datasetSync: datasetSyncService,
    datasetSourceProvider,
    modelRegistry: createModelRegistryAdapter({
      environment: modelEnvironment,
      mockMode: modelMockMode,
      models: [],
    }),
  };
  const datasetSearch = createDatasetSearchPort({
    engine: createSearchEngine(
      {
        vectors: adapters,
        fullText: adapters.fullText,
        embedding: embeddingService,
        resolveTexts: createTextResolver(clients.mongo),
        rerank: createRerankAdapter({
          environment: modelEnvironment,
          mockMode: modelMockMode,
        }),
      },
      { rerankFailureMode },
    ),
    connection: clients.mongo,
    collections: collectionRepository,
    citationBuilder: createCitationBuilder(base.config, clients),
    datasetIndexVersion: async (datasetId, ctx) => {
      const summary = await knowledgeBaseRepository.findByDatasetId({ datasetId }, ctx);
      if (!summary) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: ctx.requestId,
            params: { resourceType: 'dataset', resourceId: datasetId },
          }),
        );
      }
      return summary.indexVersion;
    },
  });
  const drain = options.drain ?? (async () => undefined);
  const closeClients = options.closeClients ?? closeRuntimeClients;

  let closed = false;
  const runtime: ExtendedAppRuntime = {
    ...base,
    datasetApi,
    datasetSearch,
    knowledgeBaseRepository,
    collectionRepository,
    collectionService,
    knowledgeItemRepository,
    knowledgeItemService,
    processingRepository,
    processingService,
    datasetSyncService,
    deleteRepository,
    deleteJobStore,
    deleteService,
    reconcileService,
    s3TtlService,
    compensationService,
    migrationRepository,
    migrationService,
    adminAuthProvider: options.adminAuthProvider,
    datasetPermission,
    embeddingService,
    indexService,
    datasetSourceProvider,
    vectorController: adapters,
    ...(adapters.fullText ? { fullTextStore: adapters.fullText } : {}),
    imageCapability,
    ports,
    drain,
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      await drain();
      await syncQueue.close();
      await deleteQueue.close();
      await deleteSchedulerQueue.close();
      await closeClients(clients);
    },
  };
  return runtime;
}
