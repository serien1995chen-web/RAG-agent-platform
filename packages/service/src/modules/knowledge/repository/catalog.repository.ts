import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { Types, Connection, Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeDirectoryDoc,
  KnowledgeSegmentDoc,
  KnowledgeSourceDoc,
  KnowledgeSpaceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeJobDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';
import { workspaceCasUpdate } from '../../../shared/persistence/knowledge/cas';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { assertDirectoryDepth, assertResourceName } from '../domain/hierarchy';
import {
  cursorFilter,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseSort,
  type PageRequest,
  type PageResult,
} from './pagination';

type Plain<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function iso(value: Date): string {
  return value.toISOString();
}

function spaceDto(document: Plain<KnowledgeSpaceDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    kind: document.kind,
    parentSpaceId: document.parentSpaceId ? String(document.parentSpaceId) : null,
    name: document.name,
    description: document.description,
    iconKey: document.iconKey,
    ownershipMemberId: document.ownershipMemberId,
    accessMode: document.accessMode,
    sourceAclMode: document.sourceAclMode,
    sourcePermissionEnabled: document.sourcePermissionEnabled,
    referenceRevision: document.referenceRevision,
    status: document.status,
    version: document.version,
    createdAt: iso(document.createdAt),
    updatedAt: iso(document.updatedAt),
  };
}

function directoryDto(document: Plain<KnowledgeDirectoryDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    parentDirectoryId: document.parentDirectoryId ? String(document.parentDirectoryId) : null,
    name: document.name,
    path: document.path.map(String),
    depth: document.depth,
    aclMode: document.aclMode,
    version: document.version,
  };
}

function sourceDto(document: Plain<KnowledgeSourceDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    directoryId: document.directoryId ? String(document.directoryId) : null,
    kind: document.kind,
    name: document.name,
    externalId: document.externalId,
    connectorId: document.connectorId ? String(document.connectorId) : null,
    blobRefId: document.blobRefId ? String(document.blobRefId) : null,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    contentHash: document.contentHash,
    processingStatus: document.processingStatus,
    sourceVersion: document.sourceVersion,
    searchEnabled: document.searchEnabled,
    permissionState: document.permissionState,
    permissionRevision: document.permissionRevision,
    version: document.version,
  };
}

function segmentDto(document: Plain<KnowledgeSegmentDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    sourceId: String(document.sourceId),
    searchEnabled: document.searchEnabled,
    order: document.order,
    question: document.question,
    answer: document.answer,
    content: document.content,
    metadata: document.metadata,
    indexes: document.indexes,
    indexStatus: document.indexStatus,
    indexErrorCode: document.indexErrorCode,
    imageBlobRefId: document.imageBlobRefId ? String(document.imageBlobRefId) : null,
    version: document.version,
  };
}

function operationResult(id: string, jobId?: string | null) {
  return { id, status: 'accepted', jobId: jobId ?? null };
}

function jobIdempotencyKey(kind: string, resourceId: string, version: number): string {
  return createHash('sha256').update(`${kind}|${resourceId}|${version}`).digest('hex');
}

export interface CreateSpaceInput {
  kind: 'space' | 'folder';
  parentSpaceId?: string | null;
  name: string;
  description?: string;
  iconKey?: string;
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled?: boolean;
}

export interface CreateDirectoryInput {
  parentDirectoryId?: string | null;
  name: string;
}

export interface CreateSourceInput {
  kind: KnowledgeSourceDoc['kind'];
  directoryId?: string | null;
  name: string;
  searchEnabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateSegmentInput {
  question: string;
  answer: string;
  searchEnabled?: boolean;
  metadata?: Record<string, unknown>;
  indexes?: KnowledgeSegmentDoc['indexes'];
}

export class KnowledgeCatalogRepository {
  private readonly spaces: Model<KnowledgeSpaceDoc>;
  private readonly directories: Model<KnowledgeDirectoryDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly segments: Model<KnowledgeSegmentDoc>;
  private readonly jobs: Model<KnowledgeJobDoc>;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.spaces = models.KnowledgeSpace as Model<KnowledgeSpaceDoc>;
    this.directories = models.KnowledgeDirectory as Model<KnowledgeDirectoryDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
    this.segments = models.KnowledgeSegment as Model<KnowledgeSegmentDoc>;
    this.jobs = models.KnowledgeJob as Model<KnowledgeJobDoc>;
  }

