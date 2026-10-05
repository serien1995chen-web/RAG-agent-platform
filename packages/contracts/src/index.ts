/**
 * @kb/contracts — 共享 DTO、Zod Schema、错误码、枚举与 OpenAPI 元数据（CR-REF-03）。
 * 权威来源：设计文档 12.3 / 12.4 / 12.8.2 / 12.9。
 */
export const PACKAGE_NAME = '@kb/contracts' as const;

export {
  ErrorParamsSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataMapSchema,
  ModelReferenceSchema,
  ObjectIdSchema,
} from './common/primitives';
export type { JsonValue, ModelReference } from './common/primitives';

export {
  ApiErrorSchema,
  ErrorFamilySchema,
  HealthCheckSchema,
  HealthResponseSchema,
  NoRequestBodySchema,
  PaginationSchema,
  RetryabilitySchema,
  SeveritySchema,
  apiResponseSchema,
} from './common/api-response';
export type {
  ApiError,
  ApiResponse,
  ErrorFamily,
  HealthResponse,
  Pagination,
  Retryability,
  Severity,
} from './common/api-response';

export {
  ERROR_CATALOG,
  ERROR_CATALOG_BY_CODE,
  SKELETON_INTERNAL_ERROR,
  SKELETON_INTERNAL_ERROR_META,
  SKELETON_NOT_IMPLEMENTED,
  SKELETON_NOT_IMPLEMENTED_META,
  getErrorMeta,
} from './errors/error-catalog';
export type { ErrorCatalogEntry } from './errors/error-catalog';

export {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createInternalError,
  createSkeletonError,
  toApiResponse,
} from './errors/error-factory';
export type { CreateApiErrorInput } from './errors/error-factory';

export {
  ACCEPTED_DATASET_TYPES,
  COLLECTION_TRAINING_STATES,
  DELETE_JOB_STATES,
  DatasetTypeSchema,
  INDEX_TYPES,
  IndexTypeSchema,
  REJECTED_DATASET_TYPES,
  SEARCH_MODES,
  SearchModeSchema,
  TRAINING_MODES,
  TRAINING_TASK_STATES,
  TrainingModeSchema,
  WEBSITE_DATASET_TYPE,
  datasetTypeRejection,
  isDatasetTypeAccepted,
} from './enums/dataset';
export type { DatasetType, IndexType, SearchMode, TrainingMode } from './enums/dataset';

export {
  DTO_SCHEMA_ERRORS,
  DTO_SPECS,
  dtoRegistry,
  getDtoSchema,
  missingDtoReferences,
  resolveDtoExpression,
  unwrapDtoExpression,
} from './dataset/registry';
export type { DtoSpec } from './dataset/registry';

export {
  ROUTE_REGISTRY,
  ROUTE_REGISTRY_BY_ID,
  routeMethods,
  validateRouteRegistry,
} from './openapi/route-registry';
export type { RouteEntry } from './openapi/route-registry';

export {
  CitationSchema,
  CitationScoreSchema,
  DegradedInfoSchema,
  ImageQuerySchema,
  ModelSelectionSchema,
  SEARCH_BATCH_LIMIT,
  SearchBudgetsSchema,
  SearchRequestSchema,
  SearchResultSchema,
  SearchStatsSchema,
  SearchVersionPolicySchema,
  SearchWeightsSchema,
  buildIndexVersion,
} from './dataset/search/types';
export type {
  Citation,
  CitationScore,
  DegradedInfo,
  ImageQuery,
  ModelSelection,
  SearchBudgets,
  SearchRequest,
  SearchResult,
  SearchStats,
  SearchVersionPolicy,
  SearchWeights,
} from './dataset/search/types';
