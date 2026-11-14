'use client';

import {
  KnowledgeRequestError,
  knowledgeRequest,
  type ConsoleSession,
  ensureConsoleSession,
} from '../client/knowledge-client';
import type { KnowledgeProblem } from '@kb/contracts';
import type {
  Acl,
  BatchResult,
  CatalogItem,
  Collaborator,
  Connector,
  Directory,
  FileTicket,
  Job,
  KnowledgeSpace,
  Model,
  ModelBinding,
  PageResult,
  SearchResponse,
  Segment,
  SegmentHistory,
  Source,
  Tag,
} from './types';

export class CapabilityUnavailableError extends Error {
  constructor(
    readonly capability: string,
    message = '当前后端尚未提供该能力。',
  ) {
    super(message);
    this.name = 'CapabilityUnavailableError';
  }
}

function key(): string {
  return globalThis.crypto.randomUUID();
}

function queryString(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}

async function allPages<T>(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  sort?: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await knowledgeRequest<PageResult<T>>(
      `${path}${queryString({ ...params, limit: 200, cursor, sort })}`,
    );
    items.push(...page.items);
    cursor =
      page.pageInfo?.hasMore && page.pageInfo.nextCursor ? page.pageInfo.nextCursor : undefined;
  } while (cursor);
  return items;
}

export function productSession(): Promise<ConsoleSession> {
  return ensureConsoleSession();
}

export function productErrorView(error: unknown): {
  code: string;
  message: string;
  traceId?: string;
  requestId?: string;
  retryable?: boolean;
} {
  if (error instanceof CapabilityUnavailableError) {
    return { code: 'CAPABILITY_UNAVAILABLE', message: error.message };
  }
  if (error instanceof KnowledgeRequestError) {
    return {
      code: error.problem.error.code,
      message: localizedError(error.problem),
      traceId: error.problem.traceId,
      requestId: error.problem.requestId,
      retryable: error.problem.error.retryable,
    };
  }
  if (error instanceof Error && error.name === 'ConsoleSessionError') {
    return { code: 'KNOWLEDGE_AUTH_REQUIRED', message: '登录会话不可用，请重新登录后重试。' };
  }
  return { code: 'NETWORK_ERROR', message: '请求未完成，请检查网络后重试。' };
}

function localizedError(problem: KnowledgeProblem): string {
  const messages: Record<string, string> = {
    KNOWLEDGE_AUTH_REQUIRED: '登录状态已失效，请重新登录。',
    KNOWLEDGE_FORBIDDEN: '当前账号没有执行该操作的权限。',
    KNOWLEDGE_NOT_FOUND: '目标资源不存在或已被删除。',
    KNOWLEDGE_VALIDATION_FAILED: '提交内容校验失败，请检查表单。',
    KNOWLEDGE_CONFLICT: '数据已被其他操作更新，请刷新后重试。',
    KNOWLEDGE_REFERENCE_CONFLICT: '该知识库仍被应用或工作流引用，暂时不能删除。',
    KNOWLEDGE_RATE_LIMITED: '请求过于频繁，请稍后重试。',
    KNOWLEDGE_QUOTA_EXCEEDED: '当前工作区额度不足。',
    KNOWLEDGE_PAYLOAD_TOO_LARGE: '文件或提交内容超过大小限制。',
    KNOWLEDGE_UNSUPPORTED_CONTENT: '当前文件类型或内容不受支持。',
    KNOWLEDGE_DEPENDENCY_UNAVAILABLE: '依赖服务暂不可用，请稍后重试。',
    KNOWLEDGE_DEPENDENCY_TIMEOUT: '依赖服务响应超时，请稍后重试。',
    KNOWLEDGE_MODEL_FAILED: '模型服务调用失败，请稍后重试。',
    KNOWLEDGE_JOB_FAILED: '后台任务当前状态不允许该操作。',
    KNOWLEDGE_PARTIAL_SUCCESS: '操作仅部分成功，请检查失败项。',
  };
  return messages[problem.error.code] ?? '服务返回错误，请重试。';
}

export async function listSpaces(sort = '-updatedAt') {
  return allPages<KnowledgeSpace>('/v1/knowledge/spaces', {}, sort);
}

