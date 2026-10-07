import { createSafeLogger, initMetrics, initTracing, type SafeLogger } from '@kb/otel';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  RedisIdempotencyStore,
  type IdempotencyStore,
} from '@kb/dal';
import {
  closeInfrastructureClients,
  createInfrastructureClients,
  resolveSecretRef,
  type AppConfig,
  type InfrastructureClients,
} from '@kb/service';
import { createObjectStore, type ObjectStorePort } from '@kb/storage';

export interface RuntimeClients extends InfrastructureClients {
  objectStore: ObjectStorePort;
  logger: SafeLogger;
  idempotencyStore: IdempotencyStore;
}

export async function createRuntimeClients(config: AppConfig): Promise<RuntimeClients> {
  const otelConfig = {
    serviceName: config.system.instanceId,
    enabled: Boolean(config.system.otel.exporterEndpointRef),
    ...(config.system.otel.exporterEndpointRef !== undefined
      ? { exporterEndpointRef: config.system.otel.exporterEndpointRef }
      : {}),
    logLevel: config.system.otel.logLevel,
  };
  // 导出失败不影响业务：三入口内部已捕获并降级。
  initTracing(otelConfig);
  initMetrics(otelConfig);
  const logger = createSafeLogger({
    name: 'kb-app',
    level: config.system.otel.logLevel,
    enabled: true,
  });

  const endpoint = new URL(config.system.s3.endpoint);
  const objectStore = createObjectStore({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: resolveSecretRef(config.system.s3.accessKeyRef),
    secretKey: resolveSecretRef(config.system.s3.secretKeyRef),
    region: config.system.s3.region,
    bucket: config.system.s3.bucket,
  });

  const clients = createInfrastructureClients(config);
  // 先建立 Mongo 连接，避免探针访问未初始化的 connection.db。
  await clients.mongo.asPromise();
  // 请求级幂等复用既有 Redis 客户端；TTL 使用 @kb/dal 既有 24h 常量。
  const idempotencyStore = new RedisIdempotencyStore(
    clients.redis,
    DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  );
  return { ...clients, objectStore, logger, idempotencyStore };
}

export async function closeRuntimeClients(clients: RuntimeClients): Promise<void> {
  await closeInfrastructureClients(clients);
}
