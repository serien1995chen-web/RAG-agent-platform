import {
  DEFAULT_DATASET_RUNTIME_CONFIG,
  DatasetRuntimeConfigSchema,
} from './dataset-runtime-config.schema';
import { ENV_KEYS, readBoolean, readNumber, readString, type EnvSource } from './env';
import { ConfigValidationException } from './config-error';
import {
  PlatformCapacityProfileSchema,
  type PlatformCapacityProfile,
} from './platform-capacity-profile.schema';
import { SystemConfigSchema, type SystemConfig } from './system-config.schema';
import { resolveRuntimeRole, type RuntimeRole } from './runtime-role';

export interface AppConfig {
  system: SystemConfig;
  datasetRuntime: ReturnType<typeof DatasetRuntimeConfigSchema.parse>;
  capacity: PlatformCapacityProfile;
  role: RuntimeRole;
}

function collectIssues(label: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => `${label}.${issue.path.map(String).join('.')}: ${issue.message}`);
}

/**
 * 唯一允许读取 process.env 的入口（设计文档 18.5）。
 * 业务代码必须通过 AppConfig 使用配置，不得直接读取环境变量。
 */
export function loadConfigFromEnv(env: EnvSource = process.env): AppConfig {
  const systemCandidate = {
    appWorkerMode: readString(env, ENV_KEYS.appWorkerMode),
    instanceId: readString(env, ENV_KEYS.instanceId),
    dependencyBaselineId: readString(env, ENV_KEYS.dependencyBaselineId),
    versionCheckPolicy: readString(env, ENV_KEYS.versionCheckPolicy) ?? 'strict',
    allowRuntimeOverride: readBoolean(env, ENV_KEYS.allowRuntimeOverride) ?? false,
    providerSelection: {
      vector: 'pgvector',
      fullText: 'mongo',
      objectStore: 's3',
      modelProvider: 'openai-compatible',
    },
    mongoUri: readString(env, ENV_KEYS.mongoUri),
    redisUrl: readString(env, ENV_KEYS.redisUrl),
    pgUrl: readString(env, ENV_KEYS.pgUrl),
    s3: {
      endpoint: readString(env, ENV_KEYS.s3Endpoint),
      region: readString(env, ENV_KEYS.s3Region),
      bucket: readString(env, ENV_KEYS.s3Bucket),
      accessKeyRef: readString(env, ENV_KEYS.s3AccessKeyRef),
      secretKeyRef: readString(env, ENV_KEYS.s3SecretKeyRef),
    },
    otel: {
      exporterEndpointRef: readString(env, ENV_KEYS.otelExporterEndpointRef),
      logLevel: readString(env, ENV_KEYS.logLevel) ?? 'info',
    },
    timeouts: {
      connectMs: readNumber(env, ENV_KEYS.connectTimeoutMs),
      requestMs: readNumber(env, ENV_KEYS.requestTimeoutMs),
    },
  };

  const system = SystemConfigSchema.safeParse(systemCandidate);
  if (!system.success) {
    throw new ConfigValidationException(collectIssues('system', system.error.issues));
  }

  const runtimeCandidate = {
    ...DEFAULT_DATASET_RUNTIME_CONFIG,
    eventPublishTimeoutMs:
      readNumber(env, ENV_KEYS.eventPublishTimeoutMs) ??
      DEFAULT_DATASET_RUNTIME_CONFIG.eventPublishTimeoutMs,
    queueWaitTimeoutMs:
      readNumber(env, ENV_KEYS.queueWaitTimeoutMs) ??
      DEFAULT_DATASET_RUNTIME_CONFIG.queueWaitTimeoutMs,
    maxPushItems:
      readNumber(env, ENV_KEYS.maxPushItems) ?? DEFAULT_DATASET_RUNTIME_CONFIG.maxPushItems,
    maxRequestBodyBytes:
      readNumber(env, ENV_KEYS.maxRequestBodyBytes) ??
      DEFAULT_DATASET_RUNTIME_CONFIG.maxRequestBodyBytes,
    maxRawTextBytes:
      readNumber(env, ENV_KEYS.maxRawTextBytes) ?? DEFAULT_DATASET_RUNTIME_CONFIG.maxRawTextBytes,
    maxImagesPerRequest:
      readNumber(env, ENV_KEYS.maxImagesPerRequest) ??
      DEFAULT_DATASET_RUNTIME_CONFIG.maxImagesPerRequest,
  };
  const datasetRuntime = DatasetRuntimeConfigSchema.safeParse(runtimeCandidate);
  if (!datasetRuntime.success) {
    throw new ConfigValidationException(
      collectIssues('datasetRuntime', datasetRuntime.error.issues),
    );
  }

  const capacityCandidate = {
    mongoPoolSize: readNumber(env, ENV_KEYS.mongoPoolSize),
    redisConnections: readNumber(env, ENV_KEYS.redisConnections),
    pgPoolSize: readNumber(env, ENV_KEYS.pgPoolSize),
    s3Concurrency: readNumber(env, ENV_KEYS.s3Concurrency),
    providerConcurrency: readNumber(env, ENV_KEYS.providerConcurrency),
    batchSize: readNumber(env, ENV_KEYS.batchSize),
    queueConcurrency: readNumber(env, ENV_KEYS.queueConcurrency),
    providerTimeoutMs: readNumber(env, ENV_KEYS.providerTimeoutMs),
    providerMaxRetries: readNumber(env, ENV_KEYS.providerMaxRetries),
  };
  const capacity = PlatformCapacityProfileSchema.safeParse(capacityCandidate);
  if (!capacity.success) {
    throw new ConfigValidationException(collectIssues('capacity', capacity.error.issues));
  }

  return {
    system: system.data,
    datasetRuntime: datasetRuntime.data,
    capacity: capacity.data,
    role: resolveRuntimeRole(system.data.appWorkerMode),
  };
}

export function validateStartupConfig(
  env: EnvSource = process.env,
): { ok: true; config: AppConfig } | { ok: false; exitCode: number; issues: readonly string[] } {
  try {
    return { ok: true, config: loadConfigFromEnv(env) };
  } catch (error) {
    if (error instanceof ConfigValidationException) {
      return { ok: false, exitCode: error.exitCode, issues: error.issues };
    }
    throw error;
  }
}

export { ENV_KEYS } from './env';
export type { EnvSource } from './env';
export { ConfigValidationException } from './config-error';
export { resolveSecretRef } from './secret-ref';
export { resolveRuntimeRole } from './runtime-role';
export type { RuntimeRole } from './runtime-role';
export {
  DEFAULT_DATASET_RUNTIME_CONFIG,
  DatasetRuntimeConfigSchema,
} from './dataset-runtime-config.schema';
export type { DatasetRuntimeConfig } from './dataset-runtime-config.schema';
export { PlatformCapacityProfileSchema } from './platform-capacity-profile.schema';
export type { PlatformCapacityProfile } from './platform-capacity-profile.schema';
export {
  ProviderSelectionSchema,
  SystemConfigSchema,
  VersionCheckPolicySchema,
  WorkerModeSchema,
} from './system-config.schema';
export type { SystemConfig, VersionCheckPolicy, WorkerMode } from './system-config.schema';