  private baseFilter(context: TenantContext): { workspaceId: string; deletedAt: null } {
    return { workspaceId: requireWorkspaceId(context), deletedAt: null };
  }

  async listSpaces(
    query: PageRequest,
    context: TenantContext,
  ): Promise<PageResult<ReturnType<typeof spaceDto>>> {
    const limit = parseLimit(query.limit, context);
    const sort = parseSort(query.sort, context);
    const cursor = decodeCursor(query.cursor, context);
    const docs = (await this.spaces
      .find({
        ...this.baseFilter(context),
        ...cursorFilter(sort, cursor),
      })
      .sort({ [sort.field]: sort.direction, _id: sort.direction })
      .limit(limit + 1)
      .lean()) as unknown as Plain<KnowledgeSpaceDoc>[];
    return this.page(docs, limit, sort, spaceDto);
  }

  async createSpace(input: CreateSpaceInput, context: TenantContext) {
    requireWorkspaceId(context);
    const name = assertResourceName(input.name, 'name', 120, context);
    let parentSpaceId: Types.ObjectId | null = null;
    if (input.parentSpaceId) {
      parentSpaceId = objectIdOf(input.parentSpaceId, context, 'parentSpaceId');
      const parent = await this.spaces.findOne({
        ...this.baseFilter(context),
        _id: parentSpaceId,
      });
      if (!parent) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      if (parent.kind !== 'folder') throw tenantError(context);
    }
    const created = await this.spaces.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: null,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: input.kind,
      parentSpaceId,
      name,
      normalizedName: name.toLocaleLowerCase('en-US'),
      description: input.description ?? '',
      iconKey: input.iconKey ?? 'book-open',
      ownershipMemberId: context.memberId,
      accessMode: input.accessMode,
      sourceAclMode: input.sourceAclMode,
      sourcePermissionEnabled: input.sourcePermissionEnabled ?? true,
      referenceRevision: 0,
      permissionRevision: 0,
      modelBindings: {},
      defaultChunking: {},
      status: 'active',
    });
    const plain = created as unknown as Plain<KnowledgeSpaceDoc>;
    return spaceDto(plain);
  }

  async getSpace(spaceId: string, context: TenantContext) {
    const doc = (await this.spaces
      .findOne({
        ...this.baseFilter(context),
        _id: objectIdOf(spaceId, context, 'spaceId'),
      })
      .lean()) as unknown as Plain<KnowledgeSpaceDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return spaceDto(doc);
  }

  async updateSpace(spaceId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    const version = Number(input.version);
    if (!Number.isInteger(version) || version < 1) throw tenantError(context);
    const update: Record<string, unknown> = {};
    for (const field of [
      'description',
      'iconKey',
      'accessMode',
      'sourceAclMode',
      'sourcePermissionEnabled',
    ]) {
      if (input[field] !== undefined) update[field] = input[field];
    }
    if (input.name !== undefined) {
      const name = assertResourceName(input.name, 'name', 120, context);
      update.name = name;
      update.normalizedName = name.toLocaleLowerCase('en-US');
    }
    const updated = await workspaceCasUpdate(
      this.spaces,
      { id: spaceId, expectedVersion: version, update },
      context,
    );
    return spaceDto(updated as unknown as Plain<KnowledgeSpaceDoc>);
  }

  async deleteSpace(spaceId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    const version = Number(input.version);
    const expectedReferenceRevision = Number(input.expectedReferenceRevision);
    const objectId = objectIdOf(spaceId, context, 'spaceId');
    const session = await this.connection.startSession();
    try {
      let jobId: string | null = null;
      await session.withTransaction(async () => {
        const doc = await this.spaces
          .findOne({
            _id: objectId,
            workspaceId: context.workspaceId,
            version,
            deletedAt: null,
          })
          .session(session);
        if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        if (doc.referenceRevision !== expectedReferenceRevision) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'referenceRevision' },
          });
        }
        if (input.referenceStrategy !== 'detach') {
          const bindings = await this.connection.models.KnowledgeReferenceBinding?.countDocuments({
            workspaceId: context.workspaceId,
            knowledgeSpaceId: objectId,
            status: 'active',
            deletedAt: null,
          }).session(session);
          if ((bindings ?? 0) > 0) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_REFERENCE_CONFLICT',
              requestId: context.requestId,
              traceId: context.traceId,
              details: { references: bindings },
            });
          }
        }
        await this.spaces.updateOne(
          { _id: objectId, workspaceId: context.workspaceId, version },
          {
            $set: {
              status: 'deleting',
              deletedAt: new Date(),
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        const [job] = await this.jobs.create(
          [
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: objectId,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'delete',
              resourceType: 'space',
              resourceId: spaceId,
              status: 'queued',
              priority: 0,
              idempotencyKey: jobIdempotencyKey('delete:space', spaceId, version),
              inputSnapshot: { spaceId, version },
              progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
              attempts: 0,
              maxAttempts: 5,
              attemptEpoch: 0,
              fencingToken: 'unassigned',
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              availableAt: new Date(),
              cancelRequestedAt: null,
              pausedAt: null,
              error: null,
              result: null,
              expiresAt: new Date(Date.now() + 180 * 86_400_000),
            },
          ],
          { session },
        );
        if (!job) throw tenantError(context);
        jobId = String(job._id);
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: spaceId,
            eventType: 'delete',
            aggregateType: 'space',
            aggregateId: spaceId,
            queue: 'knowledge-delete',
            payload: { spaceId, jobId, version },
          },
          context,
          session,
        );
      });
      return operationResult(spaceId, jobId);
    } finally {
      await session.endSession();
    }
  }

  async listDirectories(spaceId: string, query: PageRequest, context: TenantContext) {
    const limit = parseLimit(query.limit, context);
    const docs = (await this.directories
      .find({
        ...this.baseFilter(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      })
      .sort({ depth: 1, sortOrder: 1, _id: 1 })
      .limit(limit)
      .lean()) as unknown as Plain<KnowledgeDirectoryDoc>[];
    return { items: docs.map(directoryDto) };
  }

  async createDirectory(spaceId: string, input: CreateDirectoryInput, context: TenantContext) {
    requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    const space = await this.spaces.findOne({
      ...this.baseFilter(context),
      _id: spaceObjectId,
    });
    if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const name = assertResourceName(input.name, 'name', 120, context);
    let parentDirectoryId: Types.ObjectId | null = null;
    let path: Types.ObjectId[] = [];
    let depth = 0;
    if (input.parentDirectoryId) {
      parentDirectoryId = objectIdOf(input.parentDirectoryId, context, 'parentDirectoryId');
      const parent = await this.directories.findOne({
        ...this.baseFilter(context),
        _id: parentDirectoryId,
        knowledgeSpaceId: spaceObjectId,
      });
      if (!parent) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      path = [...parent.path, parent._id as Types.ObjectId];
      depth = parent.depth + 1;
      assertDirectoryDepth(depth, context);
    }
    const created = await this.directories.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceObjectId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      parentDirectoryId,
      name,
      normalizedName: name.toLocaleLowerCase('en-US'),
      path,
      depth,
      sortOrder: 0,
      aclMode: 'inherited',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
    });
    return directoryDto(created as unknown as Plain<KnowledgeDirectoryDoc>);
  }

  async getDirectory(directoryId: string, context: TenantContext) {
    const doc = (await this.directories
      .findOne({
        ...this.baseFilter(context),
        _id: objectIdOf(directoryId, context, 'directoryId'),
      })
      .lean()) as unknown as Plain<KnowledgeDirectoryDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return directoryDto(doc);
  }

  async updateDirectory(
    directoryId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const version = Number(input.version);
    if (!Number.isInteger(version) || version < 1) throw tenantError(context);
    const update: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = assertResourceName(input.name, 'name', 120, context);
      update.name = name;
      update.normalizedName = name.toLocaleLowerCase('en-US');
    }
    const updated = await workspaceCasUpdate(
      this.directories,
      { id: directoryId, expectedVersion: version, update },
      context,
    );
    return directoryDto(updated as unknown as Plain<KnowledgeDirectoryDoc>);
  }

  async deleteDirectory(directoryId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const objectId = objectIdOf(directoryId, context, 'directoryId');
    const session = await this.connection.startSession();
    try {
      let jobId = '';
      await session.withTransaction(async () => {
        const doc = await this.directories
          .findOne({
            _id: objectId,
            workspaceId: context.workspaceId,
            deletedAt: null,
          })
          .session(session);
        if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        await this.directories.updateMany(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: doc.knowledgeSpaceId,
            deletedAt: null,
            $or: [{ _id: objectId }, { path: objectId }],
          },
          {
            $set: { deletedAt: new Date(), updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        const [job] = await this.jobs.create(
          [
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: doc.knowledgeSpaceId,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'delete',
              resourceType: 'directory',
              resourceId: directoryId,
              status: 'queued',
              priority: 0,
              idempotencyKey: jobIdempotencyKey('delete:directory', directoryId, doc.version),
              inputSnapshot: { directoryId, version: doc.version },
              progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
              attempts: 0,
              maxAttempts: 5,
              attemptEpoch: 0,
              fencingToken: 'unassigned',
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              availableAt: new Date(),
              cancelRequestedAt: null,
              pausedAt: null,
              error: null,
              result: null,
              expiresAt: new Date(Date.now() + 180 * 86_400_000),
            },
          ],
          { session },
        );
        if (!job) throw tenantError(context);
        jobId = String(job._id);
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(doc.knowledgeSpaceId),
            eventType: 'delete',
            aggregateType: 'directory',
            aggregateId: directoryId,
            queue: 'knowledge-delete',
            payload: { directoryId, jobId, version: doc.version },
          },
          context,
          session,
        );
      });
      return operationResult(directoryId, jobId);
    } finally {
      await session.endSession();
    }
  }

  async listSources(
    spaceId: string,
    query: PageRequest,
    context: TenantContext,
  ): Promise<PageResult<ReturnType<typeof sourceDto>>> {
    const limit = parseLimit(query.limit, context);
    const sort = parseSort(query.sort, context);
    const cursor = decodeCursor(query.cursor, context);
    const docs = (await this.sources
      .find({
        ...this.baseFilter(context),
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        ...cursorFilter(sort, cursor),
      })
      .sort({ [sort.field]: sort.direction, _id: sort.direction })
      .limit(limit + 1)
      .lean()) as unknown as Plain<KnowledgeSourceDoc>[];
    return this.page(docs, limit, sort, sourceDto);
  }

  async createSource(spaceId: string, input: CreateSourceInput, context: TenantContext) {
    requireWorkspaceId(context);
    const spaceObjectId = objectIdOf(spaceId, context, 'spaceId');
    const space = await this.spaces.findOne({
      ...this.baseFilter(context),
      _id: spaceObjectId,
    });
    if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const name = assertResourceName(input.name, 'name', 240, context);
    let directoryId: Types.ObjectId | null = null;
    if (input.directoryId) {
      directoryId = objectIdOf(input.directoryId, context, 'directoryId');
      const directory = await this.directories.findOne({
        ...this.baseFilter(context),
        _id: directoryId,
        knowledgeSpaceId: spaceObjectId,
      });
      if (!directory) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    }
    const created = await this.sources.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceObjectId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      directoryId,
      kind: input.kind,
      name,
      externalId: null,
      connectorId: null,
      blobRefId: null,
      originalUrl: null,
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      contentHash: createHash('sha256').update('').digest('hex'),
      parseProvider: 'liteparse',
      processingStatus: 'draft',
      sourceVersion: 1,
      searchEnabled: input.searchEnabled ?? true,
      permissionState: 'disabled',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
      metadata: input.metadata ?? {},
      tagValues: [],
    });
    return sourceDto(created as unknown as Plain<KnowledgeSourceDoc>);
  }

  async getSource(sourceId: string, context: TenantContext) {
    const doc = (await this.sources
      .findOne({
        ...this.baseFilter(context),
        _id: objectIdOf(sourceId, context, 'sourceId'),
      })
      .lean()) as unknown as Plain<KnowledgeSourceDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return sourceDto(doc);
  }

  async updateSource(sourceId: string, input: Record<string, unknown>, context: TenantContext) {
    const version = Number(input.version);
    if (!Number.isInteger(version) || version < 1) throw tenantError(context);
    const update: Record<string, unknown> = {};
    if (input.name !== undefined) {
      update.name = assertResourceName(input.name, 'name', 240, context);
    }
    if (input.searchEnabled !== undefined) update.searchEnabled = Boolean(input.searchEnabled);
    if (input.metadata !== undefined) update.metadata = input.metadata;
    const updated = await workspaceCasUpdate(
      this.sources,
      { id: sourceId, expectedVersion: version, update },
      context,
    );
    return sourceDto(updated as unknown as Plain<KnowledgeSourceDoc>);
  }

  async deleteSource(sourceId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const sourceObjectId = objectIdOf(sourceId, context, 'sourceId');
    const session = await this.connection.startSession();
    try {
      let jobId = '';
      await session.withTransaction(async () => {
        const source = await this.sources
          .findOne({
            _id: sourceObjectId,
            workspaceId: context.workspaceId,
            deletedAt: null,
          })
          .session(session);
        if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        const now = new Date();
        await this.sources.updateOne(
          { _id: sourceObjectId, workspaceId: context.workspaceId, version: source.version },
          {
            $set: {
              processingStatus: 'deleting',
              deletedAt: now,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.segments.updateMany(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: source.knowledgeSpaceId,
            sourceId: sourceObjectId,
            deletedAt: null,
          },
          {
            $set: { deletedAt: now, updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        const [job] = await this.jobs.create(
          [
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: source.knowledgeSpaceId,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'delete',
              resourceType: 'source',
              resourceId: sourceId,
              status: 'queued',
              priority: 0,
              idempotencyKey: jobIdempotencyKey('delete:source', sourceId, source.version),
              inputSnapshot: { sourceId, version: source.version },
              progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
              attempts: 0,
              maxAttempts: 5,
              attemptEpoch: 0,
              fencingToken: 'unassigned',
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              availableAt: new Date(),
              cancelRequestedAt: null,
              pausedAt: null,
              error: null,
              result: null,
              expiresAt: new Date(Date.now() + 180 * 86_400_000),
            },
          ],
          { session },
        );
        if (!job) throw tenantError(context);
        jobId = String(job._id);
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(source.knowledgeSpaceId),
            eventType: 'delete',
            aggregateType: 'source',
            aggregateId: sourceId,
            queue: 'knowledge-delete',
            payload: { sourceId, jobId, version: source.version },
          },
          context,
          session,
        );
      });
      return operationResult(sourceId, jobId);
    } finally {
      await session.endSession();
    }
  }

  async listSegments(
    sourceId: string,
    query: PageRequest,
    context: TenantContext,
  ): Promise<PageResult<ReturnType<typeof segmentDto>>> {
    const sourceObjectId = objectIdOf(sourceId, context, 'sourceId');
    const source = await this.sources.findOne({
      ...this.baseFilter(context),
      _id: sourceObjectId,
    });
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const limit = parseLimit(query.limit, context);
    const sort = parseSort(query.sort ?? 'order', context);
    const cursor = decodeCursor(query.cursor, context);
    const docs = (await this.segments
      .find({
        ...this.baseFilter(context),
        sourceId: sourceObjectId,
        ...cursorFilter(sort, cursor),
      })
      .sort({ [sort.field]: sort.direction, _id: sort.direction })
      .limit(limit + 1)
      .lean()) as unknown as Plain<KnowledgeSegmentDoc>[];
    return this.page(docs, limit, sort, segmentDto);
  }

  async createSegment(sourceId: string, input: CreateSegmentInput, context: TenantContext) {
    requireWorkspaceId(context);
    const sourceObjectId = objectIdOf(sourceId, context, 'sourceId');
    const source = await this.sources.findOne({
      ...this.baseFilter(context),
      _id: sourceObjectId,
    });
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const last = await this.segments
      .findOne({ ...this.baseFilter(context), sourceId: sourceObjectId })
      .sort({ order: -1 })
      .lean();
    const created = await this.segments.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: source.knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      sourceId: sourceObjectId,
      searchEnabled: source.searchEnabled && (input.searchEnabled ?? true),
      order: last ? last.order + 1 : 0,
      question: input.question,
      answer: input.answer,
      content: `${input.question}\n${input.answer}`.trim(),
      fullTextTokens: '',
      metadata: input.metadata ?? {},
      history: [],
      indexes: input.indexes ?? [],
      indexStatus: 'pending',
      indexErrorCode: null,
      imageBlobRefId: null,
      imageDescription: null,
      synonymVersion: 0,
    });
    return segmentDto(created as unknown as Plain<KnowledgeSegmentDoc>);
  }

  async getSegment(segmentId: string, context: TenantContext) {
    const doc = (await this.segments
      .findOne({
        ...this.baseFilter(context),
        _id: objectIdOf(segmentId, context, 'segmentId'),
      })
      .lean()) as unknown as Plain<KnowledgeSegmentDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return segmentDto(doc);
  }

  async updateSegment(segmentId: string, input: Record<string, unknown>, context: TenantContext) {
    const version = Number(input.version);
    if (!Number.isInteger(version) || version < 1) throw tenantError(context);
    const current = await this.segments.findOne({
      ...this.baseFilter(context),
      _id: objectIdOf(segmentId, context, 'segmentId'),
    });
    if (!current) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const source = await this.sources.findOne({
      ...this.baseFilter(context),
      _id: current.sourceId,
    });
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const update: Record<string, unknown> = {};
    if (input.question !== undefined) update.question = input.question;
    if (input.answer !== undefined) update.answer = input.answer;
    if (input.metadata !== undefined) update.metadata = input.metadata;
    if (input.searchEnabled !== undefined) {
      update.searchEnabled = source.searchEnabled && Boolean(input.searchEnabled);
    }
    if (input.question !== undefined || input.answer !== undefined) {
      const question = String(input.question ?? current.question);
      const answer = String(input.answer ?? current.answer);
      update.content = `${question}\n${answer}`.trim();
      const history = [
        ...current.history,
        {
          oldQuestion: current.question,
          oldAnswer: current.answer,
          updatedAt: new Date(),
          version: current.version,
        },
      ].slice(-20);
      update.history = history;
    }
    const updated = await workspaceCasUpdate(
      this.segments,
      { id: segmentId, expectedVersion: version, update },
      context,
    );
    return segmentDto(updated as unknown as Plain<KnowledgeSegmentDoc>);
  }

  async deleteSegment(segmentId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const objectId = objectIdOf(segmentId, context, 'segmentId');
    const session = await this.connection.startSession();
    try {
      let jobId = '';
      await session.withTransaction(async () => {
        const segment = await this.segments
          .findOne({
            _id: objectId,
            workspaceId: context.workspaceId,
            deletedAt: null,
          })
          .session(session);
        if (!segment) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        await this.segments.updateOne(
          { _id: objectId, workspaceId: context.workspaceId, version: segment.version },
          {
            $set: { deletedAt: new Date(), updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        const [job] = await this.jobs.create(
          [
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: segment.knowledgeSpaceId,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'delete',
              resourceType: 'segment',
              resourceId: segmentId,
              status: 'queued',
              priority: 0,
              idempotencyKey: jobIdempotencyKey('delete:segment', segmentId, segment.version),
              inputSnapshot: { segmentId, version: segment.version },
              progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
              attempts: 0,
              maxAttempts: 5,
              attemptEpoch: 0,
              fencingToken: 'unassigned',
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              availableAt: new Date(),
              cancelRequestedAt: null,
              pausedAt: null,
              error: null,
              result: null,
              expiresAt: new Date(Date.now() + 180 * 86_400_000),
            },
          ],
          { session },
        );
        if (!job) throw tenantError(context);
        jobId = String(job._id);
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(segment.knowledgeSpaceId),
            eventType: 'delete',
            aggregateType: 'segment',
            aggregateId: segmentId,
            queue: 'knowledge-delete',
            payload: { segmentId, jobId, version: segment.version },
          },
          context,
          session,
        );
      });
      return operationResult(segmentId, jobId);
    } finally {
      await session.endSession();
    }
  }

  private page<TDoc extends { _id: Types.ObjectId }, TDto>(
    docs: TDoc[],
    limit: number,
    sort: ReturnType<typeof parseSort>,
    mapper: (document: TDoc & Record<string, unknown>) => TDto,
  ): PageResult<TDto> {
    const hasMore = docs.length > limit;
    const visible = docs.slice(0, limit);
    return {
      items: visible.map((doc) => mapper(doc as TDoc & Record<string, unknown>)),
      pageInfo: {
        nextCursor:
          hasMore && visible.at(-1)
            ? encodeCursor(sort, visible.at(-1) as TDoc & Record<string, unknown>)
            : null,
        hasMore,
      },
    };
  }
}