export function getSpace(spaceId: string) {
  return knowledgeRequest<KnowledgeSpace>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}`);
}

export function createSpace(input: {
  kind: 'space' | 'folder';
  parentSpaceId?: string | null;
  name: string;
  description?: string;
  iconKey?: string;
  accessMode?: 'workspace' | 'restricted';
  sourceAclMode?: 'inherited' | 'enforced';
  sourcePermissionEnabled?: boolean;
}) {
  return knowledgeRequest<KnowledgeSpace>('/v1/knowledge/spaces', {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      kind: input.kind,
      parentSpaceId: input.parentSpaceId ?? null,
      name: input.name,
      description: input.description ?? '',
      iconKey: input.iconKey ?? 'book-open',
      accessMode: input.accessMode ?? 'workspace',
      sourceAclMode: input.sourceAclMode ?? 'inherited',
      sourcePermissionEnabled: input.sourcePermissionEnabled ?? true,
    },
  });
}

export function updateSpace(
  spaceId: string,
  input: Partial<Omit<KnowledgeSpace, 'id' | 'workspaceId' | 'version'>> & { version: number },
) {
  return knowledgeRequest<KnowledgeSpace>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}`, {
    method: 'PATCH',
    idempotencyKey: key(),
    body: input,
  });
}

export function deleteSpace(
  space: KnowledgeSpace,
  referenceStrategy: 'block' | 'detach' = 'block',
) {
  return knowledgeRequest<void>(`/v1/knowledge/spaces/${encodeURIComponent(space.id)}`, {
    method: 'DELETE',
    idempotencyKey: key(),
    body: {
      version: space.version,
      expectedReferenceRevision: space.referenceRevision,
      referenceStrategy,
    },
  });
}

export function moveSpace(space: KnowledgeSpace, targetParentId: string | null) {
  return knowledgeRequest<KnowledgeSpace>(
    `/v1/knowledge/spaces/${encodeURIComponent(space.id)}/move`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { targetParentId, version: space.version },
    },
  );
}

export function batchSpaces(
  action: 'move' | 'delete',
  spaces: KnowledgeSpace[],
  targetParentId?: string | null,
) {
  return knowledgeRequest<BatchResult>('/v1/knowledge/spaces/batch-actions', {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      action,
      ids: spaces.map((space) => space.id),
      versions: Object.fromEntries(spaces.map((space) => [space.id, space.version])),
      ...(action === 'move' ? { targetParentId: targetParentId ?? null } : {}),
    },
  });
}

export function exportSpace(spaceId: string) {
  return knowledgeRequest<Job>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/exports`, {
    method: 'POST',
    idempotencyKey: key(),
    body: { format: 'zip' },
  });
}

export function downloadFile(blobId: string) {
  return knowledgeRequest<FileTicket>(
    `/v1/knowledge/files/${encodeURIComponent(blobId)}/download`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { disposition: 'attachment' },
    },
  );
}

export function transferSpaceOwnership(spaceId: string, targetMemberId: string, version: number) {
  return knowledgeRequest<KnowledgeSpace>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/ownership-transfer`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { targetMemberId, version },
    },
  );
}

export function listDirectories(spaceId: string) {
  return allPages<Directory>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/directories`,
    {},
    'name',
  );
}

export function createDirectory(
  spaceId: string,
  input: { name: string; parentDirectoryId: string | null },
) {
  return knowledgeRequest<Directory>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/directories`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: input,
    },
  );
}

export function updateDirectory(directory: Directory, name: string) {
  return knowledgeRequest<Directory>(
    `/v1/knowledge/directories/${encodeURIComponent(directory.id)}`,
    {
      method: 'PATCH',
      idempotencyKey: key(),
      body: { name, version: directory.version },
    },
  );
}

export function moveDirectory(directory: Directory, targetParentId: string | null) {
  return knowledgeRequest<Directory>(
    `/v1/knowledge/directories/${encodeURIComponent(directory.id)}/move`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { targetParentId, version: directory.version },
    },
  );
}

export function deleteDirectory(directory: Directory) {
  return knowledgeRequest<void>(`/v1/knowledge/directories/${encodeURIComponent(directory.id)}`, {
    method: 'DELETE',
    idempotencyKey: key(),
  });
}

export function listSources(spaceId: string) {
  return allPages<Source>(
    '/v1/knowledge/spaces/' + encodeURIComponent(spaceId) + '/sources',
    {},
    '-updatedAt',
  );
}

export function getSource(sourceId: string) {
  return knowledgeRequest<Source>(`/v1/knowledge/sources/${encodeURIComponent(sourceId)}`);
}

