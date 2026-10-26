import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { ObjectRefView } from './ports';

export type ImportKind =
  | 'files'
  | 'text'
  | 'url'
  | 'template'
  | 'backup'
  | 'api_library'
  | 'feishu'
  | 'yuque'
  | 'dingtalk';

export type ConnectorProvider = 'custom_api' | 'feishu' | 'yuque' | 'dingtalk';
export type CloudConnectorProvider = Exclude<ConnectorProvider, 'custom_api'>;

export interface ImportObjectDraft {
  id: string;
  provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
  bucket: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
}

export interface ImportSourceDraft {
  id: string;
  kind:
    | 'file'
    | 'text'
    | 'url'
    | 'template'
    | 'backup'
    | 'api_library'
    | 'feishu'
    | 'yuque'
    | 'dingtalk';
  name: string;
  directoryId: string | null;
  blobRefId: string | null;
  externalId: string | null;
  connectorId: string | null;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  parseProvider: 'liteparse' | 'sangfor' | 'somark' | 'textin' | 'doc2x';
  metadata: Record<string, unknown>;
  object?: ImportObjectDraft;
  replaceSourceId?: string;
}

export interface ImportSubmissionCommand {
  workspaceId: string;
  knowledgeSpaceId: string;
  directoryId: string | null;
  importKind: ImportKind;
  idempotencyKey: string;
  requestHash: string;
  configurationHash: string;
  sourceDrafts: readonly ImportSourceDraft[];
  parseConfigSnapshot: Record<string, unknown>;
  chunkingConfigSnapshot: Record<string, unknown>;
  qaConfigSnapshot: Record<string, unknown>;
  dryRun?: boolean;
  conflictStrategy?: 'fail' | 'skip' | 'overwrite';
}

export interface ImportSubmissionResult {
  parentJobId: string;
  sourceIds: readonly string[];
  status: 'queued' | 'succeeded';
  version: number;
  replayed: boolean;
  job: JobView;
  result?: Record<string, unknown> | null;
}

export interface ImportSubmissionPort {
  submit(command: ImportSubmissionCommand, context: TenantContext): Promise<ImportSubmissionResult>;
}

export interface BackupConflict {
  rowNumber: number;
  code: 'KNOWLEDGE_CONFLICT';
  existingSourceId: string;
  externalId: string;
}

export interface ImportPlanningPort extends ImportSubmissionPort {
  backupConflicts(
    spaceId: string,
    externalIds: readonly string[],
    context: TenantContext,
  ): Promise<BackupConflict[]>;
  createDryRunJob(
    input: {
      knowledgeSpaceId: string;
      idempotencyKey: string;
      requestHash: string;
      configurationHash: string;
      importKind: 'backup';
      dryRun?: boolean;
      conflicts: readonly BackupConflict[];
      actions: readonly Record<string, unknown>[];
    },
    context: TenantContext,
  ): Promise<ImportSubmissionResult>;
}

export interface ScopedAuthPort {
  authorize(input: {
    subject: {
      authType: 'jwt' | 'api_key';
      memberId: string;
      workspaceIds: readonly string[];
      scopes: readonly string[];
    };
    workspaceId: string;
    knowledgeSpaceId: string;
    requiredScope: 'knowledge:write';
  }): Promise<void>;
}

export interface IngestionObjectStorePort {
  readonly provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
  readonly bucket: string;
  putObject(
    input: {
      key: string;
      body: Uint8Array;
      sizeBytes: number;
      contentType: string;
      metadata?: Record<string, string>;
      workspaceId: string;
      knowledgeSpaceId: string;
      ttlExpireAt?: Date | null;
    },
    context: {
      workspaceId: string;
      knowledgeSpaceId: string;
      requestId: string;
      traceId: string;
    },
  ): Promise<{
    provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
    bucket: string;
    key: string;
    size: number;
    etag: string;
    sha256: string;
  }>;
  getObject(
    bucket: string,
    key: string,
    range: string | null,
    context: {
      workspaceId: string;
      knowledgeSpaceId: string;
      requestId: string;
      traceId: string;
    },
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    size: number;
    etag: string;
    contentType: string | null;
  }>;
  deleteObject(
    key: string,
    context: {
      workspaceId: string;
      knowledgeSpaceId: string;
      requestId: string;
      traceId: string;
    },
  ): Promise<{ deleted: boolean }>;
}

export interface IngestionContentResult {
  source: ImportSourceDraft;
  createdObjectKey: string | null;
}

