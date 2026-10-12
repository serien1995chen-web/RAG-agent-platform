import {
  ApiErrorException,
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
  createApiError,
  type DatasetSourceProvider,
  type EmbeddingGateway,
  type FileParserLike,
  type FullTextStore,
  type ServicePorts,
  type VectorController,
} from '@kb/service';
import { BullMqQueueAdapter } from '@kb/dal';
import { createDefaultDocumentParser } from '@kb/parse';
import { DatasetSyncApplicationService } from '../../../../packages/service/src/modules/collection/application/sync.service';
import { createDatasetSearchPort } from '../../../../packages/service/src/modules/index/adapter/dataset-search.adapter';
import { createSearchEngine } from '../../../../packages/search/src/index';
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
   * 优先级：本字段 > 默认 Registry；不从 options.ports.datasetSourceProvider 取值，
   * 以免 createDefaultPorts() 的未实现 Port 覆盖默认 Registry。
   */
  datasetSourceProvider?: DatasetSourceProvider;
  /** 文件来源 Provider 所需解析器；未注入时使用 @kb/parse 默认解析器。 */
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
  const datasetSearch = createDatasetSearchPort({
    engine: createSearchEngine({
      vectors: adapters,
      fullText: adapters.fullText,
      embedding: embeddingService,
    }),
    connection: clients.mongo,
    collections: collectionRepository,
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
