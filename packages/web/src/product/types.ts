export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PageResult<T> {
  items: T[];
  pageInfo?: PageInfo;
}

export interface KnowledgeSpace {
  id: string;
  workspaceId: string;
  kind: 'space' | 'folder';
  parentSpaceId: string | null;
  parentPath?: string[];
  name: string;
  description?: string;
  iconKey?: string;
  ownershipMemberId: string;
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled: boolean;
  modelBindings?: Record<string, unknown>;
  referenceRevision: number;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Directory {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  parentDirectoryId: string | null;
  name: string;
  path: string[];
  parentPath?: string[];
  depth: number;
  aclMode: 'inherited' | 'override';
  version: number;
}

export type SourceKind =
  | 'file'
  | 'text'
  | 'url'
  | 'template'
  | 'backup'
  | 'api_library'
  | 'feishu'
  | 'yuque'
  | 'dingtalk'
  | 'image';

export interface SourceTagValue {
  tagId: string;
  valueKey: string;
  value: unknown;
}

export interface Source {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  directoryId: string | null;
  parentPath?: string[];
  kind: SourceKind;
  name: string;
  externalId?: string | null;
  connectorId?: string | null;
  blobRefId?: string | null;
  mimeType?: string;
  sizeBytes?: number;
  contentHash?: string;
  processingStatus: string;
  sourceVersion: number;
  searchEnabled: boolean;
  permissionState: string;
  permissionRevision: number;
  segmentCount?: number;
  tagValues?: SourceTagValue[];
  version: number;
}

export interface SegmentIndex {
  indexId: string;
  type: 'default' | 'custom' | 'question' | 'summary' | 'image' | 'image_caption';
  modelId: string;
  dimension: 768 | 1024 | 1536 | 3072;
  storageType: 'vector' | 'halfvec';
  vectorProfile: string;
  vectorId: string;
  text: string;
  version: number;
}

export interface Segment {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  searchEnabled: boolean;
  order: number;
  question: string;
  answer: string;
  content: string;
  metadata?: Record<string, unknown>;
  indexes: SegmentIndex[];
  indexStatus: string;
  indexErrorCode?: string | null;
  imageBlobRefId?: string | null;
  version: number;
  sourceVersion: number;
  fullTextTokens?: string;
  fullTextVersion?: number;
}

export interface Tag {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  key: string;
  label: string;
  tagType: 'string' | 'number' | 'datetime' | 'array';
  options: string[] | null;
  required: boolean;
  status: 'active' | 'disabled';
  version: number;
}

export interface JobProgress {
  stage: string;
  completed: number;
  total: number;
  percent: number;
}

export interface Job {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: JobProgress;
  steps?: Array<Record<string, unknown>>;
  error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } | null;
  result?: Record<string, unknown> | null;
  resourceType: string;
  resourceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Model {
  modelId: string;
  displayName: string;
  type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
  capabilities: string[];
  authorized: boolean;
}

export interface ModelBinding {
  modelType: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
  modelId: string;
  displayName: string;
  requiredCapabilities: string[];
  status: 'active' | 'disabled';
}

export interface Collaborator {
  memberId: string;
  role: 'read' | 'write' | 'manage' | 'owner';
  status: 'active' | 'revoked';
  grantedAt: string;
}

export interface Acl {
  resourceType: 'space' | 'directory' | 'source';
  resourceId: string;
  inheritMode: 'inherit' | 'override';
  permissionState: 'disabled' | 'inherited' | 'independent';
  permissionRevision: number;
  snapshotVersion: number;
  entries: Array<{
    principalType: 'member' | 'group' | 'workspace';
    principalId: string;
    permission: 'read' | 'write' | 'manage' | 'owner';
  }>;
}

export interface BatchResult {
  code?: 'KNOWLEDGE_PARTIAL_SUCCESS';
  requested: number;
  succeeded: number;
  failed: number;
  items: Array<{
    id: string;
    success: boolean;
    code?: string;
    version?: number;
    parentPath?: string[];
  }>;
}

export interface FileTicket {
  ticketId: string;
  url: string;
  expiresAt: string;
}

export interface SourcePreview {
  sections: Array<{
    title?: string;
    text: string;
    page?: number;
  }>;
}

export interface Connector {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk';
  name: string;
  status: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  nextSyncAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: Record<string, unknown> | null;
  cursorVersion: number;
  version: number;
  config: Record<string, unknown>;
}

export interface CatalogItem {
  id: string;
  name: string;
  type: 'file' | 'directory';
}

export interface Citation {
  citationId: string;
  segmentId: string;
  sourceId: string;
  title: string;
  sourceUrl: string;
  segmentRange: {
    start: number;
    end: number;
  };
  score: number;
  version: number;
}

export interface SearchResultItem {
  segment: Segment;
  score: number;
  citation: Citation;
}

export interface SearchResponse {
  searchId: string;
  mode: 'semantic' | 'fulltext' | 'hybrid' | 'image' | 'multi_space';
  items: SearchResultItem[];
  partial: boolean;
  durationMs: number;
  degraded?: string[];
  rerankApplied?: boolean;
}
