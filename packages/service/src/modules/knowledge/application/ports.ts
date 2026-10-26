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
  moveSpace(
    spaceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SpaceView>;
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
  moveDirectoryTree(
    directoryId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<DirectoryView>;
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
  deleteSource(
    sourceId: string,
    context: TenantContext,
    expectedVersion?: number,
  ): Promise<Record<string, unknown>>;
  moveSource(
    sourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ): Promise<SourceView>;
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
  findLatestSucceeded(
    kind: 'parse',
    resourceId: string,
    context: TenantContext,
  ): Promise<Record<string, unknown> | null>;
  createExportJob(
    input: {
      spaceId: string;
      sourceIds: string[];
      idempotencyKey: string;
      format?: 'zip';
      exportScope?: 'sources' | 'space';
      sourceVersions?: Record<string, number>;
    },
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
  transition(
    input: {
      jobId: string;
      expectedVersion: number;
      nextStatus: JobState;
    },
    context: TenantContext,
  ): Promise<Record<string, unknown>>;
}

export interface ReferenceView {
  referrerType: 'app' | 'workflow';
  referrerId: string;
  referrerVersion: string;
  referrerName: string;
  status: 'active' | 'stale' | 'removed';
  lastSeenAt: string;
}

export interface ReferenceRegistryDescriptor {
  referrerType: 'app' | 'workflow';
  referrerId: string;
  referrerVersion: string;
  referrerName: string;
  verification: 'EXTERNAL_UNVERIFIED';
}

export interface ReferenceRegistryPort {
  resolve(
    referrerType: 'app' | 'workflow',
    referrerId: string,
    referrerVersion: string,
    context: TenantContext,
  ): ReferenceRegistryDescriptor;
}

export interface ReferenceEventPort {
  applyUpsert(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      referrerName: string;
      registryRevision: number;
    },
    context: TenantContext,
  ): Promise<{ referenceRevision: number; item: ReferenceView }>;
  applyRemove(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      registryRevision: number;
    },
    context: TenantContext,
  ): Promise<{ referenceRevision: number; item: ReferenceView }>;
}

export interface ReferencePort extends ReferenceEventPort {
  list(
    spaceId: string,
    context: TenantContext,
  ): Promise<{ referenceRevision: number; count: number; items: ReferenceView[] }>;
}

export type KnowledgeObjectProvider = 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
export type KnowledgeObjectPurpose = 'source' | 'image' | 'export' | 'preview' | 'avatar';
export type UploadMode = 'single' | 'multipart';
export type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'aborted'
  | 'expired';

