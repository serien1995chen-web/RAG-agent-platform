import {
  DatasetApiService,
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
  type FullTextStore,
  type ServicePorts,
  type VectorController,
} from '@kb/service';
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

  const ports = options.ports ?? createDefaultPorts();
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
      await closeClients(clients);
    },
  };
  return runtime;
}
