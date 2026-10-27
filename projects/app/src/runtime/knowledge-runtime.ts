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
  S06JobApplication,
  S06ProcessingApplication,
  S6ProcessingRepository,
  AxiosS5HttpTransport,
  AxiosS5OcrHttpTransport,
  loadS5AiproxyConfig,
  loadS5RuntimeEnvironment,
  createS5ModelGateway,
  FixtureScopedAuthPort,
  FixtureQuotaGatePort,
  isS04Operation,
  KnowledgeAuditRepository,
  KnowledgeApplication,
  KnowledgeArchiveRepository,
  KnowledgeCatalogRepository,
  FileApplication,
  KnowledgeObjectRefRepository,
  KnowledgeOutboxDispatcher,
  KnowledgeReferenceRepository,
  KnowledgeMockAuthProvider,
  KnowledgeTagRepository,
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
} from '@kb/service';
import { FileTicketService } from '../../../../sdk/storage/src/file-ticket';
import { MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/providers/minio';
import { createDefaultDocumentParser, parseImportTemplate, parseWithLiteParse } from '@kb/parse';
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
  authProvider: KnowledgeMockAuthProvider;
  rateLimiter: RedisKnowledgeRateLimiter;
  application: KnowledgeApplication;
  ingestion: S04IngestionApplication;
  s5Models: S5ModelApplication;
  s5ModelBindings: S5ModelBindingApplication;
  s5Processing: S5ProcessingApplication;
  s5Ocr: S5OcrApplication;
  s06Jobs: S06JobApplication;
  s06Processing: S06ProcessingApplication;
  telemetry: TelemetryRuntime;
}

interface TelemetryKnowledgeApiRuntime extends KnowledgeApiRuntime {
  withSpan<T>(name: string, attributes: SafeAttributes, fn: () => Promise<T> | T): Promise<T>;
  telemetryState(): TelemetryState;
  s06WorkerServices(): {
    processing: S06ProcessingApplication;
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

async function measureReconciliation(state: RuntimeState, workspaceId: string) {
  const [orphanObjects, orphanVectors] = await Promise.all([
    state.mongo.models.KnowledgeObjectRef?.aggregate([
      { $match: { workspaceId, deletedAt: null, state: 'active', sourceId: { $ne: null } } },
      {
        $lookup: {
          from: 'knowledge_sources',
          let: { sourceId: '$sourceId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', '$$sourceId'] },
                workspaceId,
                deletedAt: null,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'source',
        },
      },
      { $match: { source: { $size: 0 } } },
      { $count: 'count' },
    ]),
    (async () => {
      let total = 0;
      for (const table of [
        'knowledge_segment_vectors_768',
        'knowledge_segment_vectors_1024',
        'knowledge_segment_vectors_1536',
        'knowledge_segment_vectors_3072',
      ]) {
        const result = await state.pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table}
           WHERE workspace_id = $1 AND (deleted_at IS NOT NULL OR search_enabled = false)`,
          [workspaceId],
        );
        total += Number(result.rows[0]?.count ?? 0);
      }
      return total;
    })(),
  ]);
  return {
    lastRunAt: new Date().toISOString(),
    orphanObjects: Number(
      (orphanObjects as Array<{ count?: number }> | undefined)?.[0]?.count ?? 0,
    ),
    orphanVectors,
  };
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
  const s5Usage = new S5UsageRepository(mongo);
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
    limiter: new S5KeyedSemaphore(10),
  });
  const s5Models = new S5ModelApplication(s5Catalog);
  const s5BindingRepository = new S5ModelBindingRepository(mongo);
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
  const s5Processing = new S5ProcessingApplication(s5Qa);
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
  const segmentIndexes = new KnowledgeSegmentIndexRepository(mongo, jobExecution, s5Catalog);
  const s6Processing = new S06ProcessingApplication({
    jobs: jobExecution,
    store: processingStore,
    artifacts: s5Artifacts,
    processing: s5Processing,
    vectors: vectorRepository,
    fulltext: fullTextRepository,
    models: s5Catalog,
    bindings: s5BindingRepository,
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
          texts: input.texts,
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
  const s06Jobs = new S06JobApplication(jobExecution, segmentIndexes, catalog, access);
  const credentialCipher = new KnowledgeCredentialCipher(
    resolveSecretRef(config.credentialEncryptionKeyRef),
  );
  const ingestionContent = new KnowledgeIngestionContentAdapter(objectStore);
  const ingestion = new S04IngestionApplication({
    imports: new KnowledgeImportRepository(mongo),
    connectors: new KnowledgeConnectorRepository(mongo, credentialCipher),
    objectRefs,
    content: ingestionContent,
    urlImport: new KnowledgeUrlImportAdapter(),
    customApi: new CustomApiLibraryClient(),
    providers: {
      feishu: new FeishuConnectorClient(),
      yuque: new YuqueConnectorClient(),
      dingtalk: new DingtalkConnectorClient(),
    },
    access,
    scopedAuth: new FixtureScopedAuthPort(),
    quotaGate: new FixtureQuotaGatePort(),
    templateParser: {
      parse(input) {
        return parseImportTemplate(input);
      },
    },
  });
  const fileTickets = new FileTicketService(
    resolveSecretRef(config.fileTicketSecretRef),
    config.filePublicBaseUrl,
  );
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
    authProvider: new KnowledgeMockAuthProvider(config.auth, config.environment),
    rateLimiter: new RedisKnowledgeRateLimiter(redis),
    application,
    ingestion,
    s5Models,
    s5ModelBindings,
    s5Processing,
    s5Ocr,
    s06Jobs,
    s06Processing: s6Processing,
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
        mongo: state.mongo,
        redis: state.redis,
        config: state.config,
        async close() {
          await Promise.all([state.mongo.close(), state.redis.quit(), state.pool.end()]);
        },
      };
    },
    async operationsStatus(input) {
      const health = await readiness(input.requestId);
      const queueDepth: Record<string, number> = {};
      for (const [name, queue] of state.queues) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        queueDepth[name] =
          (counts.waiting ?? 0) +
          (counts.active ?? 0) +
          (counts.delayed ?? 0) +
          (counts.failed ?? 0);
      }
      const vectorHealthy =
        health.body.checks.find((check) => check.name === 'postgres')?.status === 'ok';
      const storageHealthy =
        health.body.checks.find((check) => check.name === 's3')?.status === 'ok';
      return {
        status:
          vectorHealthy &&
          storageHealthy &&
          health.body.checks.every((check) => check.status !== 'down')
            ? 'ok'
            : 'degraded',
        queueDepth,
        storage: { provider: 'minio', healthy: storageHealthy },
        vector: {
          backend: 'pgvector',
          healthy: vectorHealthy,
          profiles: [768, 1024, 1536, 3072],
        },
        reconciliation: await measureReconciliation(state, input.workspaceId),
      };
    },
    async dispatch(input: KnowledgeDispatchInput): Promise<KnowledgeDispatchResult> {
      if (input.route.operationId === 'API-OPS-STATUS') {
        return {
          status: 200,
          data: await runtime.operationsStatus({
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            workspaceId: input.context.workspaceId,
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
