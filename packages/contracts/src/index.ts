/**
 * @kb/contracts — Knowledge API 合同、运行时 registry 和共享错误。
 */
export const PACKAGE_NAME = '@kb/contracts' as const;

export {
  ErrorParamsSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataMapSchema,
  ModelReferenceSchema,
  ObjectIdSchema,
  VECTOR_DIMENSIONS,
} from './common/primitives';
export type { JsonValue, ModelReference, VectorDimension } from './common/primitives';

export {
  CursorPaginationSchema,
  HealthCheckSchema,
  HealthResponseSchema,
  KnowledgeErrorBodySchema,
  KnowledgeErrorCodeSchema,
  KnowledgeProblemSchema,
  knowledgeSuccessSchema,
} from './common/api-response';
export type {
  CursorPagination,
  HealthResponse,
  ApiResponse,
  KnowledgeErrorBody,
  KnowledgeErrorCode,
  KnowledgeProblem,
  KnowledgeResponse,
  KnowledgeSuccess,
} from './common/api-response';

export {
  KNOWLEDGE_ERROR_CATALOG,
  KNOWLEDGE_ERROR_CODES,
  KnowledgeApiError,
  createKnowledgeError,
  isKnowledgeErrorCode,
  knowledgeErrorDefinition,
} from './errors/knowledge-errors';
export type {
  CreateKnowledgeErrorInput,
  KnowledgeErrorDefinition,
} from './errors/knowledge-errors';

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
  DEFERRED_OPERATION_MANIFEST,
  FULL_ROUTE_REGISTRY,
  FULL_ROUTE_REGISTRY_BY_ID,
  RUNTIME_ROUTE_REGISTRY,
  RUNTIME_ROUTE_REGISTRY_BY_ID,
  TARGET_CONTRACT_COUNTS,
  matchRuntimeRoute,
  validateRouteRegistry,
} from './openapi/route-registry';
export type {
  DeferredRouteEntry,
  OperationGroup,
  PlannedStage,
  RouteEntry,
  RouteMatch,
} from './openapi/route-registry';
export { OPENAPI_DOCUMENT } from './openapi/document';

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