export interface IngestionContentPort {
  materialize(input: {
    kind: ImportSourceDraft['kind'];
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    directoryId: string | null;
    parseProvider: ImportSourceDraft['parseProvider'];
    metadata: Record<string, unknown>;
    context: TenantContext;
    knowledgeSpaceId: string;
    connectorId?: string | null;
    externalId?: string | null;
  }): Promise<IngestionContentResult>;
  materializeText(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    name: string;
    text: string;
    context: TenantContext;
  }): Promise<IngestionContentResult>;
  materializeUrl(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    selector: string;
    snapshot: UrlSnapshot;
    context: TenantContext;
  }): Promise<IngestionContentResult>;
  materializeProviderContent(input: {
    kind: 'api_library' | 'feishu' | 'yuque' | 'dingtalk';
    knowledgeSpaceId: string;
    directoryId: string | null;
    connectorId: string | null;
    content: ProviderContent;
    context: TenantContext;
  }): Promise<IngestionContentResult>;
  materializeTemplate(input: {
    knowledgeSpaceId: string;
    directoryId: string | null;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    rows: number;
    backup: boolean;
    context: TenantContext;
  }): Promise<IngestionContentResult>;
  fileDraft(input: {
    object: ObjectRefView;
    directoryId: string | null;
    parseProvider: ImportSourceDraft['parseProvider'];
    metadata?: Record<string, unknown>;
  }): ImportSourceDraft;
  readObjectBytes(input: {
    ref: ObjectRefView;
    knowledgeSpaceId: string;
    maxBytes: number;
    context: TenantContext;
  }): Promise<Uint8Array>;
  compensate(objectKey: string, knowledgeSpaceId: string, context: TenantContext): Promise<void>;
}

export interface UrlSnapshot {
  finalUrl: string;
  safeUrl: string;
  urlHash: string;
  title: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface UrlImportAdapterPort {
  fetch(input: { url: string; selector: string; context: TenantContext }): Promise<UrlSnapshot>;
}

export interface TemplateRow {
  rowNumber: number;
  question: string;
  answer: string;
  indexes: string[];
  metadata: Record<string, unknown>;
  schemaVersion: number;
}

export interface TemplateParseResult {
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: TemplateRow[];
  diagnostics: Array<{ rowNumber: number | null; code: string; message: string }>;
}

export interface ImportTemplateParserPort {
  parse(input: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    backup: boolean;
    requestId: string;
    traceId: string;
  }): TemplateParseResult;
}

export interface ProviderCatalogItem {
  id: string;
  name: string;
  type: 'directory' | 'document';
}

export interface ProviderCatalogResult {
  provider: 'custom' | CloudConnectorProvider;
  items: ProviderCatalogItem[];
  nextCursor?: string | null;
}

export interface ProviderContent {
  externalId: string;
  title: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface CustomApiClientPort {
  catalog(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    parentId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult>;
  content(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    fileIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]>;
}

export interface CloudProviderClientPort {
  catalog(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult>;
  content(input: {
    provider: CloudConnectorProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]>;
}

export interface ConnectorConnectCommand {
  provider: ConnectorProvider;
  name: string;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
}

export interface ConnectorUpdateCommand {
  connectorId: string;
  version: number;
  name?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  syncEnabled?: boolean;
  syncIntervalMinutes?: number;
  credentialKeyVersion?: 1;
}

export interface ConnectorView {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: ConnectorProvider;
  name: string;
  status: 'active' | 'syncing' | 'paused' | 'failed' | 'deleting' | 'deleted';
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  nextSyncAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: Record<string, unknown> | null;
  cursorVersion: number;
  version: number;
  config: Record<string, unknown>;
  credentialMetadata: {
    provider: ConnectorProvider;
    schemaVersion: number;
    keyVersion: number;
    configured: boolean;
    redactedFields: string[];
  };
}

export interface ConnectorRepositoryPort {
  connect(
    spaceId: string,
    command: ConnectorConnectCommand,
    context: TenantContext,
  ): Promise<ConnectorView>;
  get(connectorId: string, context: TenantContext): Promise<ConnectorView>;
  findByProvider(
    spaceId: string,
    provider: ConnectorProvider,
    context: TenantContext,
  ): Promise<ConnectorView>;
  update(command: ConnectorUpdateCommand, context: TenantContext): Promise<ConnectorView>;
  delete(
    connectorId: string,
    version: number,
    context: TenantContext,
  ): Promise<{ id: string; status: 'accepted'; jobId: string | null }>;
  markSyncing(
    connectorId: string,
    command: { full: boolean; expectedCursorVersion?: number; requestHash: string },
    context: TenantContext,
  ): Promise<{ connector: ConnectorView; job: JobView }>;
  decryptCredentials(connectorId: string, context: TenantContext): Promise<Record<string, unknown>>;
}

export interface JobView {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  error: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
