import {
  DatasetApiService,
  DataUpdateService,
  FileUploadService,
  ImageApplicationService,
  KnowledgeItemApplicationService,
  ModelRuntimeAdapter,
  MongoKnowledgeBaseRepository,
  ProcessingApplicationService,
  SourceCollectionApplicationService,
  createDatasetAclRepository,
  createDefaultPorts,
  createParseRuntimeAdapter,
  createSourceProviderRegistry,
  createDeleteJobRepository,
  createImageAssetRepository,
  createKnowledgeItemIndexAdapter,
  createKnowledgeItemRepository,
  createMigrationRunRepository,
  createProcessingJobRepository,
  createSourceCollectionRepository,
  type FullTextStore,
  type ServicePorts,
  type VectorController,
} from '@kb/service';
import { BullMqQueueAdapter } from '@kb/dal';
import { DatasetSyncApplicationService } from '../../../../packages/service/src/modules/collection/application/sync.service';
import { closeRuntimeClients, type RuntimeClients } from './clients';
import { getRuntime as getBaseRuntime, type AppRuntime } from './health';

export interface RuntimeBootstrapOptions {
  getBaseRuntime?: () => Promise<AppRuntime>;
  drain?: () => Promise<void>;
  closeClients?: (clients: RuntimeClients) => Promise<void>;
  ports?: ServicePorts;
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
  imageApplicationService: ImageApplicationService;
  fileUploadService: FileUploadService;
  modelRuntime: ModelRuntimeAdapter;
  dataUpdateService: DataUpdateService;
  deleteRepository: ReturnType<typeof createDeleteJobRepository>;
  migrationRepository: ReturnType<typeof createMigrationRunRepository>;
  datasetPermission: ReturnType<typeof createDatasetAclRepository>;
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
  const sourceProviders = createSourceProviderRegistry({
    objectStore: clients.objectStore as unknown as ServicePorts['objectStore'],
    fileParser: createParseRuntimeAdapter(),
    // 未接入受控 API Dataset 配置前不谎报 configured；调用方按未配置得到稳定 501062/501017。
    apiDataset: { configured: false },
  });
  const datasetSyncService = new DatasetSyncApplicationService({
    collections: collectionRepository,
    knowledgeBase: knowledgeBaseRepository,
    processingJobs: processingRepository,
    queue: syncQueue,
  });
  const ports: ServicePorts = {
    ...(options.ports ?? createDefaultPorts()),
    datasetSync: datasetSyncService,
    datasetSourceProvider: sourceProviders,
    vectorController: adapters,
    objectStore: clients.objectStore as unknown as ServicePorts['objectStore'],
    ...(adapters.fullText ? { fullTextStore: adapters.fullText } : {}),
    queue: syncQueue,
  } as ServicePorts;
  const imageApplicationService = new ImageApplicationService({
    assets: createImageAssetRepository(clients.mongo) as NonNullable<
      ReturnType<typeof createImageAssetRepository>
    >,
    items: knowledgeItemRepository,
    vectors: adapters,
    fullText: adapters.fullText ?? ports.fullTextStore,
    processor: ports.imageTrainingProcessor,
  });
  const fileUploadService = new FileUploadService();
  const modelMode = (
    base.config as unknown as {
      system?: { dependencyBaseline?: { model?: 'mock' | 'real' } };
    }
  )?.system?.dependencyBaseline?.model;
  const modelRuntime = new ModelRuntimeAdapter({
    mode: modelMode === 'real' ? 'real' : 'mock',
    modelRegistry: ports.modelRegistry,
  });
  const dataUpdateService = new DataUpdateService({
    items: knowledgeItemRepository,
    vectors: adapters,
    fullText: adapters.fullText ?? ports.fullTextStore,
    modelRuntime,
  });
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
    imageApplicationService,
    fileUploadService,
    modelRuntime,
    dataUpdateService,
    deleteRepository,
    migrationRepository,
    datasetPermission,
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
