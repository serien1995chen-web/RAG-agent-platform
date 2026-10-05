import type { ApiError } from '@kb/contracts';

/** 设计文档 12.2 / 7.3：认证主体解析结果，teamId 只能由此得到。 */
export type AuthType = 'token' | 'apiKey' | 'root' | 'internal';

export interface TenantContext {
  teamId: string;
  tmbId: string;
  authType: AuthType;
  isRoot: boolean;
  sourceName?: string;
}

/** 设计文档 7.6：调用者权限上下文必须与 TenantContext 一起传入 Port。 */
export interface PermissionContext {
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  isOwner: boolean;
}

export interface RequestContext {
  requestId: string;
  tenant: TenantContext;
  permission: PermissionContext;
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** 外部 I/O 必须显式声明超时；缺省值由调用方按 Port 契约注入。 */
export interface PortCallOptions {
  timeoutMs: number;
  idempotencyKey?: string;
}

export interface PageResult<T> {
  total: number;
  list: T[];
  cursor: string | null;
}

export interface JobEnvelope<TPayload = unknown> {
  jobId: string;
  queue: string;
  mode: string;
  teamId: string;
  datasetId?: string;
  collectionId?: string;
  dataId?: string;
  payload: TPayload;
  retryCount: number;
  lockTime: string | null;
}

export interface JobHandler<TPayload = unknown, TResult = unknown> {
  handle(envelope: JobEnvelope<TPayload>, context: RequestContext): Promise<TResult>;
}

export interface JobDefinition {
  name: string;
  queue: string;
  modes: readonly string[];
  stableIdTemplate: string;
}

export interface KnowledgeBaseSnapshot {
  datasetId: string;
  teamId: string;
  parentId: string | null;
  type: string;
  name: string;
  intro?: string;
  vectorModel: string;
  agentModel?: string;
  vlmModel?: string;
  inheritPermission: boolean;
  autoSync: boolean;
  deleteTime: string | null;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface CollectionSnapshot {
  collectionId: string;
  teamId: string;
  datasetId: string;
  parentId: string | null;
  type: string;
  name: string;
  tagIds: string[];
  sourceRef?: string;
  trainingPolicy?: unknown;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface KnowledgeItemIndexValue {
  indexId: string;
  type: string;
  dataId: string;
  text: string;
  vectorRef?: string;
}

export interface KnowledgeItemSnapshot {
  dataId: string;
  teamId: string;
  datasetId: string;
  collectionId: string;
  q?: string;
  a?: string;
  imageId?: string;
  chunkIndex?: number;
  metadata?: unknown;
  indexes: KnowledgeItemIndexValue[];
  rebuilding: boolean;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface ProcessingJobSnapshot {
  taskId: string;
  jobId: string;
  teamId: string;
  datasetId: string;
  collectionId?: string;
  dataId?: string;
  mode: string;
  retryCount: number;
  lockTime: string | null;
  errorMsg?: string;
  weight?: number;
  expireAt: string | null;
}

export type DeleteJobState = 'marked' | 'queued' | 'deleting' | 'completed' | 'failed';

export interface DeleteJobSnapshot {
  jobId: string;
  teamId: string;
  datasetId: string;
  state: DeleteJobState;
  stage: string;
  progress: number;
  failureCount: number;
  createTime: string;
  updateTime: string;
}

export interface ObjectRef {
  bucket: string;
  key: string;
  size?: number;
  etag?: string;
  ttlExpireAt?: string | null;
  multipartUploadId?: string;
}

/**
 * 设计文档 7.6：Port 入口必须重新校验租户上下文。
 * 缺失租户字段时返回稳定错误 501012，禁止继续查询。
 */
export function validateTenantContext(
  tenant: TenantContext | null | undefined,
  requestId: string,
): { ok: true } | { ok: false; error: ApiError } {
  const missing: string[] = [];
  if (!tenant?.teamId) missing.push('teamId');
  if (!tenant?.tmbId) missing.push('tmbId');
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 501012,
        statusText: 'dataset.vector.tenant_context_missing',
        messageKey: 'dataset.vector.tenant_context_missing',
        params: { missing },
        message: 'Port 调用缺少租户上下文',
        errorType: 'storage',
        retryable: 'manual',
        severity: 'fatal',
        requestId,
      },
    };
  }
  return { ok: true };
}
