export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PageResult<T> {
  items: T[];
  pageInfo?: PageInfo;
}

export type PermissionLevel = 'read' | 'write' | 'manage' | 'owner';

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
  autoSync: boolean;
  effectivePermission?: PermissionLevel;
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
  permissionRevision?: number;
  aclSnapshotVersion?: number;
  ownershipMemberId?: string;
  effectivePermission?: PermissionLevel;
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
  aclSnapshotVersion?: number;
  ownershipMemberId?: string;
  effectivePermission?: PermissionLevel;
  segmentCount: number;
  metadata?: Record<string, unknown>;
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

export interface SegmentHistory {
  version: number;
  question: string;
  answer: string;
  changedAt: string;
  changedByMemberId: string;
  operation?: 'segment.update' | 'index.create' | 'index.update' | 'index.delete' | 'index.reindex';
  indexId?: string;
  indexes?: SegmentIndex[];
  nextIndexes?: SegmentIndex[];
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
  attemptEpoch?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
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
  provider: string;
  type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
  capabilities: string[];
  tags: string[];
  dimension?: 768 | 1024 | 1536 | 3072 | null;
  limits?: {
    maxToken?: number;
    defaultToken?: number;
    maxContext?: number;
    maxResponse?: number;
  };
  authorized: boolean;
}

export interface ModelDefaults {
  embedding: string | null;
  textLLM: string | null;
  imageLLM: string | null;
}

export interface ModelCatalog {
  items: Model[];
  defaults: ModelDefaults;
  source: 'database' | 'environment' | 'mock';
}

export interface ModelSettings {
  version: number;
  source: 'database' | 'environment' | 'mock';
  models: Array<Omit<Model, 'authorized'> & { enabled: boolean }>;
  defaults: ModelDefaults;
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
  version: number;
}

export interface Acl {
  resourceType: 'space' | 'directory' | 'source';
  resourceId: string;
  inheritMode: 'inherit' | 'override';
  permissionState: 'disabled' | 'inherited' | 'independent';
  permissionRevision: number;
  snapshotVersion: number;
  entries: Array<{
    principalType: 'member' | 'group' | 'org' | 'workspace';
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
    index?: number;
    tagId?: string;
    success: boolean;
    code?: string;
    version?: number;
    jobId?: string;
    jobIds?: string[];
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
  type: 'document' | 'directory';
}

export interface ProviderCatalogItem {
  id?: string;
  externalId?: string;
  name?: string;
  title?: string;
  type: 'document' | 'directory';
}

export interface Citation {
  citationId: string;
  segmentId: string;
  sourceId: string;
  knowledgeSpaceId: string;
  title: string;
  sourceUrl: string;
  segmentRange: {
    start: number;
    end: number;
  };
  score: number;
  version: number;
  quoteText: string;
  snapshotHash: string;
  expiresAt: string;
}

export interface SearchResultItem {
  segment: Segment;
  score: number;
  citation: Citation;
  imagePreview?: {
    url: string;
    expiresAt: string;
  };
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

export type DeepStopReason =
  | 'sufficient'
  | 'round_limit'
  | 'token_budget'
  | 'cost_budget'
  | 'no_new_evidence'
  | 'dependency_failure';

export interface DeepSearchRound {
  round: number;
  queries: string[];
  candidateCount: number;
  sufficient: boolean;
  inputTokens: number;
  outputTokens: number;
  aiPoints: number;
  permissionRevision: number;
}

export interface DeepSearchResponse extends Omit<SearchResponse, 'mode'> {
  mode: 'multi_space';
  rounds: DeepSearchRound[];
  stopReason: DeepStopReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
    aiPoints: number;
    aiPointsMicros: number;
    costBudgetPoints: number;
    remainingAiPoints: number;
  };
}
