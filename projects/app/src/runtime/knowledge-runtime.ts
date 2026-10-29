import {
  BullMqQueueAdapter,
  KNOWLEDGE_QUEUE_NAMES,
  RedisIdempotencyStore,
  type IdempotencyStore,
} from '@kb/dal';
import { createKnowledgeError, type HealthResponse, type RouteEntry } from '@kb/contracts';
import {
  configureTelemetry,
  type SafeAttributes,
  type TelemetryRuntime,
  type TelemetryState,
} from '@kb/otel';
import {
  KnowledgeAccessRepository,
  KnowledgeConnectorRepository,
  KnowledgeCredentialCipher,
  KnowledgeImportRepository,
  KnowledgeIngestionContentAdapter,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeConnectorSyncApplication,
  KnowledgeFullTextRepository,
  KnowledgeVectorRepository,
  KnowledgeUrlImportAdapter,
  CustomApiLibraryClient,
  FeishuConnectorClient,
  YuqueConnectorClient,
  DingtalkConnectorClient,
  S04IngestionApplication,
  S5AiproxyCatalogAdapter,
  S5AiproxyHttpAdapter,
  S5ArtifactRepository,
  S5KeyedSemaphore,
  S5MockModelCatalog,
  S5MockAiproxyTransport,
  S5ModelApplication,
  S5ModelBindingApplication,
  S5ModelBindingRepository,
  S5OcrApplication,
  S5OcrCredentialProfileAdapter,
  S5OcrHttpAdapter,
  S5ProcessingApplication,
  S5QaPipelineAdapter,
  S5RemoteAssetAdapter,
  S5UsageRepository,
  S8CaptionApplication,
  S8ContentEnhancementApplication,
  S8DeepSearchApplication,
  S8DeepSearchRepository,
  S8FileTicketAdapter,
  S8ImageIndexRepository,
  S8ImageSearchApplication,
  S8ModelResolver,
  S8SearchOperationApplication,
  S09SynonymOperationApplication,
  S09SynonymApplication,
  S09QueryExpansionApplication,
  S09RebuildApplication,
  S09SynonymQueryExpansionAdapter,
  S09S6RebuildIndexAdapter,
  S09SynonymS6Adapter,
  KnowledgeSynonymRepository,
  S06JobApplication,
  S06ProcessingApplication,
  S6ProcessingRepository,
  S7SearchApplication,
  S7CitationApplication,
  S7SearchOperationApplication,
  S7SearchAuthorizationAdapter,
  S7SearchPipelineFactory,
  S7CitationSigner,
  S7CitationRepository,
  S7FilterSourceRepository,
  S7SearchRepository,
  AxiosS5HttpTransport,
  AxiosS5OcrHttpTransport,
  loadS5AiproxyConfig,
  loadS5RuntimeEnvironment,
  loadS7CitationConfig,
  createS5ModelGateway,
  isS04Operation,
  KnowledgeAuditRepository,
  KnowledgeApplication,
  KnowledgeArchiveRepository,
  KnowledgeCatalogRepository,
  FileApplication,
  KnowledgeObjectRefRepository,
  ObjectLifecycleService,
  KnowledgeOutboxDispatcher,
  KnowledgeReferenceRepository,
  KnowledgeMockAuthProvider,
  KnowledgeApiKeyAuthProvider,
  KnowledgeCompositeAuthProvider,
  KnowledgeQuotaGate,
  KnowledgeScopedAuthAdapter,
  KnowledgeSharedUsageAdapter,
  KnowledgeTagRepository,
  S10ApiKeyRepository,
  S10OperationsRepository,
  S10ObjectInventoryAdapter,
  S10OpsWorkerApplication,
  S10OperationApplication,
  S10StatusApplication,
  S10StatusProbesAdapter,
  registerKnowledgeModels,
  SourceFileApplication,
  RedisKnowledgeRateLimiter,
  createKnowledgeConnections,
  ensureKnowledgeCollections,
  ensurePgvectorDdl,
  loadKnowledgeRuntimeConfig,
  resolveSecretRef,
  tenantContextOf,
  type KnowledgeRuntimeConfig,
  type S5ArtifactStorePort,
  type TenantContext,
} from '@kb/service';
import { mergeExpansions } from '@kb/search';
import { FileTicketService } from '../../../../sdk/storage/src/file-ticket';
import { MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/providers/minio';
import {
  createDefaultDocumentParser,
  parseImportTemplate,
  parseSynonymFileBuffer,
  parseWithLiteParse,
} from '@kb/parse';
import { Queue } from 'bullmq';
import { ObjectStoreArchiveSafetyAdapter } from './archive-safety.adapter';
import type {
  KnowledgeApiRuntime,
  KnowledgeAuthSubject,
  KnowledgeDispatchInput,
  KnowledgeDispatchResult,
} from '../shared/knowledge-api/types';

interface RuntimeState {
  config: KnowledgeRuntimeConfig;
  mongo: Awaited<ReturnType<typeof createKnowledgeConnections>>['mongo'];
  redis: Awaited<ReturnType<typeof createKnowledgeConnections>>['redis'];
  pool: Awaited<ReturnType<typeof createKnowledgeConnections>>['pg'];
  objectStore: MinioKnowledgeObjectStore;
  queueAdapter: BullMqQueueAdapter;
  queues: Map<string, Queue>;
  idempotencyStore: IdempotencyStore;
  authProvider: KnowledgeCompositeAuthProvider;
  rateLimiter: RedisKnowledgeRateLimiter;
  application: KnowledgeApplication;
  ingestion: S04IngestionApplication;
  s5Models: S5ModelApplication;
  s5ModelBindings: S5ModelBindingApplication;
  s5Processing: S5ProcessingApplication;
  s5Ocr: S5OcrApplication;
  s06Jobs: S06JobApplication;
  s06Processing: S06ProcessingApplication;
  s10OpsWorker: S10OpsWorkerApplication;
  telemetry: TelemetryRuntime;
}

interface TelemetryKnowledgeApiRuntime extends KnowledgeApiRuntime {
  withSpan<T>(name: string, attributes: SafeAttributes, fn: () => Promise<T> | T): Promise<T>;
  telemetryState(): TelemetryState;
  s06WorkerServices(): {
    processing: S06ProcessingApplication;
    s10Ops: S10OpsWorkerApplication;
    mongo: Awaited<ReturnType<typeof createKnowledgeConnections>>['mongo'];
    redis: Awaited<ReturnType<typeof createKnowledgeConnections>>['redis'];
    config: KnowledgeRuntimeConfig;
    close: () => Promise<void>;
  };
}

let runtimePromise: Promise<TelemetryKnowledgeApiRuntime> | undefined;

function timeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: name,
          traceId: name,
          details: { dependency: name, timeoutMs },
        }),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function probe(
  name: 'mongo' | 'redis' | 'postgres' | 's3' | 'iam' | 'telemetry',
  work: () => Promise<void>,
): Promise<HealthResponse['checks'][number]> {
  const startedAt = Date.now();
  try {
    await timeout(work(), 5_000, name);
    return {
      name,
      status: name === 'telemetry' ? 'noop' : 'ok',
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      name,
      status: 'down',
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function bootstrapRuntime(): Promise<TelemetryKnowledgeApiRuntime> {
  const config = loadKnowledgeRuntimeConfig();
  const telemetry = configureTelemetry({
    serviceName: 'knowledge-app',
    ...(config.otelEndpoint ? { endpoint: config.otelEndpoint } : {}),
    logLevel: config.logLevel,
  });
  const connections = await createKnowledgeConnections(config);
  const { mongo, redis, pg: pool } = connections;
  await ensureKnowledgeCollections(mongo);
  await ensurePgvectorDdl(pool);

  const endpoint = new URL(config.s3.endpoint);
  const objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: resolveSecretRef(config.s3.accessKeyRef),
    secretKey: resolveSecretRef(config.s3.secretKeyRef),
    region: config.s3.region,
    bucket: config.s3.bucket,
  });
  const bootstrapWorkspaceId =
    config.auth.mode === 'mock' ? config.auth.fixture.workspaceId : 'system';
  await objectStore.ensureBucket({
    workspaceId: bootstrapWorkspaceId,
    knowledgeSpaceId: 'system',
    requestId: 'bootstrap',
    traceId: 'bootstrap',
  });

  const catalog = new KnowledgeCatalogRepository(mongo);
  const access = new KnowledgeAccessRepository(mongo);
  const objectRefs = new KnowledgeObjectRefRepository(mongo);
  const s5RuntimeEnv = loadS5RuntimeEnvironment();
  const s5AiproxyConfig = loadS5AiproxyConfig(s5RuntimeEnv);
  const s5ArtifactStore: S5ArtifactStorePort = {
    provider: objectStore.provider,
    bucket: objectStore.bucket,
    async putObject(input, context) {
      const stored = await objectStore.putObject(
        {
          key: input.key,
          body: input.body,
          sizeBytes: input.body.byteLength,
          contentType: input.contentType,
          metadata: { purpose: input.purpose, sha256: input.sha256 },
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
        },
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        },
      );
      return {
        key: stored.key,
        size: stored.size,
        etag: stored.etag,
        sha256: stored.sha256,
      };
    },
  };
  const s5Usage = new S5UsageRepository(mongo, config.s10.pricing, config.s10.quota);
  const s10Usage =
    config.s10.sharedUsage === undefined
      ? s5Usage
      : new KnowledgeSharedUsageAdapter(
          {
            ...config.s10.sharedUsage,
            profileVersion: config.s10.quota.version,
          },
          s5Usage,
        );
  const quotaGate = new KnowledgeQuotaGate({
    usage: s10Usage,
    redis,
    quota: config.s10.quota,
  });
  const s5Catalog =
    s5AiproxyConfig.modelMode === 'mock'
      ? new S5MockModelCatalog()
      : new S5AiproxyCatalogAdapter({
          config: s5AiproxyConfig,
          transport: new AxiosS5HttpTransport(),
          env: s5RuntimeEnv,
        });
  const s5ModelTransport =
    s5AiproxyConfig.modelMode === 'mock'
      ? new S5MockAiproxyTransport()
      : new AxiosS5HttpTransport();
  const s5ModelToken =
    s5AiproxyConfig.modelMode === 'mock'
      ? 'mock-aiproxy-token'
      : resolveSecretRef(s5AiproxyConfig.apiTokenRef, s5RuntimeEnv);
  const s5Gateway = createS5ModelGateway({
    catalog: s5Catalog,
    adapter: new S5AiproxyHttpAdapter({
      baseUrl: s5AiproxyConfig.baseUrl,
      token: s5ModelToken,
      transport: s5ModelTransport,
    }),
    usage: s5Usage,
    quotaGate,
    pricing: config.s10.pricing,
    limiter: new S5KeyedSemaphore(10),
  });
  const s5Models = new S5ModelApplication(s5Catalog);
  const synonymRepository = new KnowledgeSynonymRepository(mongo);
  const s5BindingRepository = new S5ModelBindingRepository(mongo, synonymRepository);
  const s5ModelBindings = new S5ModelBindingApplication(s5BindingRepository, s5Catalog, access);
  const s5Artifacts = new S5ArtifactRepository(mongo, s5ArtifactStore);
  const s5Qa = new S5QaPipelineAdapter({
    gateway: s5Gateway,
    resolveModels: async ({ knowledgeSpaceId, context }) => {
      const bindings = await s5BindingRepository.list(knowledgeSpaceId, context);
      const llm = bindings.find(
        (binding) => binding.modelType === 'llm' && binding.status === 'active',
      );
      const embedding = bindings.find(
        (binding) => binding.modelType === 'embedding' && binding.status === 'active',
      );
      if (!llm) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'modelBindings.llm', reason: 'required_for_qa' },
        });
      }
      return {
        llmModelId: llm.modelId,
        ...(embedding ? { embeddingModelId: embedding.modelId } : {}),
      };
    },
  });
  const s5Ocr = new S5OcrApplication({
    provider: new S5OcrHttpAdapter({
      profiles: new S5OcrCredentialProfileAdapter(s5RuntimeEnv),
      transport: new AxiosS5OcrHttpTransport(),
    }),
    usage: s5Usage,
    remoteAssets: new S5RemoteAssetAdapter(),
    assetSink: s5Artifacts,
    sourceGuard: {
      async assertSource(input, context) {
        const source = await catalog.getSource(input.sourceId, context);
        if (String(source.knowledgeSpaceId) !== input.knowledgeSpaceId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { sourceId: input.sourceId },
          });
        }
        if (Number(source.sourceVersion) !== input.sourceVersion) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: {
              sourceId: input.sourceId,
              expectedVersion: input.sourceVersion,
              actualVersion: Number(source.sourceVersion),
            },
          });
        }
      },
    },
    fallbackPdf: async (input) => {
      const parsed = await parseWithLiteParse({
        request: {
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          sourceId: input.sourceId,
          fileRef: input.fileName,
          extension: 'pdf',
          mimeType: input.mimeType,
          timeoutMs: input.timeoutMs,
        },
        bytes: input.bytes,
        mimeType: input.mimeType,
      });
      return {
        markdown: parsed.rawText,
        pages: parsed.pages,
        assets: parsed.assets,
        diagnostics: parsed.diagnostics,
      };
    },
  });
  const queueAdapter = new BullMqQueueAdapter({ connection: redis });
  const outboxDispatcher = new KnowledgeOutboxDispatcher(mongo, queueAdapter);
  const jobExecution = new KnowledgeJobExecutionRepository(mongo);
  const vectorRepository = new KnowledgeVectorRepository(pool);
  const fullTextRepository = new KnowledgeFullTextRepository(mongo);
  const processingStore = new S6ProcessingRepository(mongo);
  const fileTickets = new FileTicketService(
    resolveSecretRef(config.fileTicketSecretRef),
    config.filePublicBaseUrl,
  );
  const imageTickets = new S8FileTicketAdapter(fileTickets);
  const imageIndexes = new S8ImageIndexRepository(mongo);
  const imageModels = new S8ModelResolver(mongo, s5Catalog);
  const s8Caption = new S8CaptionApplication({
    store: processingStore,
    objects: objectRefs,
    models: imageModels,
    gateway: s5Gateway,
    tickets: imageTickets,
    vectors: vectorRepository,
    fulltext: fullTextRepository,
    indexes: imageIndexes,
  });
  const s8Enhancement = new S8ContentEnhancementApplication({
    gateway: s5Gateway,
    models: imageModels,
    caption: s8Caption,
  });
  const s5Processing = new S5ProcessingApplication(s5Qa, s8Enhancement);
  const segmentIndexes = new KnowledgeSegmentIndexRepository(mongo, jobExecution, s5Catalog);
  const credentialCipher = new KnowledgeCredentialCipher(
    resolveSecretRef(config.credentialEncryptionKeyRef),
  );
  const ingestionContent = new KnowledgeIngestionContentAdapter(objectStore);
  const connectorClients = {
    feishu: new FeishuConnectorClient(),
    yuque: new YuqueConnectorClient(),
    dingtalk: new DingtalkConnectorClient(),
  };
  const connectorGateway = {
    async catalog(input: {
      provider: 'feishu' | 'yuque' | 'dingtalk';
      config: Record<string, unknown>;
      credentials: Record<string, unknown>;
      rootId: string;
      cursor?: string;
      context: TenantContext;
    }) {
      const request = {
        config: input.config,
        credentials: input.credentials,
        rootId: input.rootId,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        context: input.context,
      };
      if (input.provider === 'feishu') return connectorClients.feishu.catalog(request);
      if (input.provider === 'yuque') return connectorClients.yuque.catalog(request);
      return connectorClients.dingtalk.catalog(request);
    },
    async content(input: {
      provider: 'feishu' | 'yuque' | 'dingtalk';
      config: Record<string, unknown>;
      credentials: Record<string, unknown>;
      externalIds: readonly string[];
      context: TenantContext;
    }) {
      const request = {
        config: input.config,
        credentials: input.credentials,
        externalIds: input.externalIds,
        context: input.context,
      };
      if (input.provider === 'feishu') return connectorClients.feishu.content(request);
      if (input.provider === 'yuque') return connectorClients.yuque.content(request);
      return connectorClients.dingtalk.content(request);
    },
  };
  const importRepository = new KnowledgeImportRepository(mongo);
  const connectorRepository = new KnowledgeConnectorRepository(mongo, credentialCipher);
  const connectorSync = new KnowledgeConnectorSyncApplication({
    connectors: connectorRepository,
    gateway: connectorGateway,
    content: ingestionContent,
    imports: importRepository,
  });
  const s09RebuildRef: { current: S09RebuildApplication | undefined } = {
    current: undefined,
  };
  const s6Processing = new S06ProcessingApplication({
    jobs: jobExecution,
    store: processingStore,
    artifacts: s5Artifacts,
    processing: s5Processing,
    vectors: vectorRepository,
    fulltext: fullTextRepository,
    models: s5Catalog,
    bindings: s5BindingRepository,
    sync: connectorSync,
    caption: s8Caption,
    synonymRebuild: {
      async handleQueue(jobId, workerId, context) {
        if (!s09RebuildRef.current) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 's09_rebuild_bootstrap_incomplete' },
          });
        }
        return s09RebuildRef.current.handleQueue(jobId, workerId, context);
      },
    },
    synonymVersion: synonymRepository,
    synonymCleanup: synonymRepository,
    port: {
      async parse(input, context) {
        const objectRef = await objectRefs.findObjectRef(input.blobRefId, context);
        if (!objectRef || objectRef.state !== 'active') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { blobRefId: input.blobRefId },
          });
        }
        const object = await objectStore.getObject(objectRef.bucket, objectRef.objectKey, null, {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of object.body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const extension = input.fileName.includes('.')
          ? input.fileName.split('.').at(-1)!.toLowerCase()
          : 'txt';
        const request = {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          sourceId: input.sourceId,
          fileRef: input.blobRefId,
          extension,
          mimeType: input.mimeType,
          timeoutMs: 600_000,
        };
        if (input.mimeType === 'application/pdf' || extension === 'pdf') {
          return parseWithLiteParse({ request, bytes, mimeType: input.mimeType });
        }
        const parseRequest = { ...request, bytes };
        return createDefaultDocumentParser().parse(parseRequest);
      },
      async embed(input, context) {
        const result = await s5Gateway.invoke<{
          data: Array<{ index: number; embedding: number[] }>;
        }>({
          kind: 'embedding',
          modelId: input.modelId,
          input: input.texts.map((text) => ({ type: 'text' as const, text })),
          dimension: input.dimension,
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          resourceType: 'source',
          resourceId: input.sourceId,
          operation: 'knowledge.index.embed',
          requestId: context.requestId,
          traceId: context.traceId,
          context,
        });
        return [...result.data.data]
          .sort((left, right) => left.index - right.index)
          .map((item) => item.embedding);
      },
      async dispatchOutbox(context) {
        return (await outboxDispatcher.dispatchOnce(context)).dispatched;
      },
    },
  });
  const synonymRawFiles = {
    async store(
      input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        fileName: string;
        mimeType: string;
        bytes: Uint8Array;
        sha256: string;
      },
      context: TenantContext,
    ) {
      const extension = input.fileName.split('.').at(-1)?.toLowerCase() || 'csv';
      const objectKey = `ws/${context.workspaceId}/space/${input.knowledgeSpaceId}/synonym/${input.sha256}.${extension}`;
      const stored = await objectStore.putObject(
        {
          key: objectKey,
          body: input.bytes,
          sizeBytes: input.bytes.byteLength,
          contentType: input.mimeType,
          metadata: { purpose: 'synonym', sha256: input.sha256 },
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
        },
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        },
      );
      return {
        blobId: 'pending-object-ref',
        provider: objectStore.provider,
        bucket: objectStore.bucket,
        objectKey: stored.key,
        mimeType: input.mimeType,
        sizeBytes: stored.size,
        etag: stored.etag,
        sha256: stored.sha256,
        originalName: input.fileName,
      };
    },
  };
  const synonymApplication = new S09SynonymApplication({
    repository: synonymRepository,
    parser: { parse: parseSynonymFileBuffer },
    rawFiles: synonymRawFiles,
    access,
  });
  const s09Operations = new S09SynonymOperationApplication(synonymApplication, quotaGate);
  const s09Expansion = new S09QueryExpansionApplication(
    new S09SynonymQueryExpansionAdapter({
      repository: synonymRepository,
      mergeExpansions,
    }),
  );
  const s09S6 = new S09SynonymS6Adapter(
    new S09S6RebuildIndexAdapter({
      connection: mongo,
      store: processingStore,
      vectors: vectorRepository,
      fulltext: fullTextRepository,
      processing: {
        embed(input, context) {
          return s6Processing.embedForIndex(input, context);
        },
      },
      models: s5Catalog,
    }),
  );
  s09RebuildRef.current = new S09RebuildApplication({
    repository: synonymRepository,
    s6: s09S6,
    jobs: jobExecution,
  });
  const s06Jobs = new S06JobApplication(jobExecution, segmentIndexes, catalog, access);
  const s10ApiKeys = new S10ApiKeyRepository(mongo);
  const s10Ops = new S10OperationsRepository(mongo, queueAdapter);
  const s10Operations = new S10OperationApplication({
    apiKeys: s10ApiKeys,
    usage: s10Usage,
    audits: s10Ops,
    ops: s10Ops,
    catalog,
    hmacSecret: config.s10.apiKeyHmacSecret,
  });
  const s7Authorization = new S7SearchAuthorizationAdapter(mongo, access);
  const s7SearchRepository = new S7SearchRepository(mongo, s5Catalog);
  const s8DeepRepository = new S8DeepSearchRepository(mongo, s5Catalog);
  const s7Pipeline = new S7SearchPipelineFactory({
    vectors: vectorRepository,
    modelGateway: s5Gateway,
    fullText: s7SearchRepository,
    authorization: s7Authorization,
  });
  const s7CitationConfig = loadS7CitationConfig();
  const s7Signer = new S7CitationSigner(
    resolveSecretRef(s7CitationConfig.citationSigningSecretRef),
  );
  const s7Citations = new S7CitationRepository(mongo, s7Signer);
  const s7Filters = new S7FilterSourceRepository(mongo);
  const s7Search = new S7SearchApplication({
    access: s7Authorization,
    models: s7SearchRepository,
    filters: s7Filters,
    fullText: s7SearchRepository,
    authorization: s7Authorization,
    pipeline: s7Pipeline,
    citations: s7Citations,
    audits: s7Citations,
    synonymExpansion: s09Expansion,
  });
  const s7Citation = new S7CitationApplication({
    access: s7Authorization,
    authorizations: s7Authorization,
    citations: s7Citations,
    signer: s7Signer,
  });
  const s7Operations = new S7SearchOperationApplication(s7Search, s7Citation);
  const s8ImageSearch = new S8ImageSearchApplication({
    access: s7Authorization,
    objects: objectRefs,
    models: imageModels,
    gateway: s5Gateway,
    tickets: imageTickets,
    search: s7Search,
    fullText: s7SearchRepository,
    filters: s7Filters,
    authorization: s7Authorization,
    citations: s7Citations,
    audits: s7Citations,
    vectors: vectorRepository,
  });
  const s8DeepSearch = new S8DeepSearchApplication({
    access: s7Authorization,
    repository: s8DeepRepository,
    gateway: s5Gateway,
    search: s7Search,
    authorization: s7Authorization,
    citations: s7Citations,
    audits: s7Citations,
  });
  const s8Operations = new S8SearchOperationApplication(s8ImageSearch, s8DeepSearch);
  const ingestion = new S04IngestionApplication({
    imports: importRepository,
    connectors: connectorRepository,
    objectRefs,
    content: ingestionContent,
    urlImport: new KnowledgeUrlImportAdapter(),
    customApi: new CustomApiLibraryClient(),
    providers: connectorClients,
    access,
    scopedAuth: new KnowledgeScopedAuthAdapter(access),
    quotaGate,
    templateParser: {
      parse(input) {
        return parseImportTemplate(input);
      },
    },
  });
  const archiveSafety = new ObjectStoreArchiveSafetyAdapter(objectStore);
  const files = new FileApplication(
    objectRefs,
    objectStore,
    catalog,
    access,
    fileTickets,
    archiveSafety,
  );
  const jobs = new KnowledgeArchiveRepository(mongo);
  const references = new KnowledgeReferenceRepository(mongo);
  const audits = new KnowledgeAuditRepository(mongo);
  const sourceFiles = new SourceFileApplication(
    catalog,
    jobs,
    access,
    objectRefs,
    objectStore,
    fileTickets,
    archiveSafety,
  );
  const objectLifecycle = new ObjectLifecycleService(objectRefs, objectStore);
  const s10Inventory = new S10ObjectInventoryAdapter(mongo, pool);
  const s10OpsWorker = new S10OpsWorkerApplication({
    jobs: jobExecution,
    async deliverUsage({ eventId, payload, context }) {
      try {
        await s10Usage.deliverUsage({ eventId, payload }, context);
        await s5Usage.markDelivery(eventId, 'delivered', context);
      } catch (error) {
        await s5Usage.markDelivery(eventId, 'failed', context).catch(() => undefined);
        throw error;
      }
    },
    async markUsageOutboxFailed({ outboxEventId, eventId, errorCode, deadLetter, context }) {
      await s5Usage.markDelivery(eventId, 'failed', context).catch(() => undefined);
      await s10Ops.failOutboxDelivery({ outboxEventId, eventId, errorCode, deadLetter }, context);
    },
    async cleanup({ scope, context, step }) {
      const startedAt = new Date().toISOString();
      const scopes =
        scope === 'all'
          ? ['ttl_objects', 'orphan_objects', 'orphan_vectors', 'stale_jobs']
          : [scope];
      let diffCount = 0;
      let repairedCount = 0;
      let retryable = 0;
      let deadLetter = 0;
      const items: Array<Record<string, unknown>> = [];
      for (const current of scopes) {
        await step(current, 'running', { scope: current });
        if (current === 'ttl_objects' || current === 'orphan_objects') {
          const result = await objectLifecycle.cleanup(context, new Date(), current);
          diffCount += result.eligible;
          repairedCount += result.deleted;
          retryable += result.retryable;
          deadLetter += result.failed;
          items.push({ scope: current, ...result });
          if (result.retryable > 0 || result.failed > 0) {
            await step(current, 'failed', {
              scope: current,
              retryable: result.retryable,
              failed: result.failed,
            });
            throw createKnowledgeError({
              code:
                result.retryable > 0 ? 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' : 'KNOWLEDGE_JOB_FAILED',
              requestId: context.requestId,
              traceId: context.traceId,
              retryable: result.retryable > 0,
              details: {
                operation: 'cleanup',
                scope: current,
                retryable: result.retryable,
                failed: result.failed,
              },
            });
          }
        } else if (current === 'orphan_vectors') {
          const activeVectorIds = await s10Inventory.listActiveVectorIds(context);
          const result = await vectorRepository.cleanupUnreferenced(
            {
              workspaceId: context.workspaceId,
              activeVectorIds,
              olderThan: new Date(Date.now() - 30 * 86_400_000),
              batchSize: 500,
            },
            context,
          );
          diffCount += result.deleted;
          repairedCount += result.deleted;
          items.push({ scope: current, ...result });
        } else if (current === 'stale_jobs') {
          const recovered = await jobExecution.recoverExpiredLeases(context);
          diffCount += recovered;
          repairedCount += recovered;
          items.push({ scope: current, recovered });
        } else {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'scope', value: current },
          });
        }
        await step(current, 'succeeded', {
          scope: current,
          diffCount,
          repairedCount,
          retryable,
          deadLetter,
        });
      }
      return {
        diffCount,
        repairedCount,
        retryable,
        deadLetter,
        items,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    },
    async reconcile({ scope, repair, context, step }) {
      const startedAt = new Date().toISOString();
      const scopes = scope === 'all' ? ['objects', 'vectors', 'fulltext', 'outbox'] : [scope];
      let diffCount = 0;
      let repairedCount = 0;
      let retryable = 0;
      let deadLetter = 0;
      const items: Array<Record<string, unknown>> = [];
      for (const current of scopes) {
        await step(current, 'running', { scope: current, repair });
        if (current === 'objects') {
          const objects = await s10Inventory.listObjects(context);
          let missing = 0;
          for (const object of objects) {
            try {
              await objectStore.headObject(object.bucket, object.objectKey, {
                workspaceId: context.workspaceId,
                knowledgeSpaceId: 'system',
                requestId: context.requestId,
                traceId: context.traceId,
              });
            } catch {
              missing += 1;
              if (repair && !(await s10Inventory.activeObjectReference(object.id, context))) {
                const updated = await registerKnowledgeModels(mongo).KnowledgeObjectRef.updateOne(
                  {
                    workspaceId: context.workspaceId,
                    _id: new mongo.base.Types.ObjectId(object.id),
                    version: object.version,
                    deletedAt: null,
                  },
                  {
                    $set: {
                      state: 'deleted',
                      updatedByMemberId: context.memberId,
                    },
                    $inc: { version: 1 },
                  },
                );
                if (updated.modifiedCount !== 1) {
                  throw createKnowledgeError({
                    code: 'KNOWLEDGE_CONFLICT',
                    requestId: context.requestId,
                    traceId: context.traceId,
                    details: { scope: current, objectId: object.id, reason: 'repair_cas' },
                  });
                }
                repairedCount += 1;
              }
            }
          }
          diffCount += missing;
          items.push({ scope: current, scanned: objects.length, missing });
        } else if (current === 'vectors') {
          const [activeIds, stored] = await Promise.all([
            s10Inventory.listActiveVectorIds(context),
            s10Inventory.listVectorIds(context),
          ]);
          const active = new Set(activeIds);
          const orphanIds = stored.filter((entry) => !active.has(entry.id));
          diffCount += orphanIds.length;
          if (repair && orphanIds.length > 0) {
            const result = await vectorRepository.cleanupUnreferenced(
              {
                workspaceId: context.workspaceId,
                activeVectorIds: activeIds,
                olderThan: new Date(Date.now() - 30 * 86_400_000),
                batchSize: 500,
              },
              context,
            );
            repairedCount += result.deleted;
          }
          items.push({
            scope: current,
            active: activeIds.length,
            stored: stored.length,
            orphan: orphanIds.length,
          });
        } else if (current === 'fulltext') {
          const drift = await s10Inventory.fulltextDriftCount(context);
          diffCount += drift;
          items.push({ scope: current, drift });
          if (repair && drift > 0) {
            await step(current, 'failed', {
              scope: current,
              repair: true,
              drift,
              reason: 'fulltext_repair_not_supported',
            });
            throw createKnowledgeError({
              code: 'KNOWLEDGE_VALIDATION_FAILED',
              requestId: context.requestId,
              traceId: context.traceId,
              retryable: false,
              details: {
                operation: 'reconcile',
                scope: current,
                reason: 'fulltext_repair_not_supported',
              },
            });
          }
        } else if (current === 'outbox') {
          const counts = await s10Inventory.outboxStatusCounts(context);
          const drift = Number(counts.failed ?? 0) + Number(counts.dead_letter ?? 0);
          diffCount += drift;
          retryable += Number(counts.failed ?? 0);
          deadLetter += Number(counts.dead_letter ?? 0);
          items.push({ scope: current, counts });
          if (repair && drift > 0) {
            await step(current, 'failed', {
              scope: current,
              repair: true,
              drift,
              reason: 'outbox_repair_not_supported',
            });
            throw createKnowledgeError({
              code: 'KNOWLEDGE_VALIDATION_FAILED',
              requestId: context.requestId,
              traceId: context.traceId,
              retryable: false,
              details: {
                operation: 'reconcile',
                scope: current,
                reason: 'outbox_repair_not_supported',
              },
            });
          }
        } else {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'scope', value: current },
          });
        }
        await step(current, 'succeeded', {
          scope: current,
          repair,
          diffCount,
          repairedCount,
        });
      }
      return {
        diffCount,
        repairedCount,
        retryable,
        deadLetter,
        items,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    },
    async replay({ eventId, expectedVersion, context }) {
      const result = await outboxDispatcher.dispatchById(eventId, expectedVersion, context);
      if (!result.dispatched) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { eventId, expectedVersion, reason: 'outbox_target_not_dispatchable' },
        });
      }
      return {
        diffCount: result.dispatched ? 1 : 0,
        repairedCount: result.dispatched ? 1 : 0,
        retryable: result.dispatched ? 0 : 1,
        deadLetter: 0,
        items: [
          {
            eventKey: result.eventKey ?? null,
            dispatched: result.dispatched,
          },
        ],
      };
    },
  });
  const application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(mongo),
    access,
    jobs,
    files,
    sourceFiles,
    references,
    audits,
    s5Models,
    s5ModelBindings,
    s06Jobs,
    s7Operations,
    s8Operations,
    s09Operations,
    s10Operations,
    quotaGate,
  );
  const queues = new Map(
    KNOWLEDGE_QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: redis })]),
  );
  const state: RuntimeState = {
    config,
    mongo,
    redis,
    pool,
    objectStore,
    queueAdapter,
    queues,
    idempotencyStore: new RedisIdempotencyStore(redis),
    authProvider: new KnowledgeCompositeAuthProvider(
      new KnowledgeMockAuthProvider(config.auth, config.environment),
      new KnowledgeApiKeyAuthProvider(s10ApiKeys, config.s10.apiKeyHmacSecret),
    ),
    rateLimiter: new RedisKnowledgeRateLimiter(redis),
    application,
    ingestion,
    s5Models,
    s5ModelBindings,
    s5Processing,
    s5Ocr,
    s06Jobs,
    s06Processing: s6Processing,
    s10OpsWorker,
    telemetry,
  };

  const readiness = async (
    requestId: string,
  ): Promise<{ status: number; body: HealthResponse }> => {
    const telemetryState = state.telemetry.state();
    const checks = await Promise.all([
      probe('mongo', async () => {
        const db = state.mongo.db;
        if (!db) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId,
            traceId: requestId,
            details: { dependency: 'mongo', reason: 'disconnected' },
          });
        }
        await db.admin().ping();
      }),
      probe('redis', async () => {
        if ((await state.redis.ping()) !== 'PONG') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId,
            traceId: requestId,
            details: { dependency: 'redis', reason: 'ping_failed' },
          });
        }
      }),
      probe('postgres', async () => {
        const result = await state.pool.query<{ extversion: string }>(
          "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
        );
        if (!result.rows[0]?.extversion) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId,
            traceId: requestId,
            details: { dependency: 'postgres', reason: 'pgvector_missing' },
          });
        }
      }),
      probe('s3', async () => {
        await state.objectStore.ensureBucket({
          workspaceId: bootstrapWorkspaceId,
          knowledgeSpaceId: 'system',
          requestId,
          traceId: requestId,
        });
      }),
      probe('iam', async () => {
        if (state.config.auth.mode !== 'mock') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId,
            traceId: requestId,
            details: { dependency: 'iam', status: 'EXTERNAL_UNVERIFIED' },
          });
        }
      }),
      Promise.resolve({
        name: 'telemetry' as const,
        status:
          telemetryState.mode === 'noop'
            ? ('noop' as const)
            : telemetryState.mode === 'degraded'
              ? ('degraded' as const)
              : ('ok' as const),
        latencyMs: 0,
      }),
    ]);
    const down = checks.some((check) => check.status === 'down');
    return {
      status: down ? 503 : 200,
      body: {
        status: down ? 'down' : 'ok',
        checks,
        timestamp: new Date().toISOString(),
      },
    };
  };
  const s10Status = new S10StatusApplication(
    new S10StatusProbesAdapter({
      config,
      connection: mongo,
      queues,
      readiness,
      models: s5Catalog,
    }),
  );

  const runtime: TelemetryKnowledgeApiRuntime = {
    async authenticate(request, input): Promise<KnowledgeAuthSubject> {
      const authorization = request.headers.authorization;
      const headerValue = Array.isArray(authorization) ? authorization[0] : authorization;
      const cookieHeader = request.headers.cookie;
      const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader ?? '');
      const consoleSession = cookies
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('kb_console_session='))
        ?.slice('kb_console_session='.length);
      return state.authProvider.authenticate({
        authorization: headerValue,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        traceId: input.traceId,
        ipAddress:
          (Array.isArray(request.headers['x-forwarded-for'])
            ? request.headers['x-forwarded-for'][0]
            : request.headers['x-forwarded-for']) ?? request.socket?.remoteAddress,
        userAgent: Array.isArray(request.headers['user-agent'])
          ? request.headers['user-agent'][0]
          : request.headers['user-agent'],
        ...(consoleSession ? { consoleSession } : {}),
      });
    },
    ticketWorkspaceId(ticket, requestId, traceId) {
      return fileTickets.verify(ticket, requestId, traceId).workspaceId;
    },
    async idempotencyStore() {
      return state.idempotencyStore;
    },
    async rateLimit(input) {
      return state.rateLimiter.consume(input);
    },
    readiness,
    withSpan(name, attributes, fn) {
      return state.telemetry.withSpan(name, attributes, () => fn());
    },
    telemetryState() {
      return state.telemetry.state();
    },
    s06WorkerServices() {
      return {
        processing: state.s06Processing,
        s10Ops: state.s10OpsWorker,
        mongo: state.mongo,
        redis: state.redis,
        config: state.config,
        async close() {
          await Promise.all([state.mongo.close(), state.redis.quit(), state.pool.end()]);
        },
      };
    },
    async operationsStatus(input) {
      return s10Status.get({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        requestId: input.requestId,
        traceId: input.traceId,
        scopes: input.scopes,
        isWorkspaceOwner: input.isWorkspaceOwner,
        ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        ...(input.apiKeyPrefix ? { apiKeyPrefix: input.apiKeyPrefix } : {}),
        ...(input.apiKeySpaceIds ? { apiKeySpaceIds: input.apiKeySpaceIds } : {}),
        ...(input.ipHash ? { ipHash: input.ipHash } : {}),
        ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
      });
    },
    async dispatch(input: KnowledgeDispatchInput): Promise<KnowledgeDispatchResult> {
      if (input.route.operationId === 'API-OPS-STATUS') {
        return {
          status: 200,
          data: await runtime.operationsStatus({
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            workspaceId: input.context.workspaceId,
            memberId: input.context.memberId,
            scopes: input.context.scopes,
            isWorkspaceOwner: input.context.subject.isWorkspaceOwner ?? false,
            ...(input.context.subject.apiKeyId ? { apiKeyId: input.context.subject.apiKeyId } : {}),
            ...(input.context.subject.apiKeyPrefix
              ? { apiKeyPrefix: input.context.subject.apiKeyPrefix }
              : {}),
            ...(input.context.subject.spaceIds
              ? { apiKeySpaceIds: input.context.subject.spaceIds }
              : {}),
            ...(input.context.subject.ipHash ? { ipHash: input.context.subject.ipHash } : {}),
            ...(input.context.subject.userAgentHash
              ? { userAgentHash: input.context.subject.userAgentHash }
              : {}),
          }),
        };
      }
      const tenant = tenantContextOf(
        {
          memberId: input.context.memberId,
          workspaceIds: [input.context.workspaceId],
          scopes: input.context.scopes,
          authType: input.context.subject.authType,
          isWorkspaceOwner: input.context.subject.isWorkspaceOwner ?? false,
          ...(input.context.subject.apiKeyId ? { apiKeyId: input.context.subject.apiKeyId } : {}),
          ...(input.context.subject.apiKeyPrefix
            ? { apiKeyPrefix: input.context.subject.apiKeyPrefix }
            : {}),
          ...(input.context.subject.spaceIds ? { spaceIds: input.context.subject.spaceIds } : {}),
          ...(input.context.subject.ipHash ? { ipHash: input.context.subject.ipHash } : {}),
          ...(input.context.subject.userAgentHash
            ? { userAgentHash: input.context.subject.userAgentHash }
            : {}),
        },
        input.context.workspaceId,
        input.context.requestId,
        input.context.traceId,
      );
      if (isS04Operation(input.route.operationId)) {
        return state.ingestion.dispatch({
          operationId: input.route.operationId,
          params: input.params,
          query: input.query,
          headers: input.headers,
          body: input.body,
          context: tenant,
        });
      }
      return state.application.dispatch({
        operationId: input.route.operationId,
        params: input.params,
        query: input.query,
        headers: input.headers,
        body: input.body,
        context: tenant,
      });
    },
    log(input) {
      state.telemetry.log(input.event, {
        requestId: input.requestId,
        operation: input.operationId,
        ...input.details,
      });
    },
  };
  return runtime;
}

export function getKnowledgeApiRuntime(): Promise<TelemetryKnowledgeApiRuntime> {
  runtimePromise ??= bootstrapRuntime();
  return runtimePromise;
}

export async function getKnowledgeWorkerServices(): Promise<{
  processing: S06ProcessingApplication;
  s10Ops: S10OpsWorkerApplication;
  mongo: Awaited<ReturnType<typeof createKnowledgeConnections>>['mongo'];
  redis: Awaited<ReturnType<typeof createKnowledgeConnections>>['redis'];
  config: KnowledgeRuntimeConfig;
  close: () => Promise<void>;
}> {
  return (await getKnowledgeApiRuntime()).s06WorkerServices();
}

export function runtimeOperationIdsForTest(routes: readonly RouteEntry[]): string[] {
  return routes.map((route) => route.operationId);
}
