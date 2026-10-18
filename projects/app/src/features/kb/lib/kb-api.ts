import { hexToBytes, md5Hex } from './md5';
import type {
  CollectionListData,
  CollectionSummary,
  Collaborator,
  CreateCollectionResult,
  DataDetailData,
  DataListData,
  DatasetDetailData,
  DatasetListData,
  DeleteFailureList,
  DeleteJobData,
  PermissionSnapshot,
  SearchResultData,
  TagItem,
  TagListData,
  TrainingErrorsData,
  TrainingQueueData,
  UploadedFileRef,
} from '../types';

export interface ApiErrorPayload {
  code: number;
  status?: number;
  message?: string;
  messageKey?: string;
  params?: Record<string, unknown>;
  requestId?: string;
  errorType?: string | null;
  retryable?: string | null;
  severity?: string | null;
}

export class KbRequestError extends Error {
  constructor(readonly payload: ApiErrorPayload) {
    super(payload.messageKey ?? payload.message ?? `request_failed_${payload.code}`);
    this.name = 'KbRequestError';
  }
}

interface Envelope<T> extends ApiErrorPayload {
  data?: T | null;
}

export async function kbFetch<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const { body, headers, ...rest } = init;
  const isJson = body !== undefined && !(body instanceof FormData);
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(isJson ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: isJson ? JSON.stringify(body) : (body as BodyInit) } : {}),
  });
  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new KbRequestError({
      code: response.status,
      status: response.status,
      messageKey: 'network.invalid_response',
    });
  }
  if (!response.ok || envelope.code !== 200) {
    throw new KbRequestError({ ...envelope, status: response.status });
  }
  return envelope.data as T;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

