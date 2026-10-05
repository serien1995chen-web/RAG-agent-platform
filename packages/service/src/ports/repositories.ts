import type {
  CollectionSnapshot,
  DeleteJobSnapshot,
  KnowledgeBaseSnapshot,
  KnowledgeItemSnapshot,
  PageResult,
  PortCallOptions,
  ProcessingJobSnapshot,
  RequestContext,
} from './types';

/** PORT-DATA-001：所有查询强制 teamId；版本冲突返回 409。 */
export interface KnowledgeBaseRepository {
  create(
    input: {
      dataset: Omit<
        KnowledgeBaseSnapshot,
        'datasetId' | 'deleteTime' | 'version' | 'createTime' | 'updateTime'
      >;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ datasetId: string; version: number }>;
  get(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeBaseSnapshot>;
  update(
    input: {
      datasetId: string;
      version: number;
      patch: Partial<KnowledgeBaseSnapshot>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
  softDelete(
    input: { datasetId: string; version: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleteJobId: string }>;
}

/** PORT-DATA-002：树删除只覆盖同 teamId。 */
export interface CollectionRepository {
  create(
    input: {
      collection: Omit<
        CollectionSnapshot,
        'collectionId' | 'version' | 'createTime' | 'updateTime'
      >;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ collectionId: string }>;
  list(
    input: {
      datasetId: string;
      parentId?: string | null;
      page: number;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PageResult<CollectionSnapshot>>;
  update(
    input: {
      collectionId: string;
      version: number;
      patch: Partial<CollectionSnapshot>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
  deleteTree(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleteJobId: string }>;
}

/** PORT-DATA-003：upsert 幂等；dedupKey 唯一冲突必须稳定返回 409。 */
export interface KnowledgeItemRepository {
  bulkUpsert(
    input: { items: KnowledgeItemSnapshot[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ upserted: number; duplicates: number }>;
  updateIndexes(
    input: {
      dataId: string;
      version: number;
      indexes: KnowledgeItemSnapshot['indexes'];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
  deleteByScope(
    input: {
      datasetId: string;
      collectionId?: string;
      dataIds?: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ deleted: number }>;
}

/** PORT-DATA-004：单任务单领取；失败按 retryCount 预算。 */
export interface ProcessingJobRepository {
  enqueue(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }>;
  claim(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; lockTime: string }>;
  renew(
    input: { taskId: string; lockTime: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ lockTime: string }>;
  finish(
    input: {
      taskId: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
}

/** 设计文档 7.5 删除模块的 Repository；任务书 8.2 未单列，但依赖集需要它。 */
export interface DeleteJobRepository {
  create(
    input: {
      job: Omit<DeleteJobSnapshot, 'jobId' | 'createTime' | 'updateTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ jobId: string }>;
  get(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot>;
  listFailures(
    input: { jobId: string; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<{ resourceType: string; resourceId: string; reason: string }>>;
  retry(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }>;
}
