import {
  DatasetApiService,
  EmbeddingService,
  KnowledgeItemApplicationService,
  MongoKnowledgeBaseRepository,
  ProcessingApplicationService,
  SourceCollectionApplicationService,
  createDatasetAclRepository,
  createDefaultPorts,
  createDeleteJobRepository,
  createKnowledgeItemIndexAdapter,
  createKnowledgeItemRepository,
  createMigrationRunRepository,
  createProcessingJobRepository,
  createSourceCollectionRepository,
  createSourceProviderRegistry,
  type DatasetSourceProvider,
  type EmbeddingGateway,
  type FileParserLike,
  type FullTextStore,
  type ServicePorts,
  type VectorController,
} from '@kb/service';
import { BullMqQueueAdapter } from '@kb/dal';
import { DatasetSyncApplicationService } from '../../../../packages/service/src/modules/collection/application/sync.service';
import { closeRuntimeClients, type RuntimeClients } from './clients';
import { createRuntimeObjectStorePort } from './object-store-adapter';
import { getRuntime as getBaseRuntime, type AppRuntime } from './health';

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
   */
  datasetSourceProvider?: DatasetSourceProvider;
  /** 文件来源 Provider 所需解析器（@kb/parse 实现）；未注入时 file sourceType 不可用。 */
  fileParser?: FileParserLike;
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
  deleteRepository: ReturnType<typeof createDeleteJobRepository>;
  migrationRepository: ReturnType<typeof createMigrationRunRepository>;
  datasetPermission: ReturnType<typeof createDatasetAclRepository>;
  embeddingService: EmbeddingService;
  datasetSourceProvider: DatasetSourceProvider;
  vectorController: VectorController;
  fullTextStore?: FullTextStore;
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
  const deleteRepository = createDeleteJobRepository(clients.mongo);
  const migrationRepository = createMigrationRunRepository(clients.mongo);
  const datasetPermission = createDatasetAclRepository(clients.mongo);
  const embeddingService = new EmbeddingService({ gateway: options.embeddingGateway });
  const objectStorePort = createRuntimeObjectStorePort(clients.objectStore);
  const basePorts = options.ports ?? createDefaultPorts();
  const datasetSourceProvider =
    options.datasetSourceProvider ??
    (options.ports ? options.ports.datasetSourceProvider : undefined) ??
    createSourceProviderRegistry({
      objectStore: objectStorePort,
      ...(options.fileParser ? { fileParser: options.fileParser } : {}),
    });
  const adapters = createKnowledgeItemIndexAdapter({
    pool: clients.pg,
    connection: clients.mongo,
  });

  const datasetApi = new DatasetApiService({ repository: knowledgeBaseRepository });
  const collectionService = new SourceCollectionApplicationService({
    repository: collectionRepository,
  });
  const knowledgeItemService = new KnowledgeItemApplicationService({
    repository: knowledgeItemRepository,
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
  const ports: ServicePorts = {
    ...basePorts,
    datasetSync: datasetSyncService,
    datasetSourceProvider,
  };
  const drain = options.drain ?? (async () => undefined);
  const closeClients = options.closeClients ?? closeRuntimeClients;

  let closed = false;
  const runtime: ExtendedAppRuntime = {
    ...base,
    datasetApi,
    knowledgeBaseRepository,
    collectionRepository,
    collectionService,
    knowledgeItemRepository,
    knowledgeItemService,
    processingRepository,
    processingService,
    datasetSyncService,
    deleteRepository,
    migrationRepository,
    datasetPermission,
    embeddingService,
    datasetSourceProvider,
    vectorController: adapters,
    ...(adapters.fullText ? { fullTextStore: adapters.fullText } : {}),
    ports,
    drain,
    async shutdown(): Promise<void> {
      if (closed) return;
      closed = true;
      await drain();
      await syncQueue.close();
      await closeClients(clients);
    },
  };
  return runtime;
}