export function createSource(
  spaceId: string,
  input: { name: string; kind: Source['kind']; directoryId?: string | null },
) {
  return knowledgeRequest<Source>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/sources`, {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      kind: input.kind,
      name: input.name,
      directoryId: input.directoryId ?? null,
      searchEnabled: true,
      metadata: {},
    },
  });
}

export function updateSource(source: Source, input: { name?: string; searchEnabled?: boolean }) {
  return knowledgeRequest<Source>(`/v1/knowledge/sources/${encodeURIComponent(source.id)}`, {
    method: 'PATCH',
    idempotencyKey: key(),
    body: { ...input, version: source.version },
  });
}

export function deleteSource(source: Source) {
  return knowledgeRequest<void>(`/v1/knowledge/sources/${encodeURIComponent(source.id)}`, {
    method: 'DELETE',
    idempotencyKey: key(),
  });
}

export function moveSource(source: Source, targetDirectoryId: string | null) {
  return knowledgeRequest<Source>(`/v1/knowledge/sources/${encodeURIComponent(source.id)}/move`, {
    method: 'POST',
    idempotencyKey: key(),
    body: { targetParentId: targetDirectoryId, version: source.version },
  });
}

export function batchSources(
  action: 'move' | 'delete',
  sources: Source[],
  targetDirectoryId?: string | null,
) {
  return knowledgeRequest<BatchResult>('/v1/knowledge/sources/batch-actions', {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      action,
      ids: sources.map((source) => source.id),
      versions: Object.fromEntries(sources.map((source) => [source.id, source.version])),
      ...(action === 'move' ? { targetDirectoryId: targetDirectoryId ?? null } : {}),
    },
  });
}

export function downloadSource(sourceId: string) {
  return knowledgeRequest<FileTicket>(
    `/v1/knowledge/sources/${encodeURIComponent(sourceId)}/download`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { disposition: 'attachment' },
    },
  );
}

export function archiveSources(spaceId: string, sourceIds: string[]) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/source-archives`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { sourceIds },
    },
  );
}

export function downloadFileTicket(blobId: string) {
  return knowledgeRequest<FileTicket>(
    `/v1/knowledge/files/${encodeURIComponent(blobId)}/download`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { ttlSeconds: 300 },
    },
  );
}

export function transitionSourcePermission(
  source: Source,
  action: 'enable' | 'disable' | 'detach' | 'resume-inherit',
) {
  return knowledgeRequest<Acl>(
    `/v1/knowledge/sources/${encodeURIComponent(source.id)}/permissions/${action}`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        version: source.version,
        expectedPermissionRevision: source.permissionRevision,
      },
    },
  );
}

export function updateAcl(
  resourceType: 'space' | 'directory' | 'source',
  resourceId: string,
  input: {
    inheritMode: Acl['inheritMode'];
    entries: Acl['entries'];
  },
  version: number,
) {
  return knowledgeRequest<Acl>(
    `/v1/knowledge/resources/${resourceType}/${encodeURIComponent(resourceId)}/acl`,
    {
      method: 'PUT',
      idempotencyKey: key(),
      body: { inheritMode: input.inheritMode, entries: input.entries, version },
    },
  );
}

export function previewSource(sourceId: string) {
  return knowledgeRequest<{ sections: Array<{ title?: string; text: string; page?: number }> }>(
    `/v1/knowledge/sources/${encodeURIComponent(sourceId)}/preview`,
  );
}

export function previewFile(blobId: string) {
  return knowledgeRequest<FileTicket>(`/v1/knowledge/files/${encodeURIComponent(blobId)}/preview`, {
    method: 'POST',
    idempotencyKey: key(),
    body: { disposition: 'inline', expiresInSeconds: 300 },
  });
}

export function listSegments(sourceId: string) {
  return allPages<Segment>(
    `/v1/knowledge/sources/${encodeURIComponent(sourceId)}/segments`,
    {},
    'order',
  );
}

export function createSegment(
  sourceId: string,
  input: {
    question: string;
    answer: string;
    segmentType?: 'chunk' | 'qa';
    searchEnabled?: boolean;
    indexes?: Array<{
      indexId: string;
      type: 'custom';
      text: string;
      modelId: string;
    }>;
  },
) {
  return knowledgeRequest<Segment>(
    `/v1/knowledge/sources/${encodeURIComponent(sourceId)}/segments`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { ...input, searchEnabled: input.searchEnabled ?? true },
    },
  );
}

