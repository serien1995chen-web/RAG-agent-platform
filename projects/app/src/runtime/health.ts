import {
  ApiErrorException,
  DatasetApiService,
  EmbeddingService,
  HealthProbeService,
  MongoKnowledgeBaseRepository,
  createApiError,
  createKnowledgeItemIndexAdapter,
  createSourceCollectionRepository,
  resolveSecretRef,
  type AppConfig,
  type CollectionRepository,
  type DatasetSearchPort,
  type RequestContext,
} from '@kb/service';
import { createSearchEngine } from '../../../../packages/search/src/index';
import { CitationService } from '../../../../packages/service/src/modules/index/application/citation.service';
import { createPreviewSigner } from '../../../../sdk/storage/src/presign';
import { createDefaultExtensionRegistry, type ExtensionRegistry } from '../extensions';
import type { RuntimeClients } from './clients';
import {
  createDatasetSearchPort,
  createTextResolver,
  type DatasetSearchAdapterDeps,
} from '../../../../packages/service/src/modules/index/adapter/dataset-search.adapter';

export interface AppRuntime {
  config: AppConfig;
  clients: RuntimeClients;
  health: HealthProbeService;
  extensions: ExtensionRegistry;
  datasetApi: DatasetApiService;
  datasetSearch: DatasetSearchPort;
  startedAt: number;
  startup: { state: 'starting' | 'ready' | 'failed'; issues: string[] };
}

export function systemContext(requestId: string): RequestContext {
  return {
    requestId,
    tenant: { teamId: 'system', tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
  };
}

type CitationBuilder = NonNullable<DatasetSearchAdapterDeps['citationBuilder']>;

export function createCitationBuilder(config: AppConfig, clients: RuntimeClients): CitationBuilder {
  const s3 = (config as { system?: { s3?: AppConfig['system']['s3'] } } | undefined)?.system?.s3;
  if (!s3) {
    return new CitationService({ resolveImageRef: async () => null });
  }
  const previewSigner = createPreviewSigner({
    endPoint: new URL(s3.endpoint).hostname,
    port: Number(
      new URL(s3.endpoint).port || (new URL(s3.endpoint).protocol === 'https:' ? 443 : 80),
    ),
    useSSL: new URL(s3.endpoint).protocol === 'https:',
    accessKey: resolveSecretRef(s3.accessKeyRef),
    secretKey: resolveSecretRef(s3.secretKeyRef),
    region: s3.region,
  });
  return new CitationService({
    resolveImageRef: async (imageId, ctx) => {
      const imageModel = clients.mongo.models.ImageAsset;
      if (!imageModel) return null;
      const doc = (await imageModel
        .findOne({
          teamId: ctx.tenant.teamId,
          imageId,
        })
        .lean()) as unknown as { objectKey: string; datasetId: unknown } | null;
      if (!doc) return null;
      return {
        ref: { bucket: s3.bucket, key: doc.objectKey },
        datasetId: String(doc.datasetId),
      };
    },
    presignPreview: previewSigner,
  });
}

/** 真实依赖探针：探活 + 版本策略判定（版本只用于内部判定，不进入响应）。 */
export function buildHealthService(config: AppConfig, clients: RuntimeClients): HealthProbeService {
  const health = new HealthProbeService(config.system.timeouts.requestMs);
  const policy = config.system.versionCheckPolicy;

  health.registerVersionedProbe({
    name: 'mongo',
    required: true,
    dependency: 'mongo',
    policy,
    readVersion: async () => {
      const db = clients.mongo.db;
      if (!db) return null;
      const info = (await db.admin().serverInfo()) as { version?: unknown };
      return typeof info.version === 'string' ? info.version : null;
    },
  });

  health.registerVersionedProbe({
    name: 'redis',
    required: true,
    dependency: 'redis',
    policy,
    readVersion: async () => {
      const info = await clients.redis.info('server');
      const match = /redis_version:([^\r\n]+)/.exec(info);
      return match?.[1] ?? null;
    },
  });

  health.registerVersionedProbe({
    name: 'pgvector',
    required: true,
    dependency: 'pgvector',
    policy,
    readVersion: async () => {
      const result = await clients.pg.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      return result.rows[0]?.extversion ?? null;
    },
  });

  // object-store：S3 协议不暴露服务端构建版本（基线由部署镜像 digest 锁定，U-11），
  // 运行期只验证 bucket 可达。
  health.register({
    name: 'object-store',
    required: true,
    check: async () => {
      const startedAt = Date.now();
      await clients.objectStore.ensureBucket();
      return { name: 'object-store', status: 'ok', durationMs: Date.now() - startedAt };
    },
  });

  // 可选 otel exporter：仅在配置了引用时探测密钥可解析性；失败进入 degraded，不阻塞 readyz。
  health.register({
    name: 'otel-exporter',
    required: false,
    check: async () => {
      const startedAt = Date.now();
      const ref = config.system.otel.exporterEndpointRef;
      if (!ref) return { name: 'otel-exporter', status: 'ok', durationMs: 0 };
      try {
        resolveSecretRef(ref);
        return { name: 'otel-exporter', status: 'ok', durationMs: Date.now() - startedAt };
      } catch {
        return { name: 'otel-exporter', status: 'degraded', durationMs: Date.now() - startedAt };
      }
    },
  });

  return health;
}

let runtimePromise: Promise<AppRuntime> | undefined;

async function bootstrap(): Promise<AppRuntime> {
  const { getAppConfig } = await import('./config');
  const { createRuntimeClients } = await import('./clients');
  const config = getAppConfig();
  const clients = await createRuntimeClients(config);
  const health = buildHealthService(config, clients);
  const extensions = createDefaultExtensionRegistry({
    environment: config.system.environment,
    devIdentity: config.system.devIdentity,
  });
  const datasetApi = new DatasetApiService({
    repository: new MongoKnowledgeBaseRepository(clients.mongo),
  });
  const adapters = createKnowledgeItemIndexAdapter({
    pool: clients.pg,
    connection: clients.mongo,
  });
  const engine = createSearchEngine({
    vectors: adapters,
    fullText: adapters.fullText,
    embedding: new EmbeddingService({}),
    resolveTexts: createTextResolver(clients.mongo),
  });
  const collections: CollectionRepository = createSourceCollectionRepository(clients.mongo);
  const datasetSearch = createDatasetSearchPort({
    engine,
    connection: clients.mongo,
    collections,
    citationBuilder: createCitationBuilder(config, clients),
    datasetIndexVersion: async (datasetId, ctx) => {
      const summary = await new MongoKnowledgeBaseRepository(clients.mongo).findByDatasetId(
        { datasetId },
        ctx,
      );
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
  const runtime: AppRuntime = {
    config,
    clients,
    health,
    extensions,
    datasetApi,
    datasetSearch,
    startedAt: Date.now(),
    startup: { state: 'starting', issues: [] },
  };
  try {
    const required = await health.checkRequired(systemContext('startupz'));
    const summary = health.summarize(required, []);
    runtime.startup.state = summary.httpStatus === 200 ? 'ready' : 'failed';
    runtime.startup.issues = required
      .filter((check) => check.status === 'failed')
      .map((check) => check.name);
  } catch {
    runtime.startup.state = 'failed';
    runtime.startup.issues = ['bootstrap'];
  }
  return runtime;
}

export function getRuntime(): Promise<AppRuntime> {
  runtimePromise ??= bootstrap();
  return runtimePromise;
}