function idempotencyKey(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function fileExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return match ? `.${match[1]?.toLowerCase()}` : '';
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function uploadFile(
  datasetId: string,
  file: File,
  onStage?: (stage: string) => void,
): Promise<UploadedFileRef> {
  onStage?.('正在申请上传');
  const presign = await kbFetch<{ uploadUrl: string; fileId: string; expiresAt: string }>(
    '/api/core/dataset/file/presignUpload',
    {
      method: 'POST',
      body: {
        datasetId,
        filename: file.name || `upload${fileExtension(file.name)}`,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      },
    },
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = await sha256Hex(bytes);
  const form = new FormData();
  form.append('partNumber', '1');
  form.append('checksum', checksum);
  form.append('chunk', file, file.name || 'upload');
  onStage?.('正在上传文件');
  const uploadResponse = await fetch(
    `${presign.uploadUrl}?fileId=${encodeURIComponent(presign.fileId)}`,
    { method: 'POST', body: form },
  );
  const uploadJson = (await uploadResponse.json()) as Envelope<{ etag: string }>;
  if (!uploadResponse.ok || uploadJson.code !== 200) {
    throw new KbRequestError({ ...uploadJson, status: uploadResponse.status });
  }
  const etag = String(uploadJson.data?.etag ?? '')
    .replace(/^"|"$/g, '')
    .toLowerCase();
  const multipartHash = `${md5Hex(hexToBytes(etag))}-1`;
  onStage?.('正在完成上传');
  const completed = await kbFetch<{ fileRef: string }>('/api/core/dataset/file/completeMultipart', {
    method: 'POST',
    body: {
      fileId: presign.fileId,
      parts: [{ partNumber: 1, etag }],
      hash: multipartHash,
    },
  });
  return { fileId: presign.fileId, fileRef: completed.fileRef };
}

export async function downloadBinary(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path);
  if (!response.ok) {
    let payload: ApiErrorPayload = {
      code: response.status,
      status: response.status,
      messageKey: 'network.download_failed',
    };
    try {
      payload = { ...(await response.json()), status: response.status };
    } catch {
      // 非 JSON 错误体保持状态码。
    }
    throw new KbRequestError(payload);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const kbApi = {
  listDatasets(input: { page?: number; limit?: number; type?: string; parentId?: string } = {}) {
    return kbFetch<DatasetListData>(
      `/api/core/dataset/list?${query({
        page: input.page ?? 1,
        limit: input.limit ?? 20,
        type: input.type,
        parentId: input.parentId,
      })}`,
    );
  },

  createDataset(input: { name: string; type: 'dataset' | 'folder'; embeddingModel?: string }) {
    return kbFetch<{ datasetId: string; state: string }>('/api/core/dataset/create', {
      method: 'POST',
      body: {
        name: input.name,
        type: input.type,
        models: { embeddingModel: input.embeddingModel ?? 'bge-m3' },
      },
    });
  },

  getDataset(datasetId: string) {
    return kbFetch<DatasetDetailData>(
      `/api/core/dataset/detail?datasetId=${encodeURIComponent(datasetId)}`,
    );
  },

  updateDataset(input: { datasetId: string; version: number; name?: string; autoSync?: boolean }) {
    return kbFetch<{ version: number }>('/api/core/dataset/update', {
      method: 'POST',
      body: input,
    });
  },

  deleteDataset(datasetId: string) {
    return kbFetch<DeleteJobData>('/api/core/dataset/delete', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('dataset-delete') },
      body: { datasetId },
    });
  },

  datasetPaths(datasetId: string) {
    return kbFetch<{ id: string; name: string; parentId: string | null }[]>(
      `/api/core/dataset/paths?${query({ sourceId: datasetId, type: 'dataset' })}`,
    );
  },

  moveDataset(input: { datasetId: string; targetParentId: string | null; version: number }) {
    return kbFetch<{ version: number }>('/api/core/dataset/move', {
      method: 'POST',
      body: input,
    });
  },

  listCollections(input: { datasetId: string; page?: number; limit?: number }) {
    return kbFetch<CollectionListData>(
      `/api/core/dataset/collection/list?${query({
        datasetId: input.datasetId,
        page: input.page ?? 1,
        limit: input.limit ?? 20,
      })}`,
    );
  },

  getCollection(collectionId: string) {
    return kbFetch<CollectionSummary>(
      `/api/core/dataset/collection/detail?${query({ collectionId })}`,
    );
  },

  createTextCollection(datasetId: string, text: string) {
    return kbFetch<CreateCollectionResult>('/api/core/dataset/collection/create/text', {
      method: 'POST',
      body: { datasetId, text },
    });
  },

  createFolderCollection(datasetId: string, name: string, parentId?: string) {
    return kbFetch<{ collectionId: string }>('/api/core/dataset/collection/create/folder', {
      method: 'POST',
      body: { datasetId, name, ...(parentId ? { parentId } : {}) },
    });
  },

  createLinkCollection(datasetId: string, link: string) {
    return kbFetch<{ collectionId: string }>('/api/core/dataset/collection/create/link', {
      method: 'POST',
      body: { datasetId, link },
    });
  },

  createEmptyCollection(datasetId: string, name: string, type: 'virtual' | 'file' = 'virtual') {
    return kbFetch<{ collectionId: string }>('/api/core/dataset/collection/create/empty', {
      method: 'POST',
      body: { datasetId, name, type },
    });
  },

  createFileCollection(datasetId: string, fileId: string) {
    return kbFetch<CreateCollectionResult>('/api/core/dataset/collection/create/file', {
      method: 'POST',
      body: { datasetId, fileId },
    });
  },

  createImagesCollection(datasetId: string, files: string[], trainingType = 'auto') {
    return kbFetch<{
      collectionId: string;
      items: { imageId?: string; dataId?: string; state: string; errorMsg?: string | null }[];
    }>('/api/core/dataset/collection/create/images', {
      method: 'POST',
      body: { datasetId, images: files, trainingType },
    });
  },

  updateCollection(input: {
    collectionId: string;
    version: number;
    name?: string;
    parentId?: string | null;
    tagIds?: string[];
  }) {
    return kbFetch<{ version: number }>('/api/core/dataset/collection/update', {
      method: 'POST',
      body: input,
    });
  },

  moveCollection(input: { collectionId: string; targetParentId: string | null; version: number }) {
    return kbFetch<{ version: number }>('/api/core/dataset/collection/move', {
      method: 'POST',
      body: input,
    });
  },

  syncCollection(collectionId: string) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/collection/sync', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('collection-sync') },
      body: { collectionId },
    });
  },

  retrainCollection(collectionId: string, policy: Record<string, unknown>) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/collection/retrain', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('collection-retrain') },
      body: { collectionId, policy },
    });
  },

  collectionTrainingStatus(collectionId: string) {
    return kbFetch<{ collectionId?: string; trainingState?: string; remainingTraining?: number }>(
      `/api/core/dataset/collection/trainingStatus?${query({ collectionId })}`,
    );
  },

  deleteCollection(collectionId: string) {
    return kbFetch<DeleteJobData>('/api/core/dataset/collection/delete', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('collection-delete') },
      body: { collectionId },
    });
  },

  async exportDataset(datasetId: string, name: string) {
    await downloadBinary(
      `/api/core/dataset/exportAll?datasetId=${encodeURIComponent(datasetId)}`,
      `${name || 'dataset'}.zip`,
    );
  },

  async exportCollection(collectionId: string, name: string) {
    await downloadBinary(
      `/api/core/dataset/collection/export?collectionId=${encodeURIComponent(collectionId)}`,
      `${name || 'collection'}.jsonl`,
    );
  },

  importCollection(form: FormData) {
    return kbFetch<{
      report?: { success?: number; skipped?: number; failed?: number };
      collectionId?: string;
    }>('/api/core/dataset/collection/import', { method: 'POST', body: form });
  },

  listData(input: { collectionId: string; page?: number; limit?: number; search?: string }) {
    return kbFetch<DataListData>(
      `/api/core/dataset/data/list?${query({
        collectionId: input.collectionId,
        page: input.page ?? 1,
        limit: input.limit ?? 20,
        search: input.search,
      })}`,
    );
  },

  getData(dataId: string) {
    return kbFetch<DataDetailData>(`/api/core/dataset/data/detail?${query({ dataId })}`);
  },

  updateData(input: { dataId: string; version: number; q?: string; a?: string }) {
    return kbFetch<{ version?: number }>('/api/core/dataset/data/update', {
      method: 'POST',
      body: input,
    });
  },

  deleteData(dataId: string) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/data/delete', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('data-delete') },
      body: { dataId },
    });
  },

  insertData(input: { collectionId: string; q: string; a?: string }) {
    return kbFetch<{ dataId: string }>('/api/core/dataset/data/insertData', {
      method: 'POST',
      body: input,
    });
  },

  pushData(collectionId: string, items: { q: string; a?: string }[]) {
    return kbFetch<{
      queued: { accepted: number; skipped: number; taskIds: string[] };
    }>('/api/core/dataset/data/pushData', {
      method: 'POST',
      body: { data: items.map((item) => ({ collectionId, ...item })) },
    });
  },

  insertImages(collectionId: string, files: string[]) {
    return kbFetch<{
      items: { imageId?: string; dataId?: string; state: string; errorMsg?: string | null }[];
    }>('/api/core/dataset/data/insertImages', {
      method: 'POST',
      body: { collectionId, files, trainingType: 'auto' },
    });
  },

  searchTest(input: {
    datasetId: string;
    text: string;
    searchMode?: 'embedding' | 'fullTextRecall' | 'mixedRecall';
    limit?: number;
    similarity?: number;
    usingReRank?: boolean;
    embeddingWeight?: number;
    rerankWeight?: number;
    collectionFilterMatch?: string;
  }) {
    return kbFetch<SearchResultData>('/api/core/dataset/searchTest', {
      method: 'POST',
      body: input,
    });
  },

  trainingQueue(datasetId: string) {
    return kbFetch<TrainingQueueData>(`/api/core/dataset/training/queue?${query({ datasetId })}`);
  },

  trainingDetail(taskId: string) {
    return kbFetch<Record<string, unknown>>(
      `/api/core/dataset/training/detail?${query({ taskId })}`,
    );
  },

  trainingErrors(datasetId: string) {
    return kbFetch<TrainingErrorsData>(
      `/api/core/dataset/training/errors?${query({ datasetId, limit: 50 })}`,
    );
  },

  trainingCollectionErrors(collectionId: string) {
    return kbFetch<{ errors: Record<string, unknown>[] }>(
      '/api/core/dataset/training/collectionErrors',
      { method: 'POST', body: { collectionId } },
    );
  },

  trainingHasError(datasetId: string) {
    return kbFetch<{ hasError: boolean }>(
      `/api/core/dataset/training/hasError?${query({ datasetId })}`,
    );
  },

  resumeTraining(taskId: string, reason: string) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/training/resume', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('training-resume') },
      body: { taskId, reason },
    });
  },

  listTags(datasetId: string) {
    return kbFetch<TagListData>(`/api/core/dataset/tag/list?${query({ datasetId })}`);
  },

  createTag(datasetId: string, name: string) {
    return kbFetch<TagItem>('/api/core/dataset/tag/create', {
      method: 'POST',
      body: { datasetId, name },
    });
  },

  addTag(datasetId: string, tagId: string, collectionIds: string[]) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/tag/addToCollections', {
      method: 'POST',
      body: { datasetId, tagId, collectionIds },
    });
  },

  removeTag(datasetId: string, tagId: string, collectionIds: string[]) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/tag/removeFromCollections', {
      method: 'POST',
      body: { datasetId, tagId, collectionIds },
    });
  },

  updateTag(datasetId: string, tagId: string, name: string, version: number) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/tag/update', {
      method: 'POST',
      body: { datasetId, tagId, name, version },
    });
  },

  deleteTag(datasetId: string, tagId: string) {
    return kbFetch<Record<string, unknown>>('/api/core/dataset/tag/delete', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey('tag-delete') },
      body: { datasetId, tagId },
    });
  },

  getPermission(datasetId: string) {
    return kbFetch<PermissionSnapshot>(`/api/core/dataset/getPermission?${query({ datasetId })}`);
  },

  resumeInherit(datasetId: string, version: number) {
    return kbFetch<{ permissionMask: number }>('/api/core/dataset/resumeInheritPermission', {
      method: 'POST',
      body: { datasetId, version },
    });
  },

  listCollaborators(datasetId: string) {
    return kbFetch<{ list?: Collaborator[]; collaborators?: Collaborator[]; version?: number }>(
      `/proApi/core/dataset/collaborator/list?${query({ datasetId })}`,
    );
  },

  getDeleteJob(jobId: string) {
    return kbFetch<DeleteJobData>(`/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}`);
  },

  listDeleteFailures(jobId: string) {
    return kbFetch<DeleteFailureList>(
      `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}/failures`,
    );
  },

  retryDeleteJob(jobId: string) {
    return kbFetch<{ accepted?: boolean }>(
      `/api/core/dataset/delete-jobs/${encodeURIComponent(jobId)}/retry`,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('delete-retry') },
        body: {},
      },
    );
  },
};

export function modelMode(): 'mock' | 'real' {
  // NEXT_PUBLIC_* 是构建期内联的展示开关，不含密钥，也不参与服务端配置解析。
  // eslint-disable-next-line no-restricted-properties
  return process.env.NEXT_PUBLIC_KB_MODEL_MODE === 'real' ? 'real' : 'mock';
}
