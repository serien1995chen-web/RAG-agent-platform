import type {
  ImageQuery,
  JsonValue,
  ModelSelection,
  SearchRequest,
  SearchResult,
} from '@kb/contracts';
import type {
  CollectionSnapshot,
  ObjectRef,
  PageResult,
  PermissionContext,
  PortCallOptions,
  RequestContext,
  TenantContext,
} from './types';

// ---------------------------------------------------------------------------
// PORT-STORE-001 / 002 / 003
// ---------------------------------------------------------------------------

export interface FullTextHit {
  dataId: string;
  collectionId: string;
  score: number;
}

export interface FullTextStore {
  search(
    input: {
      datasetId: string;
      collectionIds?: string[];
      text: string;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<FullTextHit[]>;
  write(
    input: {
      datasetId: string;
      collectionId: string;
      dataId: string;
      text: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  deleteByDataId(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }>;
  deleteByDatasetIds(
    input: { datasetIds: string[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }>;
  deleteByCollectionIds(
    input: { collectionIds: string[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }>;
}

export interface VectorRecord {
  teamId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;
  indexId: string;
  indexVersion: string;
  vector: number[];
}

export interface VectorSearchHit {
  dataId: string;
  indexId: string;
  score: number;
}

export interface VectorController {
  insert(
    input: { records: VectorRecord[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ inserted: number }>;
  delete(
    input: {
      dataIds?: string[];
      datasetId?: string;
      collectionId?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ deleted: number }>;
  embRecall(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      collectionIds?: string[];
      vector: number[];
      limit: number;
      indexVersion?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorSearchHit[]>;
  getVectorDataByTime(
    input: {
      teamId: string;
      datasetId: string;
      from: string;
      to: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorRecord[]>;
  getVectorCount(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<number>;
}

/**
 * 分片上传输入（设计文档 7.6 PORT-STORE-003）：沿用 PortCallOptions 与 RequestContext 租户校验。
 * datasetId 为调用方**已授权**的 Dataset 作用域；dataset/ 前缀 key 必须与之一致，
 * 禁止从 key 反推 datasetId（否则可绕过 Dataset ACL）。
 */
export interface MultipartPartUpload {
  ref: ObjectRef;
  uploadId: string;
  partNumber: number;
  body: Uint8Array;
  checksum: string;
  options: PortCallOptions;
  datasetId?: string;
}

/** 分片上传回执：partNumber + etag 供 completeMultipart 合并，size 供总大小校验。 */
export interface MultipartPartReceipt {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectStorePort {
  put(
    input: { ref: ObjectRef; body: Uint8Array; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<ObjectRef>;
  get(
    input: { ref: ObjectRef; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<{ ref: ObjectRef; body: Uint8Array }>;
  delete(
    input: { ref: ObjectRef; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<{ deleted: boolean }>;
  promote(
    input: { ref: ObjectRef; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<ObjectRef>;
  prepareMultipart(
    input: { ref: ObjectRef; parts: number; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<ObjectRef>;
  uploadPart(input: MultipartPartUpload, context: RequestContext): Promise<MultipartPartReceipt>;
  completeMultipart(
    input: {
      ref: ObjectRef;
      uploadId: string;
      parts: readonly MultipartPartReceipt[];
      hash: string;
      options: PortCallOptions;
      datasetId?: string;
    },
    context: RequestContext,
  ): Promise<ObjectRef>;
  abort(
    input: { ref: ObjectRef; options: PortCallOptions; datasetId?: string },
    context: RequestContext,
  ): Promise<{ aborted: boolean }>;
}

// ---------------------------------------------------------------------------
// PORT-PERM-001 / 002 / 003
// ---------------------------------------------------------------------------

export interface CollaboratorPermission {
  collaboratorType: 'member' | 'group' | 'org' | 'owner';
  collaboratorId: string;
  permissionMask: number;
}

export interface PermissionSnapshotValue {
  owner: string;
  permissionMask: number;
  inherited: boolean;
  version: number;
  source: 'local' | 'migrated' | 'owner-transfer';
  collaboratorSummary?: CollaboratorPermission[];
}

export interface DatasetPermissionPort {
  getPermission(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue>;
  resumeInherit(
    input: { datasetId: string; version: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue>;
  updateCollaborators(
    input: {
      datasetId: string;
      expectedVersion: number;
      collaborators: CollaboratorPermission[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue>;
}

export interface UpdateDatasetCollaboratorsPort {
  update(
    input: {
      datasetId: string;
      expectedVersion: number;
      collaborators: CollaboratorPermission[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue>;
}

export interface TransferDatasetOwnerPort {
  transfer(
    input: {
      datasetId: string;
      targetTmbId: string;
      transferId: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ before: PermissionSnapshotValue; after: PermissionSnapshotValue }>;
}

// ---------------------------------------------------------------------------
// PORT-EXT-001 .. PORT-EXT-005 + DatasetSearchPort（11.0）
// ---------------------------------------------------------------------------

export interface SourceReadRequest {
  datasetId: string;
  sourceType: string;
  sourceRef: string;
  /**
   * API Dataset（sourceType=apiFile）请求级配置：携带 provider/credentialRef/endpointRef/timeoutMs。
   * 其他 sourceType 可省略；apiFile 缺失该字段按未配置处理（501017）。
   */
  apiConfig?: ApiDatasetConfig;
  options: PortCallOptions;
}

export interface SourceReadResult {
  rawText?: string;
  fileRef?: string;
  contentHash: string;
  etag?: string;
}

/** API Dataset 能力声明（设计文档 12.8.2 `ApiDatasetCapabilities`）。 */
export interface ApiDatasetCapability {
  name: string;
  supported: boolean;
  constraints?: Record<string, JsonValue>;
}

/**
 * API Dataset 配置（设计文档 12.8.2 `ApiDatasetConfig`）。
 * provider 选择第三方实现；capabilities 未声明即拒绝调用（501019）。
 */
export interface ApiDatasetConfig {
  provider: 'doc2x' | 'somark' | 'textin' | 'custom';
  credentialRef: string;
  endpointRef?: string;
  timeoutMs?: number;
  capabilities: ApiDatasetCapability[];
}

export interface ApiDatasetCatalogRequest {
  datasetId: string;
  apiConfig: ApiDatasetConfig;
  parentId?: string;
  options: PortCallOptions;
}

export interface ApiDatasetPathNamesRequest {
  datasetId: string;
  apiConfig: ApiDatasetConfig;
  nodeId: string;
  options: PortCallOptions;
}

export interface ApiDatasetListRequest {
  datasetId: string;
  apiConfig: ApiDatasetConfig;
  parentId?: string;
  keyword?: string;
  options: PortCallOptions;
}

export interface DatasetSourceProvider {
  read(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult>;
  preview(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult>;
  /** 按 parentId 返回目录节点；结果按 teamId+datasetId+provider+parentId 缓存 5 分钟。 */
  getCatalog?(request: ApiDatasetCatalogRequest, context: RequestContext): Promise<JsonValue[]>;
  /** 按 nodeId 递归返回节点路径字符串。 */
  getPathNames?(request: ApiDatasetPathNamesRequest, context: RequestContext): Promise<string>;
  /** 按 parentId/keyword 返回第三方文件列表（对应 ApiAPIDS003.list）。 */
  list?(request: ApiDatasetListRequest, context: RequestContext): Promise<JsonValue[]>;
}

export interface TaskEnvelope<TPayload = unknown> {
  taskId: string;
  teamId: string;
  datasetId?: string;
  collectionId?: string;
  dataId?: string;
  mode: string;
  payload: TPayload;
}

export interface TaskResult {
  state: 'success' | 'retry' | 'failed';
  producedItems?: number;
  errorMsg?: string;
}

export interface TrainingProcessorPort {
  process(task: TaskEnvelope, context: RequestContext): Promise<TaskResult>;
}

/** 训练处理器的依赖收敛在 Ports 层，避免 processing 跨模块导入 collection/index/item 内部实现。 */
export interface TrainingCollectionPort {
  get(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<CollectionSnapshot>;
  markTrainingState(
    input: {
      collectionId: string;
      trainingState: 'running' | 'error' | 'ready';
      remainingTraining: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
}

export interface TrainingDatasetPort {
  findByDatasetId(
    input: { datasetId: string },
    context: RequestContext,
  ): Promise<{ vectorModel: string; indexVersion: string } | null>;
}

export interface TrainingEmbeddingPort {
  embed(
    input: { models: ModelSelection; texts: string[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<number[][]>;
}

export interface TrainingInsertPort {
  insertDirect(
    input: {
      dataId: string;
      datasetId: string;
      collectionId: string;
      q: string;
      a?: string;
      indexType?: string;
      chunkIndex?: number;
      indexVersion?: string;
      vector: number[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ dataId: string; inserted: number; duplicates: number; dedupKey: string }>;
}

export interface ImageTaskResult {
  imageId: string;
  state: 'success' | 'failed';
  description?: string;
  errorMsg?: string;
}

export interface ImageTrainingProcessorPort {
  processImage(
    task: TaskEnvelope<{ imageRef: ObjectRef }>,
    imageRef: ObjectRef,
    context: RequestContext,
  ): Promise<ImageTaskResult>;
}

export interface SyncResult {
  state: 'active' | 'error';
  changed: number;
  removed: number;
  errorMsg?: string;
}

export interface DatasetSyncPort {
  sync(
    input: { datasetId: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<SyncResult>;
}

export interface PdfResult {
  state: 'pending' | 'done' | 'failed';
  text?: string;
  errorMsg?: string;
}

export interface PdfEnhanceProviderPort {
  upload(
    input: { ref: ObjectRef; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ providerTaskId: string }>;
  parse(
    input: { providerTaskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PdfResult>;
  poll(
    input: { providerTaskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PdfResult>;
  cancel(
    input: { providerTaskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ cancelled: boolean }>;
}

/** 设计文档 11.0：只读生产检索契约；searchBatch ≤ 10，逐条独立降级。 */
export interface DatasetSearchPort {
  search(request: SearchRequest, context: RequestContext): Promise<SearchResult>;
  searchBatch(requests: SearchRequest[], context: RequestContext): Promise<SearchResult[]>;
}

// ---------------------------------------------------------------------------
// PORT-ADMIN-001 / ARCHIVE / FAIL / RECON / MIG / INDEX
// ---------------------------------------------------------------------------

export interface AdminDatasetPort {
  migrate(
    input: { version: string; scope: unknown; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ runId: string; state: string }>;
  reconcile(
    input: { window: string; scope: unknown; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ reportId: string }>;
  report(
    input: { window: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<unknown>;
}

export interface ArchiveStatusPort {
  status(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ archived: boolean; state?: string }>;
}

export interface FailureRecord {
  resourceType: string;
  resourceId: string;
  reason: string;
  retryable: boolean;
}

export interface FailureQueryPort {
  query(
    input: { scope: unknown; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<FailureRecord>>;
}

export interface ReconcileResultPort {
  publish(
    input: { report: unknown; dedupKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }>;
}

export interface MigrationRegistryPort {
  dryRun(
    input: { version: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ diff: unknown; state: string }>;
  apply(
    input: { version: string; scope: unknown; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }>;
  resume(
    input: { runId: string; cursor: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }>;
  rollback(
    input: { runId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }>;
}

export interface IndexDiff {
  created: string[];
  dropped: string[];
  skipped: string[];
  errors: string[];
}

export interface MongoIndexManagerPort {
  inspect(
    input: { collection: string; dryRun: boolean; options: PortCallOptions },
    context: RequestContext,
  ): Promise<IndexDiff>;
  sync(
    input: { collection: string; dryRun: boolean; options: PortCallOptions },
    context: RequestContext,
  ): Promise<IndexDiff>;
  cleanup(
    input: {
      collection: string;
      deprecatedNames: string[];
      dryRun: boolean;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ dropped: string[]; skipped: string[] }>;
}

// ---------------------------------------------------------------------------
// PORT-EVENT-001 / NOTIFY-001 / NOTIFY-002
// ---------------------------------------------------------------------------

export interface DatasetEvent {
  eventId: string;
  teamId: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  resourceVersion: number;
  idempotencyKey: string;
  payload?: unknown;
}

export interface DatasetEventPort {
  publish(event: DatasetEvent, context: RequestContext): Promise<{ accepted: boolean }>;
}

export interface NotificationEvent {
  notificationId: string;
  teamId: string;
  kind: string;
  payload?: unknown;
}

export interface DatasetNotificationPort {
  onDatasetChange(
    event: NotificationEvent,
    context: RequestContext,
  ): Promise<{ delivered: boolean }>;
  onFailure(event: NotificationEvent, context: RequestContext): Promise<{ delivered: boolean }>;
}

export interface Notification {
  channel: string;
  recipientRef: string;
  messageKey: string;
  params?: Record<string, unknown>;
}

export interface NotifyPort {
  send(notification: Notification, context: RequestContext): Promise<{ delivered: boolean }>;
}

// ---------------------------------------------------------------------------
// PORT-AUDIT-001 / CTX-001 .. CTX-004 / HEALTH-001
// ---------------------------------------------------------------------------

export interface AuditRecord {
  eventId: string;
  teamId: string;
  actorTmbId: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  requestId: string;
  payload?: unknown;
}

export interface AuditPort {
  append(record: AuditRecord, context: RequestContext): Promise<{ auditId: string }>;
}

export interface TenantContextProvider {
  fromRequest(request: unknown, requestId: string): Promise<TenantContext | null>;
}

export interface TenantQuotaProvider {
  check(
    input: { operation: string; amount: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ allowed: boolean; limit?: number; current?: number }>;
}

export interface FeatureFlagProvider {
  getFlag(
    input: { name: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ enabled: boolean }>;
}

export type DegradationMode = 'strict' | 'degraded' | 'offline';

export interface DegradationPolicy {
  mode(dependency: string): Promise<DegradationMode>;
}

export interface ProbeResult {
  name: string;
  status: 'ok' | 'degraded' | 'failed';
  durationMs: number;
}

export interface HealthProbePort {
  checkRequired(context: RequestContext): Promise<ProbeResult[]>;
  checkOptional(context: RequestContext): Promise<ProbeResult[]>;
}

// ---------------------------------------------------------------------------
// PORT-OBS-001 / 002
// ---------------------------------------------------------------------------

export interface DatasetMetricsPort {
  record(name: string, value: number, attributes: Record<string, string>): void;
}

export interface LoggerPort {
  log(event: string, fields: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// PORT-AUTH-001 / MODEL-001 / BACKUP-001 / LICENSE-001
// ---------------------------------------------------------------------------

export interface AuthSubject {
  teamId: string;
  tmbId: string;
  authType: 'token' | 'apiKey' | 'root';
  isRoot: boolean;
  sourceName?: string;
}

export interface AuthSubjectProvider {
  resolve(request: unknown, requestId: string): Promise<AuthSubject | null>;
}

export interface ModelCapability {
  modelId: string;
  dimension: number;
  capabilities: string[];
}

export interface ModelRegistryPort {
  listModels(
    input: { capability: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ModelSelection[]>;
  getCapability(
    input: { modelId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ModelCapability>;
  probe(
    input: { modelId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ModelCapability>;
}

export interface BackupToolPort {
  validate(
    input: { command: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ valid: boolean }>;
  run(
    input: { command: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ evidence: unknown }>;
  verify(
    input: { evidence: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ verified: boolean }>;
}

export interface SBOMGeneratorPort {
  generate(
    input: { lockfilePath: string; imageRef: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ sbomPath: string; noticePath?: string }>;
}

/** 供扩展点使用的权限上下文别名（设计文档 9.3）。 */
export type CallerPermissionContext = PermissionContext;

/** 供 Provider 读取的图片查询别名（设计文档 11.0）。 */
export type ProviderImageQuery = ImageQuery;
