import type { ImageQuery, ModelSelection, SearchRequest, SearchResult } from '@kb/contracts';
import type {
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

export interface ObjectStorePort {
  put(
    input: { ref: ObjectRef; body: Uint8Array; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ObjectRef>;
  get(
    input: { ref: ObjectRef; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ ref: ObjectRef; body: Uint8Array }>;
  delete(
    input: { ref: ObjectRef; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: boolean }>;
  promote(
    input: { ref: ObjectRef; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ObjectRef>;
  prepareMultipart(
    input: { ref: ObjectRef; parts: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<ObjectRef>;
  abort(
    input: { ref: ObjectRef; options: PortCallOptions },
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
  options: PortCallOptions;
}

export interface SourceReadResult {
  rawText?: string;
  fileRef?: string;
  contentHash: string;
  etag?: string;
}

export interface DatasetSourceProvider {
  read(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult>;
  preview(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult>;
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