export function batchUpsertSegments(
  sourceId: string,
  items: Array<{
    question: string;
    answer: string;
    segmentType: 'chunk';
    searchEnabled?: boolean;
  }>,
) {
  return knowledgeRequest<BatchResult>('/v1/knowledge/segments/batch-actions', {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      action: 'upsert',
      items: items.map((item) => ({ sourceId, ...item })),
    },
  });
}

export function updateSegment(
  segment: Segment,
  input: { question?: string; answer?: string; searchEnabled?: boolean },
) {
  return knowledgeRequest<Segment>(`/v1/knowledge/segments/${encodeURIComponent(segment.id)}`, {
    method: 'PATCH',
    idempotencyKey: key(),
    body: { ...input, version: segment.version },
  });
}

export function deleteSegment(segment: Segment) {
  return knowledgeRequest<void>(`/v1/knowledge/segments/${encodeURIComponent(segment.id)}`, {
    method: 'DELETE',
    idempotencyKey: key(),
    body: { version: segment.version },
  });
}

export function getSegmentHistory(segmentId: string) {
  return knowledgeRequest<{ items: SegmentHistory[] }>(
    `/v1/knowledge/segments/${encodeURIComponent(segmentId)}/history`,
  );
}

export function createSegmentIndex(
  segment: Segment,
  input: { indexId: string; text: string; modelId: string },
) {
  return knowledgeRequest<Segment>(
    `/v1/knowledge/segments/${encodeURIComponent(segment.id)}/indexes`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        indexId: input.indexId,
        type: 'custom',
        text: input.text,
        modelId: input.modelId,
        version: segment.version,
      },
    },
  );
}

export function updateSegmentIndex(
  segment: Segment,
  index: Segment['indexes'][number],
  text: string,
) {
  return knowledgeRequest<Segment>(
    `/v1/knowledge/segments/${encodeURIComponent(segment.id)}/indexes/${encodeURIComponent(index.indexId)}`,
    {
      method: 'PATCH',
      idempotencyKey: key(),
      body: {
        indexId: index.indexId,
        type: index.type,
        text,
        modelId: index.modelId,
        version: segment.version,
      },
    },
  );
}

export function deleteSegmentIndex(segment: Segment, indexId: string) {
  return knowledgeRequest<{ id: string; status: string; jobId: string | null }>(
    `/v1/knowledge/segments/${encodeURIComponent(segment.id)}/indexes/${encodeURIComponent(indexId)}`,
    {
      method: 'DELETE',
      idempotencyKey: key(),
      body: { version: segment.version },
    },
  );
}

export function batchSegments(action: 'delete' | 'reindex', segments: Segment[]) {
  return knowledgeRequest<BatchResult>('/v1/knowledge/segments/batch-actions', {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      action,
      items: segments.map((segment) => ({ id: segment.id, version: segment.version })),
    },
  });
}

export function listTags(spaceId: string) {
  return allPages<Tag>('/v1/knowledge/spaces/' + encodeURIComponent(spaceId) + '/tags', {}, 'key');
}

export function createTag(
  spaceId: string,
  input: Pick<Tag, 'key' | 'label' | 'tagType' | 'required' | 'options'>,
) {
  return knowledgeRequest<Tag>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/tags`, {
    method: 'POST',
    idempotencyKey: key(),
    body: input,
  });
}

export function updateTag(
  tag: Tag,
  input: Partial<Pick<Tag, 'label' | 'required' | 'options' | 'status'>>,
) {
  return knowledgeRequest<Tag>(`/v1/knowledge/tags/${encodeURIComponent(tag.id)}`, {
    method: 'PATCH',
    idempotencyKey: key(),
    body: { ...input, version: tag.version },
  });
}

export function deleteTag(tag: Tag) {
  return knowledgeRequest<void>(`/v1/knowledge/tags/${encodeURIComponent(tag.id)}`, {
    method: 'DELETE',
    idempotencyKey: key(),
  });
}

export function applyTags(
  items: Array<{ sourceId: string; tagId: string; value: unknown }>,
  sourceVersions: Record<string, number>,
) {
  return knowledgeRequest<BatchResult>('/v1/knowledge/sources/tag-assignments', {
    method: 'POST',
    idempotencyKey: key(),
    body: { items, sourceVersions },
  });
}

export function listJobs() {
  return allPages<Job>('/v1/knowledge/jobs', {}, '-updatedAt');
}

export function getJob(jobId: string) {
  return knowledgeRequest<Job>(`/v1/knowledge/jobs/${encodeURIComponent(jobId)}`);
}

export function retryJob(job: Job) {
  return knowledgeRequest<Job>(`/v1/knowledge/jobs/${encodeURIComponent(job.jobId)}/retry`, {
    method: 'POST',
    idempotencyKey: key(),
    body: { version: job.version },
  });
}

export function listModels() {
  return allPages<Model>('/v1/knowledge/models', {}, 'modelType');
}

export function getModelBindings(spaceId: string) {
  return knowledgeRequest<PageResult<ModelBinding>>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/model-bindings`,
  );
}