export interface UploadPartView {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface UploadSessionView {
  uploadId: string;
  mode: UploadMode;
  status: UploadStatus;
  partSizeBytes: number;
  partCount: number;
  originalName: string;
  expiresAt: string;
  version: number;
  parts: UploadPartView[];
}

export interface ObjectRefView {
  blobId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: KnowledgeObjectProvider;
  bucket: string;
  objectKey: string;
  providerUploadId: string | null;
  uploadMode: 'single' | 'multipart' | null;
  uploadStatus: UploadStatus | null;
  pendingObjectKey: string | null;
  finalObjectKey: string | null;
  finalizedAt: string | null;
  pendingUrlExpiresAt: string | null;
  originalName: string;
  purpose: KnowledgeObjectPurpose;
  sourceId: string | null;
  mimeType: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
  state: 'pending' | 'active' | 'deleting' | 'deleted';
  expiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateUploadSessionInput {
  uploadId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: KnowledgeObjectProvider;
  bucket: string;
  objectKey: string;
  finalObjectKey: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  mode: UploadMode;
  partSizeBytes: number;
  partCount: number;
  providerUploadId: string | null;
  expiresAt: Date;
}

export interface ObjectCopyResult {
  sourceEtag: string;
  etag: string;
  sizeBytes: number;
}

export interface CompleteUploadInput {
  uploadId: string;
  expectedVersion: number;
  objectKey: string;
  etag: string;
  sha256: string;
  sizeBytes: number;
  parts: readonly UploadPartView[];
}

export interface ObjectStorageContext {
  workspaceId: string;
  knowledgeSpaceId: string;
  requestId: string;
  traceId: string;
}

export interface ArchiveSafetyInput {
  kind: 'upload' | 'archive';
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
  originalName: string;
  archiveLayout?: 'source' | 'space';
  storage: ObjectStorageContext;
}

export interface ArchiveSafetyResult {
  archive: boolean;
  safe: boolean;
  status:
    | 'not_archive'
    | 'safe'
    | 'too_large'
    | 'unsupported'
    | 'dependency_unavailable'
    | 'dependency_timeout';
  reason?: string;
  entryCount?: number;
  actualUncompressedBytes?: number;
  declaredUncompressedBytes?: number;
}

export interface ArchiveSafetyPort {
  inspect(input: ArchiveSafetyInput): Promise<ArchiveSafetyResult>;
  validateEntryPath(value: string): { safe: true } | { safe: false; reason: string };
}

export interface ObjectStoreApplicationPort {
  readonly provider: KnowledgeObjectProvider;
  readonly bucket: string;
  ensureBucket(bucket: string, context: ObjectStorageContext): Promise<void>;
  copyObjectImmutable(
    input: {
      sourceKey: string;
      targetKey: string;
      expectedSourceEtag: string;
      expectedSize: number;
      contentType: string;
      metadata?: Record<string, string>;
    },
    context: ObjectStorageContext,
  ): Promise<ObjectCopyResult>;
  headObject(
    bucket: string,
    key: string,
    context: ObjectStorageContext,
  ): Promise<{
    size: number;
    etag: string;
    contentType: string | null;
    metadata: Record<string, string>;
  }>;
  getObject(
    bucket: string,
    key: string,
    range: string | null,
    context: ObjectStorageContext,
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    size: number;
    etag: string;
    contentType: string | null;
    contentRange: string | null;
  }>;
  presignPut(
    key: string,
    contentType: string,
    expiresSeconds: number,
    context: ObjectStorageContext,
    multipart?: { providerUploadId: string; partNumber: number },
  ): Promise<{
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  }>;
  createMultipartUpload(
    key: string,
    contentType: string,
    metadata: Record<string, string>,
    context: ObjectStorageContext,
  ): Promise<string>;
  uploadPart(
    key: string,
    providerUploadId: string,
    partNumber: number,
    body: Uint8Array,
    context: ObjectStorageContext,
  ): Promise<UploadPartView>;
  listParts(
    key: string,
    providerUploadId: string,
    context: ObjectStorageContext,
  ): Promise<UploadPartView[]>;
  completeMultipartUpload(
    key: string,
    providerUploadId: string,
    parts: readonly UploadPartView[],
    context: ObjectStorageContext,
  ): Promise<{ etag: string; sizeBytes: number }>;
  abortMultipartUpload(
    key: string,
    providerUploadId: string,
    context: ObjectStorageContext,
  ): Promise<{ aborted: boolean }>;
  deleteObject(key: string, context: ObjectStorageContext): Promise<{ deleted: boolean }>;
}

export type FileTicketDisposition = 'inline' | 'attachment';

export interface FileTicketClaims {
  workspaceId: string;
  blobId: string;
  sourceId: string | null;
  knowledgeSpaceId: string | null;
  disposition: FileTicketDisposition;
  expiresAt: string;
  nonce: string;
}

export interface FileTicketPort {
  issue(
    input: {
      workspaceId: string;
      blobId: string;
      sourceId: string | null;
      knowledgeSpaceId: string | null;
      disposition: FileTicketDisposition;
      ttlSeconds: number;
    },
    requestId: string,
    traceId: string,
  ): { url: string; ticket: string; expiresAt: string };
  verify(ticket: string, requestId: string, traceId: string): FileTicketClaims;
}

export interface FileBinaryResult {
  body: AsyncIterable<Uint8Array>;
  size: number;
  etag: string;
  contentType: string | null;
  contentRange: string | null;
  disposition: FileTicketDisposition;
  filename: string;
}

export interface ObjectRefRepositoryPort {
  createUploadSession(
    input: CreateUploadSessionInput,
    context: TenantContext,
  ): Promise<UploadSessionView>;
  findUploadSession(uploadId: string, context: TenantContext): Promise<UploadSessionView | null>;
  recordUploadPart(
    uploadId: string,
    expectedVersion: number,
    part: UploadPartView,
    context: TenantContext,
  ): Promise<UploadSessionView>;
  markUploadCompleting(
    uploadId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<UploadSessionView>;
  completeUpload(input: CompleteUploadInput, context: TenantContext): Promise<ObjectRefView>;
  markUploadAborted(
    uploadId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<UploadSessionView>;
  markUploadExpired(uploadId: string, context: TenantContext): Promise<UploadSessionView>;
  findObjectRef(blobId: string, context: TenantContext): Promise<ObjectRefView | null>;
  findCleanupCandidates(limit: number, now: Date, context: TenantContext): Promise<ObjectRefView[]>;
  markDeleting(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView>;
  confirmDeleted(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView>;
  clearUploadTemporaryObject(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView>;
  hasActiveSourceReference(blobId: string, context: TenantContext): Promise<boolean>;
  createPendingArchiveArtifact(
    input: {
      blobId: string;
      knowledgeSpaceId: string;
      provider: KnowledgeObjectProvider;
      bucket: string;
      objectKey: string;
      mimeType: string;
      sizeBytes: number;
      expiresAt: Date;
    },
    context: TenantContext,
  ): Promise<ObjectRefView>;
  activateArchiveArtifact(
    input: {
      blobId: string;
      expectedVersion: number;
      sizeBytes: number;
      etag: string;
      sha256: string;
      expiresAt: Date;
    },
    context: TenantContext,
  ): Promise<ObjectRefView>;
}
