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
  KnowledgeApplication,
  KnowledgeCatalogRepository,
  KnowledgeJobRepository,
  KnowledgeMockAuthProvider,
  KnowledgeTagRepository,
  RedisKnowledgeRateLimiter,
  createKnowledgeConnections,
  ensureKnowledgeCollections,
  ensurePgvectorDdl,
  loadKnowledgeRuntimeConfig,
  resolveSecretRef,
  tenantContextOf,
  type KnowledgeRuntimeConfig,
} from '@kb/service';
import { MinioKnowledgeObjectStore } from '@kb/storage';
import { Queue } from 'bullmq';
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
  telemetry: TelemetryRuntime;
}

interface TelemetryKnowledgeApiRuntime extends KnowledgeApiRuntime {
  withSpan<T>(name: string, attributes: SafeAttributes, fn: () => Promise<T> | T): Promise<T>;
  telemetryState(): TelemetryState;
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

  const application = new KnowledgeApplication(
    new KnowledgeCatalogRepository(mongo),
    new KnowledgeTagRepository(mongo),
    new KnowledgeAccessRepository(mongo),
    new KnowledgeJobRepository(mongo),
  );
  const queueAdapter = new BullMqQueueAdapter({ connection: redis });
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
      return state.application.dispatch({
        operationId: input.route.operationId,
        params: input.params,
        query: input.query,
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

export function runtimeOperationIdsForTest(routes: readonly RouteEntry[]): string[] {
  return routes.map((route) => route.operationId);
}