export function updateModelBindings(spaceId: string, bindings: ModelBinding[], version: number) {
  return knowledgeRequest<PageResult<ModelBinding>>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/model-bindings`,
    {
      method: 'PUT',
      idempotencyKey: key(),
      body: { bindings, version },
    },
  );
}

export function getAcl(resourceType: 'space' | 'directory' | 'source', resourceId: string) {
  return knowledgeRequest<Acl>(
    `/v1/knowledge/resources/${resourceType}/${encodeURIComponent(resourceId)}/acl`,
  );
}

export function listCollaborators(spaceId: string) {
  return knowledgeRequest<PageResult<Collaborator>>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/collaborators?limit=200`,
  );
}

export function addCollaborator(
  spaceId: string,
  input: { memberId: string; role: Collaborator['role'] },
) {
  return knowledgeRequest<Collaborator>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/collaborators`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: input,
    },
  );
}

export function updateCollaborator(
  spaceId: string,
  collaborator: Collaborator,
  role: Collaborator['role'],
) {
  return knowledgeRequest<Collaborator>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/collaborators/${encodeURIComponent(collaborator.memberId)}`,
    {
      method: 'PATCH',
      idempotencyKey: key(),
      body: { role, version: collaborator.version },
    },
  );
}

export function removeCollaborator(spaceId: string, collaborator: Collaborator) {
  return knowledgeRequest<void>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/collaborators/${encodeURIComponent(collaborator.memberId)}`,
    {
      method: 'DELETE',
      idempotencyKey: key(),
    },
  );
}

export function connectConnector(
  spaceId: string,
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk',
  input: {
    name: string;
    credentials: Record<string, unknown>;
    config: Record<string, unknown>;
    syncEnabled?: boolean;
    syncIntervalMinutes?: number;
  },
) {
  return knowledgeRequest<Connector>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/connectors/${provider}/connect`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        provider,
        name: input.name,
        credentials: input.credentials,
        config: input.config,
        syncEnabled: input.syncEnabled ?? true,
        syncIntervalMinutes: input.syncIntervalMinutes ?? 60,
      },
    },
  );
}

export function connectorCatalog(
  spaceId: string,
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk',
  input: Record<string, unknown>,
) {
  return knowledgeRequest<{ items: CatalogItem[] }>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/connectors/${provider}/catalog`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: input,
    },
  );
}

export function importConnector(
  spaceId: string,
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk',
  input: { externalIds: string[]; directoryId?: string | null },
) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/connectors/${provider}/import`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: input,
    },
  );
}

export function getConnector(connectorId: string) {
  return knowledgeRequest<Connector>(`/v1/knowledge/connectors/${encodeURIComponent(connectorId)}`);
}

export function syncConnector(
  connectorId: string,
  input: { full?: boolean; expectedCursorVersion?: number; reason?: string } = {},
) {
  return knowledgeRequest<Job>(`/v1/knowledge/connectors/${encodeURIComponent(connectorId)}/sync`, {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      full: input.full ?? false,
      expectedCursorVersion: input.expectedCursorVersion,
      reason: input.reason,
    },
  });
}

export function search(mode: 'semantic' | 'fulltext' | 'hybrid', input: Record<string, unknown>) {
  const segment = mode === 'fulltext' ? 'full-text' : mode;
  return knowledgeRequest<SearchResponse>(`/v1/knowledge/search/${segment}`, {
    method: 'POST',
    idempotencyKey: key(),
    body: input,
  });
}

export function searchImage(input: Record<string, unknown>) {
  return knowledgeRequest<SearchResponse>('/v1/knowledge/search/image', {
    method: 'POST',
    idempotencyKey: key(),
    body: input,
  });
}

