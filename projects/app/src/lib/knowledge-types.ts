export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SpaceRecord {
  id: string;
  workspaceId: string;
  kind: 'space' | 'folder';
  parentSpaceId: string | null;
  parentPath?: string[];
  name: string;
  description: string;
  iconKey: string;
  ownershipMemberId: string;
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled: boolean;
  referenceRevision: number;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryRecord {
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

export interface SourceRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  directoryId: string | null;
  parentPath?: string[];
  kind: string;
  name: string;
  processingStatus: string;
  sourceVersion: number;
  searchEnabled: boolean;
  permissionState: string;
  permissionRevision: number;
  version: number;
}

export interface SegmentRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion: number;
  searchEnabled: boolean;
  order: number;
  question: string;
  answer: string;
  content: string;
  fullTextTokens: string;
  fullTextVersion: number;
  metadata: Record<string, unknown>;
  history: SegmentHistoryRecord[];
  indexes: SegmentIndexRecord[];
  indexStatus: string;
  indexErrorCode: string | null;
  version: number;
}

export interface SegmentIndexRecord {
  indexId: string;
  type: 'default' | 'custom' | 'question' | 'summary';
  modelId: string;
  dimension: 768 | 1024 | 1536 | 3072;
  storageType: 'vector' | 'halfvec';
  vectorProfile: string;
  vectorId: string;
  text: string;
  version: number;
}

export interface SegmentHistoryRecord {
  version: number;
  question: string;
  answer: string;
  changedAt: string;
  changedByMemberId: string;
}

export interface TagRecord {
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

export interface CollaboratorRecord {
  memberId: string;
  role: 'read' | 'write' | 'manage' | 'owner';
  status: 'active' | 'revoked';
  grantedAt: string;
  version: number;
}

export interface AclRecord {
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

export interface JobRecord {
  jobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  kind: string;
  resourceType:
    | 'workspace'
    | 'space'
    | 'directory'
    | 'source'
    | 'segment'
    | 'job'
    | 'connector'
    | 'api_key'
    | 'synonym'
    | 'system';
  resourceId: string;
  inputSnapshot: Record<string, unknown>;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  attemptEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  availableAt: string;
  cancelRequestedAt: string | null;
  pausedAt: string | null;
  progress: Record<string, unknown>;
  steps: Array<{
    stepKey: string;
    status: string;
    attempts: number;
    externalEvidence: Record<string, unknown> | null;
    compensationState: string;
    error?: Record<string, unknown> | null;
  }>;
  error: { code?: string; message?: string } | null;
  result?: {
    objectBlobRefId?: string;
    expiresAt?: string;
    sourceCount?: number;
    manifest?: Record<string, unknown>;
    childJobIds?: string[];
    partial?: boolean;
    sources?: Array<Record<string, unknown>>;
    replayHistory?: Array<Record<string, unknown>>;
  } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchActionResult {
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

export interface ReferenceRecord {
  referrerType: 'app' | 'workflow';
  referrerId: string;
  referrerVersion: string;
  referrerName: string;
  status: 'active' | 'stale' | 'removed';
  lastSeenAt: string;
}

export interface OpsStatusRecord {
  status: 'ok' | 'degraded';
  queueDepth: Record<string, number>;
  storage: { provider: string; healthy: boolean };
  vector: { backend: 'pgvector'; healthy: boolean; profiles: number[] };
  reconciliation: {
    lastRunAt: string;
    orphanObjects: number;
    orphanVectors: number;
  };
}

export interface ConnectorRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk';
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
    provider: string;
    schemaVersion: number;
    keyVersion: number;
    configured: boolean;
    redactedFields: string[];
  };
}

export interface ImportConflict {
  rowNumber: number;
  code: string;
  existingSourceId?: string;
}

export interface ImportAction {
  rowNumber: number;
  action: 'create' | 'update' | 'skip' | 'overwrite';
}

export function listPath(spaceId: string, resource: 'directories' | 'sources' | 'tags'): string {
  return `/v1/knowledge/spaces/${spaceId}/${resource}?limit=200`;
}

export function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (['active', 'ready', 'indexed', 'succeeded', 'ok'].includes(status)) return 'success';
  if (['partial', 'retry_wait', 'paused', 'degraded', 'pending', 'draft'].includes(status)) {
    return 'warning';
  }
  if (['failed', 'dead_letter', 'error', 'down', 'deleting'].includes(status)) return 'danger';
  return 'neutral';
}
