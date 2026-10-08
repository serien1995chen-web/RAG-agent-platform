/**
 * 外部环境变量名登记（设计文档 6.6 / 6.7）。
 * 仅配置层允许读取 process.env；变量名与默认值均为本项目自研（KB_ 前缀 + APP_WORKER_MODE）。
 */
export const ENV_KEYS = {
  appWorkerMode: 'APP_WORKER_MODE',
  instanceId: 'KB_INSTANCE_ID',
  dependencyBaselineId: 'KB_DEPENDENCY_BASELINE_ID',
  versionCheckPolicy: 'KB_VERSION_CHECK_POLICY',
  allowRuntimeOverride: 'KB_ALLOW_RUNTIME_OVERRIDE',
  connectTimeoutMs: 'KB_CONNECT_TIMEOUT_MS',
  requestTimeoutMs: 'KB_REQUEST_TIMEOUT_MS',
  mongoUri: 'KB_MONGO_URI',
  redisUrl: 'KB_REDIS_URL',
  pgUrl: 'KB_PG_URL',
  s3Endpoint: 'KB_S3_ENDPOINT',
  s3Region: 'KB_S3_REGION',
  s3Bucket: 'KB_S3_BUCKET',
  s3AccessKeyRef: 'KB_S3_ACCESS_KEY_REF',
  s3SecretKeyRef: 'KB_S3_SECRET_KEY_REF',
  otelExporterEndpointRef: 'KB_OTEL_EXPORTER_ENDPOINT_REF',
  logLevel: 'KB_LOG_LEVEL',
  mongoPoolSize: 'KB_MONGO_POOL_SIZE',
  redisConnections: 'KB_REDIS_CONNECTIONS',
  pgPoolSize: 'KB_PG_POOL_SIZE',
  s3Concurrency: 'KB_S3_CONCURRENCY',
  providerConcurrency: 'KB_PROVIDER_CONCURRENCY',
  batchSize: 'KB_BATCH_SIZE',
  queueConcurrency: 'KB_QUEUE_CONCURRENCY',
  queueWaitTimeoutMs: 'KB_QUEUE_WAIT_TIMEOUT_MS',
  providerTimeoutMs: 'KB_PROVIDER_TIMEOUT_MS',
  providerMaxRetries: 'KB_PROVIDER_MAX_RETRIES',
  eventPublishTimeoutMs: 'KB_EVENT_PUBLISH_TIMEOUT_MS',
  maxPushItems: 'KB_MAX_PUSH_ITEMS',
  maxRequestBodyBytes: 'KB_MAX_REQUEST_BODY_BYTES',
  maxRawTextBytes: 'KB_MAX_RAW_TEXT_BYTES',
  maxImagesPerRequest: 'KB_MAX_IMAGES_PER_REQUEST',
  devTeamId: 'KB_DEV_TEAM_ID',
  devTmbId: 'KB_DEV_TMB_ID',
  mongoDeprecatedIndexCleanup: 'KB_MONGO_DEPRECATED_INDEX_CLEANUP',
  externalMockMode: 'KB_EXTERNAL_MOCK_MODE',
} as const;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function readString(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function readNumber(env: EnvSource, key: string): number | undefined {
  const raw = readString(env, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function readBoolean(env: EnvSource, key: string): boolean | undefined {
  const raw = readString(env, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}
