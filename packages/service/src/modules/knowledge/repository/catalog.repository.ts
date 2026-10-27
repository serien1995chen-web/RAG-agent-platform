import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
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
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import {
  assertCatalogMoveDepth,
  assertCatalogNoCycle,
  assertDirectoryDepth,
  assertResourceName,
} from '../domain/hierarchy';
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

function spaceDto(document: Plain<KnowledgeSpaceDoc>, parentPath?: string[]) {
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
    ...(parentPath ? { parentPath } : {}),
  };
}

function directoryDto(document: Plain<KnowledgeDirectoryDoc>, parentPath?: string[]) {
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
    ...(parentPath ? { parentPath } : {}),
  };
}

function sourceDto(document: Plain<KnowledgeSourceDoc>, parentPath?: string[]) {
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
    ...(parentPath ? { parentPath } : {}),
  };
}

function segmentDto(document: Plain<KnowledgeSegmentDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    sourceId: String(document.sourceId),
    sourceVersion: document.sourceVersion,
    searchEnabled: document.searchEnabled,
    order: document.order,
    question: document.question,
    answer: document.answer,
    content: document.content,
    fullTextTokens: document.fullTextTokens,
    fullTextVersion: document.fullTextVersion,
    metadata: document.metadata,
    indexes: document.indexes,
    indexStatus: document.indexStatus,
    indexErrorCode: document.indexErrorCode,
    imageBlobRefId: document.imageBlobRefId ? String(document.imageBlobRefId) : null,
    history: document.history,
    version: document.version,
  };
}

function operationResult(id: string, jobId?: string | null) {
  return { id, status: 'accepted', jobId: jobId ?? null };
}

function jobIdempotencyKey(kind: string, resourceId: string, version: number): string {
  return createHash('sha256').update(`${kind}|${resourceId}|${version}`).digest('hex');
}

