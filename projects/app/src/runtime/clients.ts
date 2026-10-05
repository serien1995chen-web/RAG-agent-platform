import { createSafeLogger, initMetrics, initTracing, type SafeLogger } from '@kb/otel';
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
  return { ...clients, objectStore, logger };
}

export async function closeRuntimeClients(clients: RuntimeClients): Promise<void> {
  await closeInfrastructureClients(clients);
}
