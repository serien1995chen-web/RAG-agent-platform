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
  APPROVED_TEST_ONLY_DEPENDENCIES,
  DEPENDENCY_LEDGER_TOTALS,
  DEPENDENCY_OWNER_STAGE_COUNTS,
  DEPENDENCY_SCOPES,
  DEPENDENCY_SOURCES,
  DEPENDENCY_STAGES,
  NPM_DEPENDENCY_BASELINE,
  validateDependencyCatalog,
  validateDependencyLedger,
} from './dependencies/dependency-ledger';
export type {
  DependencyLedgerEntry,
  DependencyScope,
  DependencySource,
  DependencyStage,
} from './dependencies/dependency-ledger';

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
  CLOUD_CONNECTOR_PROVIDERS,
  CONNECTOR_PROVIDERS,
  ChunkingSettingsSchema,
  ConnectorCatalogRequestSchema,
  ConnectorConfigSchema,
  ConnectorConnectSchema,
  ConnectorCredentialsSchema,
  ConnectorImportSchema,
  ConnectorSyncSchema,
  ConnectorUpdateSchema,
  CustomApiConnectorConfigSchema,
  CustomApiCredentialsSchema,
  IMPORT_KINDS,
  ImportApiLibrarySchema,
  ImportBackupSchema,
  ImportFilesSchema,
  ImportTemplateSchema,
  ImportTextSchema,
  ImportUrlSchema,
  PARSE_PROVIDERS,
  credentialMetadataOf,
} from './knowledge/ingestion-contract';

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
  SearchModeSchema,
  SearchVersionPolicySchema,
  SearchWeightsSchema,
  buildIndexVersion,
} from './search/types';
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
  SearchMode,
  SearchVersionPolicy,
  SearchWeights,
} from './search/types';
