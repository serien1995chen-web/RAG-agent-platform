export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SpaceRecord {
  id: string;
  workspaceId: string;
  kind: 'space' | 'folder';
  parentSpaceId: string | null;
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
  depth: number;
  aclMode: 'inherited' | 'override';
  version: number;
}

export interface SourceRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  directoryId: string | null;
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
  searchEnabled: boolean;
  order: number;
  question: string;
  answer: string;
  content: string;
  indexStatus: string;
  version: number;
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
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  error: { code?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
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
