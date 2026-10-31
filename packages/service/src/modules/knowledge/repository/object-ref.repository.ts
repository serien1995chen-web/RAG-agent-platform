import { Types, type Connection, type Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeObjectRefDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import type {
  CreateUploadSessionInput,
  UploadSessionView,
  UploadStatus,
} from '../application/ports';
import type {
  CompleteUploadInput,
  ObjectRefRepositoryPort,
  ObjectRefView,
  ObjectCleanupScope,
  UploadPartView,
} from '../application/ports';

type PlainObjectRef = KnowledgeObjectRefDoc & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function uploadStatus(document: PlainObjectRef): UploadStatus {
  const status = document.upload?.status;
  if (
    status === 'pending' ||
    status === 'uploading' ||
    status === 'completing' ||
    status === 'completed' ||
    status === 'aborted' ||
    status === 'expired'
  ) {
    return status;
  }
  throw tenantError({ requestId: 'repository', traceId: 'repository' }, 'KNOWLEDGE_CONFLICT', {
    reason: 'upload_status_missing',
  });
}

function uploadSessionDto(document: PlainObjectRef): UploadSessionView {
  if (document.upload.mode === null) {
    throw tenantError({ requestId: 'repository', traceId: 'repository' }, 'KNOWLEDGE_CONFLICT', {
      reason: 'upload_session_invalid',
    });
  }
  const expiresAt =
    document.expiresAt ??
    document.upload.completedAt ??
    document.upload.abortedAt ??
    document.updatedAt;
  return {
    uploadId: String(document._id),
    mode: document.upload.mode,
    status: uploadStatus(document),
    partSizeBytes: document.upload.partSizeBytes,
    partCount: document.upload.partCount,
    originalName: document.upload.originalName,
    expiresAt: expiresAt.toISOString(),
    version: document.version,
    parts: document.upload.parts
      .map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
        sizeBytes: part.sizeBytes,
      }))
      .sort((left, right) => left.partNumber - right.partNumber),
  };
}

function objectRefDto(document: PlainObjectRef): ObjectRefView {
  return {
    blobId: String(document._id),
    workspaceId: document.workspaceId,
    createdByMemberId: document.createdByMemberId,
    knowledgeSpaceId: document.knowledgeSpaceId ? String(document.knowledgeSpaceId) : '',
    provider: document.provider,
    bucket: document.bucket,
    objectKey: document.objectKey,
    providerUploadId: document.upload?.providerUploadId ?? null,
    uploadMode: document.upload?.mode ?? null,
    uploadStatus: document.upload?.status ?? null,
    pendingObjectKey: document.upload?.pendingObjectKey ?? null,
    finalObjectKey: document.upload?.finalObjectKey ?? null,
    finalizedAt: document.upload?.finalizedAt?.toISOString() ?? null,
    pendingUrlExpiresAt: document.upload?.pendingUrlExpiresAt?.toISOString() ?? null,
    originalName: document.upload?.originalName ?? 'file',
    purpose: document.purpose,
    sourceId: document.sourceId ? String(document.sourceId) : null,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    etag: document.etag,
    sha256: document.sha256,
    state: document.state,
    expiresAt: document.expiresAt?.toISOString() ?? null,
    version: document.version,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    deletedAt: document.deletedAt?.toISOString() ?? null,
  };
}

function objectIdOrNotFound(value: string, context: TenantContext, field: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { field });
  }
  return objectIdOf(value, context, field);
}

export class KnowledgeObjectRefRepository implements ObjectRefRepositoryPort {
  private readonly objects: Model<KnowledgeObjectRefDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;

  constructor(connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.objects = models.KnowledgeObjectRef;
    this.sources = models.KnowledgeSource;
  }

