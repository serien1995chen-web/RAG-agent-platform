export { validateTenantContext } from './auth/tenant-context';
export type {
  AuthType,
  PermissionContext,
  RequestContext,
  TenantContext,
} from './auth/tenant-context';

export {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createSkeletonError,
  toApiResponse,
} from './errors/index';
export type { ApiError, ApiResponse, CreateApiErrorInput } from './errors/index';

export {
  collectionNameOf,
  defineIndex,
  getDeclaredIndexes,
  listDeclaredIndexes,
} from './persistence/define-index';
export type { IndexDeclaration } from './persistence/define-index';

export {
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetSchema,
  DatasetTagSchema,
  DatasetTrainingSchema,
  ImageAssetSchema,
  MONGO_SCHEMA_REGISTRY,
  registerMongoModels,
} from './persistence/schemas';
export type {
  DatasetAclDoc,
  DatasetCollectionDoc,
  DatasetDataDoc,
  DatasetDataTextDoc,
  DatasetDoc,
  DatasetTagDoc,
  DatasetTrainingDoc,
  ImageAssetDoc,
  RegisteredModels,
} from './persistence/schemas';

export {
  ConfigValidationException,
  DEFAULT_DATASET_RUNTIME_CONFIG,
  DatasetRuntimeConfigSchema,
  ENV_KEYS,
  PlatformCapacityProfileSchema,
  ProviderSelectionSchema,
  SystemConfigSchema,
  VersionCheckPolicySchema,
  WorkerModeSchema,
  loadConfigFromEnv,
  resolveSecretRef,
  resolveRuntimeRole,
  validateStartupConfig,
} from './config';
export type {
  AppConfig,
  DatasetRuntimeConfig,
  EnvSource,
  PlatformCapacityProfile,
  RuntimeRole,
  SystemConfig,
  VersionCheckPolicy,
  WorkerMode,
} from './config';

export { HealthProbeService, liveProbeResponse } from './health';
export type { DependencyProbe, HealthSummary } from './health';

export { tenantScopedModel } from './persistence/tenant-scoped-model';
export type { TenantScopedModel } from './persistence/tenant-scoped-model';
export { withMongoTransaction } from './persistence/with-mongo-transaction';

export {
  closeInfrastructureClients,
  createInfrastructureClients,
} from './runtime/infrastructure-clients';
export type { InfrastructureClients } from './runtime/infrastructure-clients';
export { createDegradedDatasetSearchPort } from './runtime/degraded-search-port';
