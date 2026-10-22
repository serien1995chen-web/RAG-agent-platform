import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { AclResourceType, JobState, PermissionLevel, SourcePermissionAction } from '../domain';

export interface OperationPageRequest {
  cursor?: string;
  limit?: number | string;
  sort?: string;
}

export interface OperationPageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface OperationPage<T> {
  items: T[];
  pageInfo: OperationPageInfo;
}

export interface SpaceView {
  id: string;
  kind: 'space' | 'folder';
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled: boolean;
  [key: string]: unknown;
}

export interface DirectoryView {
  id: string;
  knowledgeSpaceId: string;
  [key: string]: unknown;
}

export interface SourceView {
  id: string;
  knowledgeSpaceId: string;
  searchEnabled: boolean;
  [key: string]: unknown;
}

export interface SegmentView {
  id: string;
  knowledgeSpaceId: string;
  sourceId: string;
  [key: string]: unknown;
}

export interface TagView {
  id: string;
  knowledgeSpaceId: string;
  [key: string]: unknown;
}

export interface AclView {
  [key: string]: unknown;
}

export interface CollaboratorView {
  memberId: string;
  role: PermissionLevel;
  status: 'active' | 'revoked';
  grantedAt: string;
  version: number;
}

export interface AclEntryInput {
  principalType: 'member' | 'group' | 'workspace';
  principalId: string;
  permission: PermissionLevel;
}

export interface CreateSpacePortInput {
  kind: 'space' | 'folder';
  parentSpaceId?: string | null;
  name: string;
  description?: string;
  iconKey?: string;
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled?: boolean;
}

export interface CreateDirectoryPortInput {
  parentDirectoryId?: string | null;
  name: string;
}

export interface CreateSourcePortInput {
  kind:
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
  directoryId?: string | null;
  name: string;
  searchEnabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateSegmentPortInput {
  question: string;
  answer: string;
  searchEnabled?: boolean;
  metadata?: Record<string, unknown>;
  indexes?: unknown;
}

export interface CatalogPort {
  listSpaces(
    query: OperationPageRequest,
    context: TenantContext,
  ): Promise<OperationPage<SpaceView>>;
  createSpace(input: CreateSpacePortInput, context: TenantContext): Promise<SpaceView>;
  getSpace(spaceId: string, context: TenantContext): Promise<SpaceView>;
  updateSpace(
    spaceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SpaceView>;
  deleteSpace(
    spaceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
  listDirectories(
    spaceId: string,
    query: OperationPageRequest,
    context: TenantContext,
  ): Promise<{ items: DirectoryView[] }>;
  createDirectory(
    spaceId: string,
    input: CreateDirectoryPortInput,
    context: TenantContext,
  ): Promise<DirectoryView>;
  getDirectory(directoryId: string, context: TenantContext): Promise<DirectoryView>;
  updateDirectory(
    directoryId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<DirectoryView>;
  deleteDirectory(directoryId: string, context: TenantContext): Promise<Record<string, unknown>>;
  listSources(
    spaceId: string,
    query: OperationPageRequest,
    context: TenantContext,
  ): Promise<OperationPage<SourceView>>;
  createSource(
    spaceId: string,
    input: CreateSourcePortInput,
    context: TenantContext,
  ): Promise<SourceView>;
  getSource(sourceId: string, context: TenantContext): Promise<SourceView>;
  updateSource(
    sourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SourceView>;
  deleteSource(sourceId: string, context: TenantContext): Promise<Record<string, unknown>>;
  listSegments(
    sourceId: string,
    query: OperationPageRequest,
    context: TenantContext,
  ): Promise<OperationPage<SegmentView>>;
  createSegment(
    sourceId: string,
    input: CreateSegmentPortInput,
    context: TenantContext,
  ): Promise<SegmentView>;
  getSegment(segmentId: string, context: TenantContext): Promise<SegmentView>;
  updateSegment(
    segmentId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SegmentView>;
  deleteSegment(segmentId: string, context: TenantContext): Promise<Record<string, unknown>>;
}

export interface TagPort {
  list(spaceId: string, context: TenantContext): Promise<{ items: TagView[] }>;
  create(spaceId: string, input: Record<string, unknown>, context: TenantContext): Promise<TagView>;
  get(tagId: string, context: TenantContext): Promise<TagView>;
  update(tagId: string, input: Record<string, unknown>, context: TenantContext): Promise<TagView>;
  delete(tagId: string, context: TenantContext): Promise<void>;
  updateOptions(
    tagId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<TagView>;
  apply(input: Record<string, unknown>, context: TenantContext): Promise<Record<string, unknown>>;
}

export interface AccessPort {
  assertPermission(
    resourceType: AclResourceType,
    resourceId: string,
    required: PermissionLevel,
    context: TenantContext,
  ): Promise<unknown>;
  getAcl(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
  ): Promise<AclView>;
  updateAcl(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<AclView>;
  resumeAcl(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<AclView>;
  ensureOwnerAcl(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
    extraEntries?: readonly AclEntryInput[],
  ): Promise<void>;
  listCollaborators(
    spaceId: string,
    context: TenantContext,
  ): Promise<{ items: CollaboratorView[] }>;
  createCollaborator(
    spaceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<CollaboratorView>;
  updateCollaborator(
    spaceId: string,
    memberId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<CollaboratorView>;
  deleteCollaborator(spaceId: string, memberId: string, context: TenantContext): Promise<void>;
  transferOwnership(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<AclView>;
  transitionSourcePermission(
    sourceId: string,
    action: SourcePermissionAction,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<AclView>;
}

export interface JobPort {
  list(
    query: OperationPageRequest,
    context: TenantContext,
  ): Promise<OperationPage<Record<string, unknown>>>;
  get(jobId: string, context: TenantContext): Promise<Record<string, unknown>>;
  transition(
    input: {
      jobId: string;
      expectedVersion: number;
      nextStatus: JobState;
    },
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
}