  private tenantFilter(
    context: TenantContext,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
      ...extra,
    };
  }

  private async findPlain(
    context: TenantContext,
    extra: Record<string, unknown>,
  ): Promise<PlainObjectRef | null> {
    return this.objects.findOne(this.tenantFilter(context, extra)).lean<PlainObjectRef>().exec();
  }

  async createUploadSession(
    input: CreateUploadSessionInput,
    context: TenantContext,
  ): Promise<UploadSessionView> {
    const document = new this.objects({
      _id: objectIdOf(input.uploadId, context, 'uploadId'),
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: objectIdOf(input.knowledgeSpaceId, context, 'knowledgeSpaceId'),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      provider: input.provider,
      bucket: input.bucket,
      objectKey: input.objectKey,
      purpose: 'source',
      sourceId: null,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      etag: '',
      sha256: '',
      state: 'pending',
      expiresAt: input.expiresAt,
      upload: {
        mode: input.mode,
        status: 'uploading',
        providerUploadId: input.providerUploadId,
        pendingObjectKey: input.objectKey,
        finalObjectKey: input.finalObjectKey,
        finalizedAt: null,
        pendingUrlExpiresAt: input.expiresAt,
        partSizeBytes: input.partSizeBytes,
        partCount: input.partCount,
        parts: [],
        originalName: input.originalName,
        completedAt: null,
        abortedAt: null,
      },
    });
    await document.save();
    const plain = document.toObject<PlainObjectRef>();
    return uploadSessionDto(plain);
  }

  async findUploadSession(
    uploadId: string,
    context: TenantContext,
  ): Promise<UploadSessionView | null> {
    if (!Types.ObjectId.isValid(uploadId)) return null;
    const document = await this.findPlain(context, {
      _id: new Types.ObjectId(uploadId),
      'upload.mode': { $ne: null },
    });
    return document === null ? null : uploadSessionDto(document);
  }

  async recordUploadPart(
    uploadId: string,
    expectedVersion: number,
    part: UploadPartView,
    context: TenantContext,
  ): Promise<UploadSessionView> {
    const id = objectIdOrNotFound(uploadId, context, 'uploadId');
    const current = await this.findPlain(context, { _id: id });
    if (!current || current.upload.status !== 'uploading') {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        uploadId,
        expectedStatus: 'uploading',
      });
    }
    const parts = [
      ...current.upload.parts.filter((entry) => entry.partNumber !== part.partNumber),
      part,
    ].sort((left, right) => left.partNumber - right.partNumber);
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          'upload.status': 'uploading',
        }),
        {
          $set: {
            'upload.parts': parts,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { uploadId, expectedVersion });
    }
    return uploadSessionDto(updated);
  }

  async markUploadCompleting(
    uploadId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<UploadSessionView> {
    const id = objectIdOrNotFound(uploadId, context, 'uploadId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          state: 'pending',
          'upload.status': 'uploading',
        }),
        {
          $set: {
            'upload.status': 'completing',
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { uploadId, expectedVersion });
    }
    return uploadSessionDto(updated);
  }

  async completeUpload(input: CompleteUploadInput, context: TenantContext): Promise<ObjectRefView> {
    const id = objectIdOrNotFound(input.uploadId, context, 'uploadId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: input.expectedVersion,
          state: 'pending',
          'upload.status': 'completing',
        }),
        {
          $set: {
            state: 'active',
            objectKey: input.objectKey,
            sizeBytes: input.sizeBytes,
            etag: input.etag,
            sha256: input.sha256,
            expiresAt: null,
            'upload.status': 'completed',
            'upload.parts': input.parts,
            'upload.finalObjectKey': input.objectKey,
            'upload.finalizedAt': new Date(),
            'upload.completedAt': new Date(),
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        uploadId: input.uploadId,
        expectedVersion: input.expectedVersion,
      });
    }
    return objectRefDto(updated);
  }

  async markUploadAborted(
    uploadId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<UploadSessionView> {
    const id = objectIdOrNotFound(uploadId, context, 'uploadId');
    const now = new Date();
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          'upload.status': { $in: ['uploading', 'expired', 'completing'] },
        }),
        {
          $set: {
            state: 'deleting',
            expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
            'upload.status': 'aborted',
            'upload.abortedAt': now,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { uploadId, expectedVersion });
    }
    return uploadSessionDto(updated);
  }

  async markUploadExpired(uploadId: string, context: TenantContext): Promise<UploadSessionView> {
    const id = objectIdOrNotFound(uploadId, context, 'uploadId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          'upload.status': { $in: ['pending', 'uploading'] },
        }),
        {
          $set: {
            state: 'deleting',
            'upload.status': 'expired',
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { uploadId });
    return uploadSessionDto(updated);
  }

  async findObjectRef(blobId: string, context: TenantContext): Promise<ObjectRefView | null> {
    if (!Types.ObjectId.isValid(blobId)) return null;
    const document = await this.findPlain(context, { _id: new Types.ObjectId(blobId) });
    return document === null ? null : objectRefDto(document);
  }

  private async ttlCleanupCandidates(
    limit: number,
    now: Date,
    context: TenantContext,
  ): Promise<ObjectRefView[]> {
    const documents = await this.objects
      .find(
        this.tenantFilter(context, {
          $or: [
            {
              state: 'deleting',
              $or: [
                { 'upload.status': { $in: ['aborted', 'expired'] } },
                { expiresAt: { $ne: null, $lte: now } },
              ],
            },
            {
              state: 'pending',
              expiresAt: { $ne: null, $lte: now },
            },
            {
              state: 'active',
              purpose: 'export',
              expiresAt: { $ne: null, $lte: now },
            },
            {
              state: 'active',
              purpose: 'source',
              'upload.status': 'completed',
              'upload.pendingObjectKey': { $ne: null },
              'upload.pendingUrlExpiresAt': { $ne: null, $lte: now },
            },
          ],
        }),
      )
      .sort({ updatedAt: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .lean<PlainObjectRef[]>()
      .exec();
    return documents.map(objectRefDto);
  }

  private async orphanCleanupCandidates(
    limit: number,
    context: TenantContext,
  ): Promise<ObjectRefView[]> {
    const workspaceId = requireWorkspaceId(context);
    const documents = await this.objects.aggregate<PlainObjectRef>([
      {
        $match: {
          workspaceId,
          deletedAt: null,
          state: { $in: ['active', 'deleting'] },
          purpose: { $ne: 'export' },
        },
      },
      {
        $lookup: {
          from: 'knowledge_sources',
          let: { blobId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$workspaceId', workspaceId] },
                    { $eq: ['$blobRefId', '$$blobId'] },
                    { $eq: ['$deletedAt', null] },
                    { $not: [{ $in: ['$status', ['deleted', 'archived']] }] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'activeSources',
        },
      },
      { $match: { activeSources: { $size: 0 } } },
      { $sort: { updatedAt: 1 } },
      { $limit: Math.min(Math.max(limit, 1), 500) },
    ]);
    return documents.map(objectRefDto);
  }

  async findCleanupCandidates(
    limit: number,
    now: Date,
    scope: ObjectCleanupScope,
    context: TenantContext,
  ): Promise<ObjectRefView[]> {
    if (scope === 'ttl_objects') return this.ttlCleanupCandidates(limit, now, context);
    if (scope === 'orphan_objects') return this.orphanCleanupCandidates(limit, context);
    const [ttl, orphan] = await Promise.all([
      this.ttlCleanupCandidates(limit, now, context),
      this.orphanCleanupCandidates(limit, context),
    ]);
    return [
      ...new Map([...ttl, ...orphan].map((candidate) => [candidate.blobId, candidate])).values(),
    ]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async markDeleting(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView> {
    const id = objectIdOrNotFound(blobId, context, 'blobId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          state: { $in: ['pending', 'active', 'deleting'] },
        }),
        {
          $set: { state: 'deleting', updatedByMemberId: context.memberId },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { blobId, expectedVersion });
    }
    return objectRefDto(updated);
  }

  async confirmDeleted(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView> {
    const id = objectIdOrNotFound(blobId, context, 'blobId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          state: 'deleting',
        }),
        {
          $set: {
            state: 'deleted',
            expiresAt: null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { blobId, expectedVersion });
    }
    return objectRefDto(updated);
  }

  async clearUploadTemporaryObject(
    blobId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<ObjectRefView> {
    const id = objectIdOrNotFound(blobId, context, 'blobId');
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: id,
          version: expectedVersion,
          state: 'active',
          purpose: 'source',
          'upload.status': 'completed',
          'upload.pendingObjectKey': { $ne: null },
        }),
        {
          $set: {
            'upload.pendingObjectKey': null,
            'upload.pendingUrlExpiresAt': null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', { blobId, expectedVersion });
    }
    return objectRefDto(updated);
  }

  async hasActiveSourceReference(blobId: string, context: TenantContext): Promise<boolean> {
    if (!Types.ObjectId.isValid(blobId)) return false;
    const count = await this.sources.countDocuments({
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
      blobRefId: new Types.ObjectId(blobId),
    });
    return count > 0;
  }

  async createPendingArchiveArtifact(
    input: {
      blobId: string;
      knowledgeSpaceId: string;
      provider: ObjectRefView['provider'];
      bucket: string;
      objectKey: string;
      mimeType: string;
      sizeBytes: number;
      expiresAt: Date;
    },
    context: TenantContext,
  ): Promise<ObjectRefView> {
    const existing = await this.findObjectRef(input.blobId, context);
    if (existing?.state === 'active') return existing;
    if (existing) {
      const reset = await this.objects
        .findOneAndUpdate(
          this.tenantFilter(context, {
            _id: objectIdOf(input.blobId, context, 'blobId'),
            version: existing.version,
          }),
          {
            $set: {
              knowledgeSpaceId: objectIdOf(input.knowledgeSpaceId, context, 'knowledgeSpaceId'),
              deletedAt: null,
              updatedByMemberId: context.memberId,
              provider: input.provider,
              bucket: input.bucket,
              objectKey: input.objectKey,
              purpose: 'export',
              sourceId: null,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              etag: '',
              sha256: '',
              state: 'pending',
              expiresAt: input.expiresAt,
              upload: {
                mode: null,
                status: null,
                providerUploadId: null,
                pendingObjectKey: null,
                finalObjectKey: input.objectKey,
                finalizedAt: null,
                pendingUrlExpiresAt: null,
                partSizeBytes: 8388608,
                partCount: 0,
                parts: [],
                originalName: 'sources.zip',
                completedAt: null,
                abortedAt: null,
              },
            },
            $inc: { version: 1 },
          },
          { new: true },
        )
        .lean<PlainObjectRef>()
        .exec();
      if (!reset) {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          blobId: input.blobId,
          expectedVersion: existing.version,
        });
      }
      return objectRefDto(reset);
    }
    const document = new this.objects({
      _id: objectIdOf(input.blobId, context, 'blobId'),
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: objectIdOf(input.knowledgeSpaceId, context, 'knowledgeSpaceId'),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      provider: input.provider,
      bucket: input.bucket,
      objectKey: input.objectKey,
      purpose: 'export',
      sourceId: null,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      etag: '',
      sha256: '',
      state: 'pending',
      expiresAt: input.expiresAt,
      upload: {
        mode: null,
        status: null,
        providerUploadId: null,
        pendingObjectKey: null,
        finalObjectKey: input.objectKey,
        finalizedAt: null,
        pendingUrlExpiresAt: null,
        partSizeBytes: 8388608,
        partCount: 0,
        parts: [],
        originalName: 'sources.zip',
        completedAt: null,
        abortedAt: null,
      },
    });
    await document.save();
    return objectRefDto(document.toObject<PlainObjectRef>());
  }

  async activateArchiveArtifact(
    input: {
      blobId: string;
      expectedVersion: number;
      sizeBytes: number;
      etag: string;
      sha256: string;
      expiresAt: Date;
    },
    context: TenantContext,
  ): Promise<ObjectRefView> {
    const updated = await this.objects
      .findOneAndUpdate(
        this.tenantFilter(context, {
          _id: objectIdOrNotFound(input.blobId, context, 'blobId'),
          version: input.expectedVersion,
          purpose: 'export',
          state: 'pending',
        }),
        {
          $set: {
            state: 'active',
            sizeBytes: input.sizeBytes,
            etag: input.etag,
            sha256: input.sha256,
            expiresAt: input.expiresAt,
            'upload.completedAt': new Date(),
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .lean<PlainObjectRef>()
      .exec();
    if (!updated) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        blobId: input.blobId,
        expectedVersion: input.expectedVersion,
      });
    }
    return objectRefDto(updated);
  }
}