function duplicateKeyConflict(error: unknown, context: TenantContext): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  ) {
    return createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { reason: 'sibling_name_conflict' },
    });
  }
  return error;
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
  private readonly audit: KnowledgeAuditRepository;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.spaces = models.KnowledgeSpace as Model<KnowledgeSpaceDoc>;
    this.directories = models.KnowledgeDirectory as Model<KnowledgeDirectoryDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
    this.segments = models.KnowledgeSegment as Model<KnowledgeSegmentDoc>;
    this.jobs = models.KnowledgeJob as Model<KnowledgeJobDoc>;
    this.audit = new KnowledgeAuditRepository(connection);
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
            details: { references: bindings, strategy: input.referenceStrategy ?? 'block' },
          });
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
        await this.audit.append(
          {
            knowledgeSpaceId: spaceId,
            action: 'space.delete',
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: { version, jobId, referenceRevision: expectedReferenceRevision },
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

  private async spaceAncestorIds(
    document: Pick<KnowledgeSpaceDoc, 'parentSpaceId'>,
    context: TenantContext,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const result: Types.ObjectId[] = [];
    const visited = new Set<string>();
    let parentId = document.parentSpaceId;
    while (parentId) {
      const key = String(parentId);
      if (visited.has(key)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'catalog_cycle', parentSpaceId: key },
        });
      }
      visited.add(key);
      const parent = await this.spaces
        .findOne({ ...this.baseFilter(context), _id: parentId })
        .session(session ?? null);
      if (!parent) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      result.unshift(parent._id as Types.ObjectId);
      parentId = parent.parentSpaceId;
    }
    return result;
  }

  private async spaceSubtreeHeight(
    rootId: Types.ObjectId,
    context: TenantContext,
    session: ClientSession,
  ): Promise<number> {
    let frontier = [rootId];
    let height = 1;
    const visited = new Set(frontier.map(String));
    while (frontier.length > 0) {
      const children = await this.spaces
        .find({
          ...this.baseFilter(context),
          parentSpaceId: { $in: frontier },
        })
        .select({ _id: 1 })
        .session(session)
        .lean();
      if (children.length === 0) break;
      frontier = children
        .map((child) => child._id as Types.ObjectId)
        .filter((id) => {
          const key = String(id);
          if (visited.has(key)) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_CONFLICT',
              requestId: context.requestId,
              traceId: context.traceId,
              details: { reason: 'catalog_cycle', resourceId: key },
            });
          }
          visited.add(key);
          return true;
        });
      height += 1;
    }
    return height;
  }

  async moveSpace(spaceId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    const targetParentId =
      input.targetParentId === null || input.targetParentId === undefined
        ? null
        : String(input.targetParentId);
    try {
      return await withMongoTransaction(this.connection, async (session) => {
        const id = objectIdOf(spaceId, context, 'spaceId');
        const current = await this.spaces
          .findOne({
            _id: id,
            workspaceId: context.workspaceId,
            version: expectedVersion,
            deletedAt: null,
          })
          .session(session);
        if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
        const targetParentPath: Types.ObjectId[] = [];
        if (targetParentId) {
          const parent = await this.spaces
            .findOne({
              ...this.baseFilter(context),
              _id: objectIdOf(targetParentId, context, 'targetParentId'),
            })
            .session(session);
          if (!parent) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
          if (parent.kind !== 'folder') {
            throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
              field: 'targetParentId',
              reason: 'folder_required',
            });
          }
          targetParentPath.push(...(await this.spaceAncestorIds(parent, context, session)));
          targetParentPath.push(parent._id as Types.ObjectId);
        }
        assertCatalogNoCycle(spaceId, targetParentId, targetParentPath.map(String), context);
        const height = await this.spaceSubtreeHeight(id, context, session);
        assertCatalogMoveDepth(targetParentPath.length + height - 1, context);
        if (String(current.parentSpaceId ?? '') === String(targetParentId ?? '')) {
          return spaceDto(
            current.toObject() as unknown as Plain<KnowledgeSpaceDoc>,
            targetParentPath.map(String),
          );
        }
        const updated = await this.spaces.findOneAndUpdate(
          {
            _id: id,
            workspaceId: context.workspaceId,
            version: expectedVersion,
            deletedAt: null,
          },
          {
            $set: {
              parentSpaceId: targetParentId
                ? objectIdOf(targetParentId, context, 'targetParentId')
                : null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        );
        if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
        await this.audit.append(
          {
            knowledgeSpaceId: spaceId,
            action: 'space.move',
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: {
              fromParentId: current.parentSpaceId ? String(current.parentSpaceId) : null,
              targetParentId,
              version: expectedVersion,
            },
          },
          context,
          session,
        );
        return spaceDto(
          updated.toObject() as unknown as Plain<KnowledgeSpaceDoc>,
          targetParentPath.map(String),
        );
      });
    } catch (error) {
      throw duplicateKeyConflict(error, context);
    }
  }

  async moveDirectoryTree(
    directoryId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    const targetParentId =
      input.targetParentId === null || input.targetParentId === undefined
        ? null
        : String(input.targetParentId);
    try {
      return await withMongoTransaction(this.connection, async (session) => {
        const id = objectIdOf(directoryId, context, 'directoryId');
        const current = await this.directories
          .findOne({
            _id: id,
            workspaceId: context.workspaceId,
            version: expectedVersion,
            deletedAt: null,
          })
          .session(session);
        if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
        let targetPath: Types.ObjectId[] = [];
        if (targetParentId) {
          const parent = await this.directories
            .findOne({
              ...this.baseFilter(context),
              _id: objectIdOf(targetParentId, context, 'targetParentId'),
              knowledgeSpaceId: current.knowledgeSpaceId,
            })
            .session(session);
          if (!parent) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
          targetPath = [...parent.path, parent._id as Types.ObjectId];
        }
        assertCatalogNoCycle(directoryId, targetParentId, targetPath.map(String), context);
        const subtree = (await this.directories
          .find({
            ...this.baseFilter(context),
            knowledgeSpaceId: current.knowledgeSpaceId,
            $or: [{ _id: id }, { path: id }],
          })
          .session(session)
          .lean()) as unknown as Plain<KnowledgeDirectoryDoc>[];
        const deepest = Math.max(...subtree.map((entry) => entry.depth));
        const height = deepest - current.depth + 1;
        assertCatalogMoveDepth(targetPath.length + height - 1, context);
        if (String(current.parentDirectoryId ?? '') === String(targetParentId ?? '')) {
          return directoryDto(
            current.toObject() as unknown as Plain<KnowledgeDirectoryDoc>,
            targetPath.map(String),
          );
        }
        const updatedCurrent = await this.directories.findOneAndUpdate(
          {
            _id: id,
            workspaceId: context.workspaceId,
            version: expectedVersion,
            deletedAt: null,
          },
          {
            $set: {
              parentDirectoryId: targetParentId
                ? objectIdOf(targetParentId, context, 'targetParentId')
                : null,
              path: targetPath,
              depth: targetPath.length,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        );
        if (!updatedCurrent) {
          throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
        }
        const descendants = subtree.filter((entry) => String(entry._id) !== directoryId);
        for (const descendant of descendants) {
          const index = descendant.path.findIndex((entry) => String(entry) === directoryId);
          if (index < 0) continue;
          const nextPath = [...targetPath, id, ...descendant.path.slice(index + 1)];
          const result = await this.directories.updateOne(
            {
              _id: descendant._id,
              workspaceId: context.workspaceId,
              version: descendant.version,
              deletedAt: null,
            },
            {
              $set: {
                path: nextPath,
                depth: nextPath.length,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1 },
            },
            { session },
          );
          if (result.modifiedCount !== 1) {
            throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
              resourceId: String(descendant._id),
            });
          }
        }
        await this.audit.append(
          {
            knowledgeSpaceId: String(current.knowledgeSpaceId),
            action: 'directory.move',
            resourceType: 'directory',
            resourceId: directoryId,
            outcome: 'succeeded',
            safeDiff: {
              fromParentId: current.parentDirectoryId ? String(current.parentDirectoryId) : null,
              targetParentId,
              descendantCount: descendants.length,
              version: expectedVersion,
            },
          },
          context,
          session,
        );
        return directoryDto(
          updatedCurrent.toObject() as unknown as Plain<KnowledgeDirectoryDoc>,
          targetPath.map(String),
        );
      });
    } catch (error) {
      throw duplicateKeyConflict(error, context);
    }
  }

  async moveSource(sourceId: string, input: Record<string, unknown>, context: TenantContext) {
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    const targetDirectoryId =
      input.targetParentId === null || input.targetParentId === undefined
        ? null
        : String(input.targetParentId);
    return withMongoTransaction(this.connection, async (session) => {
      const id = objectIdOf(sourceId, context, 'sourceId');
      const current = await this.sources
        .findOne({
          _id: id,
          workspaceId: context.workspaceId,
          version: expectedVersion,
          deletedAt: null,
        })
        .session(session);
      if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
      let targetPath: Types.ObjectId[] = [];
      if (targetDirectoryId) {
        const directory = await this.directories
          .findOne({
            ...this.baseFilter(context),
            _id: objectIdOf(targetDirectoryId, context, 'targetParentId'),
            knowledgeSpaceId: current.knowledgeSpaceId,
          })
          .session(session);
        if (!directory) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        targetPath = [...directory.path, directory._id as Types.ObjectId];
      }
      if (String(current.directoryId ?? '') === String(targetDirectoryId ?? '')) {
        return sourceDto(
          current.toObject() as unknown as Plain<KnowledgeSourceDoc>,
          targetPath.map(String),
        );
      }
      const updated = await this.sources.findOneAndUpdate(
        {
          _id: id,
          workspaceId: context.workspaceId,
          version: expectedVersion,
          deletedAt: null,
        },
        {
          $set: {
            directoryId: targetDirectoryId
              ? objectIdOf(targetDirectoryId, context, 'targetParentId')
              : null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true, runValidators: true, session },
      );
      if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { field: 'version' });
      await this.audit.append(
        {
          knowledgeSpaceId: String(current.knowledgeSpaceId),
          action: 'source.move',
          resourceType: 'source',
          resourceId: sourceId,
          outcome: 'succeeded',
          safeDiff: {
            fromDirectoryId: current.directoryId ? String(current.directoryId) : null,
            targetDirectoryId,
            version: expectedVersion,
          },
        },
        context,
        session,
      );
      return sourceDto(
        updated.toObject() as unknown as Plain<KnowledgeSourceDoc>,
        targetPath.map(String),
      );
    });
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
    return { items: docs.map((doc) => directoryDto(doc)) };
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
        await this.audit.append(
          {
            knowledgeSpaceId: String(doc.knowledgeSpaceId),
            action: 'directory.delete',
            resourceType: 'directory',
            resourceId: directoryId,
            outcome: 'succeeded',
            safeDiff: { version: doc.version, jobId },
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

  async deleteSource(sourceId: string, context: TenantContext, expectedVersion?: number) {
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
        if (
          expectedVersion !== undefined &&
          (!Number.isInteger(expectedVersion) || source.version !== expectedVersion)
        ) {
          throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
            resourceId: sourceId,
            expectedVersion,
          });
        }
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
        await this.audit.append(
          {
            knowledgeSpaceId: String(source.knowledgeSpaceId),
            action: 'source.delete',
            resourceType: 'source',
            resourceId: sourceId,
            outcome: 'succeeded',
            safeDiff: { version: source.version, jobId },
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
      sourceVersion: source.sourceVersion,
      searchEnabled: source.searchEnabled && (input.searchEnabled ?? true),
      order: last ? last.order + 1 : 0,
      question: input.question,
      answer: input.answer,
      content: `${input.question}\n${input.answer}`.trim(),
      fullTextTokens: '',
      fullTextVersion: 0,
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
          version: current.version,
          question: current.question,
          answer: current.answer,
          changedAt: new Date(),
          changedByMemberId: context.memberId,
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
