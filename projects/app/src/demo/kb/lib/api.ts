import { demoFetch, type DemoFetchResult } from './demo-fetch';

/** demo 侧的类型化 API（字段以 handler / DTO 实测为准）。 */

export interface DatasetSummary {
  datasetId: string;
  teamId: string;
  parentId: string | null;
  type: string;
  name: string;
  intro?: string;
  avatar?: string;
  vectorModel?: string;
  indexVersion?: string;
  updateTime?: string;
  createTime?: string;
}

export interface DatasetListData {
  total: number;
  list: DatasetSummary[];
}

export interface DatasetDetailData {
  dataset: DatasetSummary;
  stats: { collections: number; datas: number };
}

export interface CollectionSummary {
  collectionId: string;
  datasetId: string;
  type: string;
  name: string;
  trainingState?: string;
  trainingMode?: string;
  remainingTraining?: number;
  updateTime?: string;
}

export interface CollectionListData {
  total: number;
  list: CollectionSummary[];
  cursor?: string | null;
}

export interface DataSummary {
  dataId: string;
  collectionId?: string;
  q?: string;
  a?: string;
  updateTime?: string;
}

export interface DataListData {
  total: number;
  list: DataSummary[];
}

export interface SearchCitation {
  dataId?: string;
  collectionId?: string;
  quoteText?: string;
  sourceName?: string;
  score?: number;
}

export interface SearchResultData {
  searchRes?: {
    citations?: SearchCitation[];
    stats?: Record<string, unknown>;
  };
  usingSimilarityFilter?: boolean;
}

export interface DeleteJobData {
  state: string;
  stage?: string;
  progress?: number;
  jobId?: string;
}

export interface TrainingQueueData {
  modes: { mode: string; queued: number; running: number }[] | Record<string, unknown>;
}

export interface PermissionSnapshot {
  permissionMask?: number;
  owner?: string;
  inheritPermission?: boolean;
  [key: string]: unknown;
}

type R<T> = Promise<DemoFetchResult<T>>;