export function importFiles(
  spaceId: string,
  input: {
    uploadIds: string[];
    directoryId?: string | null;
    parseProvider?: string;
    parseConfig?: Record<string, unknown>;
    chunking: Record<string, unknown>;
  },
) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/files`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        uploadIds: input.uploadIds,
        directoryId: input.directoryId ?? null,
        parseProvider: input.parseProvider ?? 'liteparse',
        parseConfig: input.parseConfig ?? {},
        chunking: input.chunking,
      },
    },
  );
}

export function importText(
  spaceId: string,
  input: {
    name: string;
    text: string;
    directoryId?: string | null;
    chunking: Record<string, unknown>;
  },
) {
  return knowledgeRequest<Job>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/text`, {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      knowledgeSpaceId: spaceId,
      name: input.name,
      text: input.text,
      directoryId: input.directoryId ?? null,
      chunking: input.chunking,
    },
  });
}

export interface ImportTextPreview {
  name: string;
  contentHash: string;
  totalChunks: number;
  chunks: Array<{
    index: number;
    text: string;
    contentHash: string;
  }>;
  truncated: boolean;
}

export function previewImportText(
  spaceId: string,
  input: {
    name: string;
    text: string;
    directoryId?: string | null;
    chunking: Record<string, unknown>;
  },
) {
  return knowledgeRequest<ImportTextPreview>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/text`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        knowledgeSpaceId: spaceId,
        name: input.name,
        text: input.text,
        directoryId: input.directoryId ?? null,
        chunking: input.chunking,
        dryRun: true,
      },
    },
  );
}

export function importUrl(
  spaceId: string,
  input: { url: string; selector: string; directoryId?: string | null },
) {
  return knowledgeRequest<Job>(`/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/url`, {
    method: 'POST',
    idempotencyKey: key(),
    body: {
      url: input.url,
      selector: input.selector,
      directoryId: input.directoryId ?? null,
    },
  });
}

export function importTemplate(
  spaceId: string,
  input: { uploadId: string; directoryId?: string | null },
) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/template`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { uploadId: input.uploadId, directoryId: input.directoryId ?? null },
    },
  );
}

export function importBackup(
  spaceId: string,
  input: {
    uploadId: string;
    directoryId?: string | null;
    dryRun: boolean;
    conflictStrategy: 'fail' | 'skip' | 'overwrite';
  },
) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/backup`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: {
        uploadId: input.uploadId,
        directoryId: input.directoryId ?? null,
        dryRun: input.dryRun,
        conflictStrategy: input.conflictStrategy,
      },
    },
  );
}

export function apiLibraryCatalog(
  spaceId: string,
  input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    parentId?: string;
  },
) {
  return knowledgeRequest<{ items: CatalogItem[] }>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/api-library/catalog`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: input,
    },
  );
}

export function importApiLibrary(
  spaceId: string,
  input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    fileIds: string[];
    directoryId?: string | null;
  },
) {
  return knowledgeRequest<Job>(
    `/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/imports/api-library`,
    {
      method: 'POST',
      idempotencyKey: key(),
      body: { ...input, directoryId: input.directoryId ?? null },
    },
  );
}

export const productApi = {
  listSpaces,
  getSpace,
  createSpace,
  updateSpace,
  deleteSpace,
  moveSpace,
  batchSpaces,
  exportSpace,
  downloadFile,
  transferSpaceOwnership,
  listDirectories,
  createDirectory,
  updateDirectory,
  moveDirectory,
  deleteDirectory,
  listSources,
  getSource,
  createSource,
  updateSource,
  deleteSource,
  moveSource,
  batchSources,
  downloadSource,
  archiveSources,
  transitionSourcePermission,
  updateAcl,
  previewSource,
  previewFile,
  listSegments,
  createSegment,
  updateSegment,
  deleteSegment,
  getSegmentHistory,
  createSegmentIndex,
  updateSegmentIndex,
  deleteSegmentIndex,
  batchSegments,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  applyTags,
  listJobs,
  getJob,
  retryJob,
  listModels,
  getModelBindings,
  updateModelBindings,
  getAcl,
  listCollaborators,
  addCollaborator,
  updateCollaborator,
  removeCollaborator,
  connectConnector,
  connectorCatalog,
  importConnector,
  getConnector,
  syncConnector,
  search,
  searchImage,
  importFiles,
  importText,
  importUrl,
  importTemplate,
  importBackup,
  apiLibraryCatalog,
  importApiLibrary,
};