export const api = {
  listDatasets(input: { page?: number; limit?: number } = {}): R<DatasetListData> {
    const params = new URLSearchParams();
    params.set('page', String(input.page ?? 1));
    params.set('limit', String(input.limit ?? 20));
    return demoFetch<DatasetListData>({ method: 'GET', path: `/api/core/dataset/list?${params}` });
  },

  createDataset(body: { name: string; type: 'dataset' | 'folder'; embeddingModel: string }) {
    return demoFetch<{ datasetId: string; state: string }>({
      method: 'POST',
      path: '/api/core/dataset/create',
      body: { name: body.name, type: body.type, models: { embeddingModel: body.embeddingModel } },
    });
  },

  getDataset(datasetId: string): R<DatasetDetailData> {
    return demoFetch<DatasetDetailData>({
      method: 'GET',
      path: `/api/core/dataset/detail?datasetId=${encodeURIComponent(datasetId)}`,
    });
  },

  updateDataset(body: { datasetId: string; version: number; name?: string; autoSync?: boolean }) {
    return demoFetch<{ version: number }>({
      method: 'POST',
      path: '/api/core/dataset/update',
      body,
    });
  },

  deleteDataset(datasetId: string, idempotencyKey: string) {
    return demoFetch<DeleteJobData>({
      method: 'POST',
      path: '/api/core/dataset/delete',
      body: { datasetId },
      headers: { 'idempotency-key': idempotencyKey },
    });
  },

  rebuildEmbedding(body: {
    datasetId: string;
    modelRef: { provider: string; model: string; dimension: number };
  }) {
    return demoFetch<{ state?: string }>({
      method: 'POST',
      path: '/api/core/dataset/rebuildEmbedding',
      body,
    });
  },

  listCollections(input: {
    datasetId: string;
    page?: number;
    limit?: number;
  }): R<CollectionListData> {
    const params = new URLSearchParams({
      datasetId: input.datasetId,
      page: String(input.page ?? 1),
      limit: String(input.limit ?? 50),
    });
    return demoFetch<CollectionListData>({
      method: 'GET',
      path: `/api/core/dataset/collection/list?${params}`,
    });
  },

  createTextCollection(body: { datasetId: string; text: string }) {
    return demoFetch<{ collectionId: string; insertLen: number }>({
      method: 'POST',
      path: '/api/core/dataset/collection/create/text',
      body,
    });
  },

  createFolderCollection(body: { datasetId: string; name: string }) {
    return demoFetch<{ collectionId: string }>({
      method: 'POST',
      path: '/api/core/dataset/collection/create/folder',
      body,
    });
  },

  createLinkCollection(body: { datasetId: string; link: string }) {
    return demoFetch<{ collectionId: string }>({
      method: 'POST',
      path: '/api/core/dataset/collection/create/link',
      body,
    });
  },

  deleteCollection(collectionId: string, idempotencyKey: string) {
    return demoFetch<DeleteJobData>({
      method: 'POST',
      path: '/api/core/dataset/collection/delete',
      body: { collectionId },
      headers: { 'idempotency-key': idempotencyKey },
    });
  },

  collectionTrainingStatus(collectionId: string) {
    return demoFetch<{ collectionId?: string; trainingState?: string; remainingTraining?: number }>(
      {
        method: 'GET',
        path: `/api/core/dataset/collection/trainingStatus?collectionId=${encodeURIComponent(collectionId)}`,
      },
    );
  },

  listData(input: { collectionId: string; page?: number; limit?: number }): R<DataListData> {
    const params = new URLSearchParams({
      collectionId: input.collectionId,
      page: String(input.page ?? 1),
      limit: String(input.limit ?? 20),
    });
    return demoFetch<DataListData>({
      method: 'GET',
      path: `/api/core/dataset/data/list?${params}`,
    });
  },

  insertData(body: { collectionId: string; q: string; a?: string }) {
    return demoFetch<{ dataId: string }>({
      method: 'POST',
      path: '/api/core/dataset/data/insertData',
      body,
    });
  },

  pushData(body: { collectionId: string; items: { q: string; a?: string }[] }) {
    return demoFetch<{ queued?: number }>({
      method: 'POST',
      path: '/api/core/dataset/data/pushData',
      body: { data: body.items.map((item) => ({ collectionId: body.collectionId, ...item })) },
    });
  },

  searchTest(body: {
    datasetId: string;
    text: string;
    limit?: number;
    similarity?: number;
    searchMode?: 'embedding' | 'fullText' | 'mixed' | 'hybrid';
  }) {
    return demoFetch<SearchResultData>({
      method: 'POST',
      path: '/api/core/dataset/searchTest',
      body,
    });
  },

  trainingQueue(datasetId: string): R<TrainingQueueData> {
    return demoFetch<TrainingQueueData>({
      method: 'GET',
      path: `/api/core/dataset/training/queue?datasetId=${encodeURIComponent(datasetId)}`,
    });
  },

  getDeleteJob(jobId: string): R<DeleteJobData> {
    return demoFetch<DeleteJobData>({
      method: 'GET',
      path: `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}`,
    });
  },

  deleteJobFailures(jobId: string) {
    return demoFetch<{ list?: unknown[]; total?: number }>({
      method: 'GET',
      path: `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}/failures`,
    });
  },

  retryDeleteJob(jobId: string) {
    return demoFetch<DeleteJobData>({
      method: 'POST',
      path: `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}/retry`,
      body: {},
    });
  },

  getPermission(datasetId: string): R<PermissionSnapshot> {
    return demoFetch<PermissionSnapshot>({
      method: 'GET',
      path: `/api/core/dataset/getPermission?datasetId=${encodeURIComponent(datasetId)}`,
    });
  },

  listTags(datasetId: string) {
    return demoFetch<{ list?: { tagId: string; name: string }[]; total?: number }>({
      method: 'GET',
      path: `/api/core/dataset/tag/list?datasetId=${encodeURIComponent(datasetId)}`,
    });
  },

  health() {
    return demoFetch<{ status: string; checks: { name: string; status: string }[] }>({
      method: 'GET',
      path: '/api/readyz',
    });
  },

  startup() {
    return demoFetch<{
      status: string;
      checks?: { name: string; status: string; durationMs?: number }[];
    }>({
      method: 'GET',
      path: '/api/startupz',
    });
  },
};
