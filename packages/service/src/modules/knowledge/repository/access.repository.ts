import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeDirectoryDoc,
  KnowledgeSourceDoc,
  KnowledgeSpaceDoc,
} from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeAuditEventDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type {
  KnowledgeCollaboratorDoc,
  KnowledgeResourcePermissionDoc,
} from '../../../shared/persistence/schemas/knowledge-access.schemas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import {
  PERMISSION_LEVEL,
  permissionAllows,
  transitionSourcePermission,
  type AclResourceType,
  type PermissionLevel,
  type SourcePermissionAction,
  type SourcePermissionState,
} from '../domain/permission';

type Plain<T> = T & { _id: Types.ObjectId };

interface ResourceAccess {
  resourceType: AclResourceType;
  resourceId: Types.ObjectId;
  workspaceId: string;
  knowledgeSpaceId: Types.ObjectId;
  ownershipMemberId: string;
  version: number;
  permissionRevision: number;
  permissionState: SourcePermissionState;
  parentDirectoryId: Types.ObjectId | null;
}

interface AclEntry {
  principalType: 'member' | 'group' | 'workspace';
  principalId: string;
  permission: PermissionLevel;
}

function permissionDto(document: Plain<KnowledgeResourcePermissionDoc>) {
  return {
    principalType: document.principalType,
    principalId: document.principalId,
    permission: document.permission,
  };
}

function collaboratorDto(document: Plain<KnowledgeCollaboratorDoc>) {
  return {
    memberId: document.memberId,
    role: document.role,
    status: document.status,
    grantedAt: document.grantedAt.toISOString(),
    version: document.version,
  };
}

function auditEventId(): string {
  return randomUUID();
}

export class KnowledgeAccessRepository {
  private readonly spaces: Model<KnowledgeSpaceDoc>;
  private readonly directories: Model<KnowledgeDirectoryDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly permissions: Model<KnowledgeResourcePermissionDoc>;
  private readonly collaborators: Model<KnowledgeCollaboratorDoc>;
  private readonly audits: Model<KnowledgeAuditEventDoc>;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.spaces = models.KnowledgeSpace as Model<KnowledgeSpaceDoc>;
    this.directories = models.KnowledgeDirectory as Model<KnowledgeDirectoryDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
    this.permissions = models.KnowledgeResourcePermission as Model<KnowledgeResourcePermissionDoc>;
    this.collaborators = models.KnowledgeCollaborator as Model<KnowledgeCollaboratorDoc>;
    this.audits = models.KnowledgeAuditEvent as Model<KnowledgeAuditEventDoc>;
  }

  private async resolveResource(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
  ): Promise<ResourceAccess> {
    requireWorkspaceId(context);
    const id = objectIdOf(resourceId, context, 'resourceId');
    if (resourceType === 'space') {
      const doc = await this.spaces.findOne({
        workspaceId: context.workspaceId,
        _id: id,
        deletedAt: null,
      });
      if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      return {
        resourceType,
        resourceId: id,
        workspaceId: doc.workspaceId,
        knowledgeSpaceId: doc._id,
        ownershipMemberId: doc.ownershipMemberId,
        version: doc.version,
        permissionRevision: doc.permissionRevision,
        permissionState: doc.accessMode === 'restricted' ? 'independent' : 'inherited',
        parentDirectoryId: null,
      };
    }
    if (resourceType === 'directory') {
      const doc = await this.directories.findOne({
        workspaceId: context.workspaceId,
        _id: id,
        deletedAt: null,
      });
      if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      const knowledgeSpaceId = doc.knowledgeSpaceId;
      if (!knowledgeSpaceId) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      return {
        resourceType,
        resourceId: id,
        workspaceId: doc.workspaceId,
        knowledgeSpaceId,
        ownershipMemberId: doc.ownershipMemberId,
        version: doc.version,
        permissionRevision: doc.permissionRevision,
        permissionState: doc.aclMode === 'override' ? 'independent' : 'inherited',
        parentDirectoryId: doc.parentDirectoryId,
      };
    }
    const doc = await this.sources.findOne({
      workspaceId: context.workspaceId,
      _id: id,
      deletedAt: null,
    });
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    if (!doc.knowledgeSpaceId) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return {
      resourceType,
      resourceId: id,
      workspaceId: doc.workspaceId,
      knowledgeSpaceId: doc.knowledgeSpaceId,
      ownershipMemberId: doc.ownershipMemberId,
      version: doc.version,
      permissionRevision: doc.permissionRevision,
      permissionState: doc.permissionState,
      parentDirectoryId: doc.directoryId,
    };
  }

  private async localEntries(
    resourceType: AclResourceType,
    resourceId: Types.ObjectId,
    context: TenantContext,
  ): Promise<AclEntry[]> {
    const entries = await this.permissions
      .find({
        workspaceId: context.workspaceId,
        resourceType,
        resourceId,
        deletedAt: null,
      })
      .sort({ principalType: 1, principalId: 1 })
      .lean();
    return entries.map((entry) =>
      permissionDto(entry as unknown as Plain<KnowledgeResourcePermissionDoc>),
    );
  }

  private async parentEntries(
    resource: ResourceAccess,
    context: TenantContext,
  ): Promise<AclEntry[]> {
    if (resource.resourceType === 'space') return [];
    if (resource.resourceType === 'directory' && resource.parentDirectoryId) {
      const parent = await this.directories.findOne({
        workspaceId: context.workspaceId,
        _id: resource.parentDirectoryId,
        deletedAt: null,
      });
      if (parent?.aclMode === 'override') {
        return this.localEntries('directory', parent._id, context);
      }
    }
    if (resource.resourceType === 'source' && resource.parentDirectoryId) {
      const directory = await this.directories.findOne({
        workspaceId: context.workspaceId,
        _id: resource.parentDirectoryId,
        deletedAt: null,
      });
      if (directory?.aclMode === 'override') {
        return this.localEntries('directory', directory._id, context);
      }
    }
    return this.localEntries('space', resource.knowledgeSpaceId, context);
  }

  private async effectiveEntries(
    resource: ResourceAccess,
    context: TenantContext,
  ): Promise<AclEntry[]> {
    if (resource.resourceType === 'space') {
      return this.localEntries('space', resource.resourceId, context);
    }
    if (resource.permissionState === 'disabled') {
      return this.parentEntries(resource, context);
    }
    if (resource.permissionState === 'independent') {
      return this.localEntries(resource.resourceType, resource.resourceId, context);
    }
    return [...(await this.parentEntries(resource, context))];
  }

  async getAcl(resourceType: AclResourceType, resourceId: string, context: TenantContext) {
    await this.assertPermission(resourceType, resourceId, 'read', context);
    const resource = await this.resolveResource(resourceType, resourceId, context);
    const entries =
      resource.permissionState === 'independent'
        ? await this.localEntries(resourceType, resource.resourceId, context)
        : await this.effectiveEntries(resource, context);
    const snapshots = await this.permissions
      .find({
        workspaceId: context.workspaceId,
        resourceType,
        resourceId: resource.resourceId,
        deletedAt: null,
      })
      .select({ snapshotVersion: 1 })
      .lean();
    return {
      resourceType,
      resourceId,
      inheritMode: resource.permissionState === 'independent' ? 'override' : 'inherit',
      permissionState: resource.permissionState,
      permissionRevision: resource.permissionRevision,
      snapshotVersion: Math.max(1, ...snapshots.map((entry) => entry.snapshotVersion)),
      entries,
    };
  }

  async exportAclSnapshot(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
  ) {
    const resource = await this.resolveResource(resourceType, resourceId, context);
    const entries =
      resource.permissionState === 'independent'
        ? await this.localEntries(resourceType, resource.resourceId, context)
        : await this.effectiveEntries(resource, context);
    return {
      permissionState: resource.permissionState,
      permissionRevision: resource.permissionRevision,
      entries,
    };
  }

  async assertPermission(
    resourceType: AclResourceType,
    resourceId: string,
    required: PermissionLevel,
    context: TenantContext,
  ): Promise<ResourceAccess> {
    const resource = await this.resolveResource(resourceType, resourceId, context);
    if (context.isWorkspaceOwner || resource.ownershipMemberId === context.memberId) {
      return resource;
    }
    const entries = await this.effectiveEntries(resource, context);
    const strongest = entries.reduce<PermissionLevel | null>((current, entry) => {
      const applies =
        (entry.principalType === 'member' && entry.principalId === context.memberId) ||
        (entry.principalType === 'workspace' && entry.principalId === context.workspaceId);
      if (!applies) return current;
      return current === null || PERMISSION_LEVEL[entry.permission] > PERMISSION_LEVEL[current]
        ? entry.permission
        : current;
    }, null);
    if (!permissionAllows(strongest, required)) {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    }
    return resource;
  }

  private stateForMode(inheritMode: 'inherit' | 'override') {
    return inheritMode === 'override' ? 'independent' : 'inherited';
  }

  private async writeAudit(
    input: {
      workspaceId: string;
      knowledgeSpaceId: Types.ObjectId;
      action: string;
      resourceType: string;
      resourceId: string;
      outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
      safeDiff: Record<string, unknown>;
    },
    context: TenantContext,
    session: ClientSession,
  ): Promise<void> {
    const now = new Date();
    await this.audits.create(
      [
        {
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          eventId: auditEventId(),
          action: input.action,
          actorMemberId: context.memberId,
          apiKeyId: context.apiKeyId ? new Types.ObjectId(context.apiKeyId) : null,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          outcome: input.outcome,
          traceId: context.traceId,
          requestId: context.requestId,
          ipHash: createHash('sha256').update(context.requestId).digest('hex'),
          userAgentHash: createHash('sha256').update(context.traceId).digest('hex'),
          safeDiff: input.safeDiff,
          occurredAt: now,
          expiresAt: new Date(now.getTime() + 730 * 86_400_000),
        },
      ],
      { session, ordered: true },
    );
  }

  private async updateResourceAclState(
    resource: ResourceAccess,
    permissionState: SourcePermissionState,
    expectedVersion: number,
    context: TenantContext,
    session: ClientSession,
  ): Promise<void> {
    const update =
      resource.resourceType === 'space'
        ? { sourceAclMode: permissionState === 'independent' ? 'enforced' : 'inherited' }
        : resource.resourceType === 'directory'
          ? { aclMode: permissionState === 'independent' ? 'override' : 'inherited' }
          : { permissionState };
    const filter = {
      _id: resource.resourceId,
      workspaceId: context.workspaceId,
      version: expectedVersion,
      deletedAt: null,
    };
    const mutation = {
      $set: { ...update, updatedByMemberId: context.memberId },
      $inc: { version: 1, permissionRevision: 1 },
    };
    const result =
      resource.resourceType === 'space'
        ? await this.spaces.updateOne(filter, mutation, { session })
        : resource.resourceType === 'directory'
          ? await this.directories.updateOne(filter, mutation, { session })
          : await this.sources.updateOne(filter, mutation, { session });
    if (result.modifiedCount !== 1) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { resourceId: String(resource.resourceId), expectedVersion },
      });
    }
  }

  private async replaceLocalEntries(
    resource: ResourceAccess,
    entries: readonly AclEntry[],
    snapshotVersion: number,
    context: TenantContext,
    session: ClientSession,
  ): Promise<void> {
    await this.permissions.deleteMany(
      {
        workspaceId: context.workspaceId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      },
      { session },
    );
    if (entries.length === 0) return;
    await this.permissions.create(
      entries.map((entry) => ({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: resource.knowledgeSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        principalType: entry.principalType,
        principalId: entry.principalId,
        permission: entry.permission,
        inheritMode: 'override',
        snapshotVersion,
      })),
      { session, ordered: true },
    );
  }

  async updateAcl(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission(resourceType, resourceId, 'manage', context);
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    if (!Array.isArray(input.entries)) throw tenantError(context);
    const entries = input.entries.map((raw) => {
      const entry = raw as Record<string, unknown>;
      const permission = entry.permission as PermissionLevel;
      if (!['read', 'write', 'manage', 'owner'].includes(permission)) throw tenantError(context);
      return {
        principalType: entry.principalType as AclEntry['principalType'],
        principalId: String(entry.principalId),
        permission,
      };
    }) as AclEntry[];
    const inheritMode = input.inheritMode === 'override' ? 'override' : 'inherit';
    const permissionState = this.stateForMode(inheritMode);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.replaceLocalEntries(
          resource,
          permissionState === 'independent' ? entries : [],
          resource.permissionRevision + 2,
          context,
          session,
        );
        await this.updateResourceAclState(
          resource,
          permissionState,
          expectedVersion,
          context,
          session,
        );
        await this.writeAudit(
          {
            workspaceId: resource.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'acl.update',
            resourceType,
            resourceId,
            outcome: 'succeeded',
            safeDiff: { permissionState, entryCount: entries.length },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return this.getAcl(resourceType, resourceId, context);
  }

  async resumeAcl(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission(resourceType, resourceId, 'manage', context);
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.permissions.deleteMany(
          {
            workspaceId: context.workspaceId,
            resourceType,
            resourceId: resource.resourceId,
          },
          { session },
        );
        await this.updateResourceAclState(resource, 'inherited', expectedVersion, context, session);
        await this.writeAudit(
          {
            workspaceId: resource.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'acl.resume',
            resourceType,
            resourceId,
            outcome: 'succeeded',
            safeDiff: { permissionState: 'inherited' },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return this.getAcl(resourceType, resourceId, context);
  }

  async ensureOwnerAcl(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
    extraEntries: readonly AclEntry[] = [],
  ) {
    const resource = await this.resolveResource(resourceType, resourceId, context);
    const entries: AclEntry[] = [
      { principalType: 'member', principalId: resource.ownershipMemberId, permission: 'owner' },
      ...extraEntries,
    ];
    const unique = new Map(
      entries.map((entry) => [`${entry.principalType}:${entry.principalId}`, entry]),
    );
    await this.permissions.deleteMany({
      workspaceId: context.workspaceId,
      resourceType,
      resourceId: resource.resourceId,
    });
    await this.permissions.create(
      [...unique.values()].map((entry) => ({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: resource.knowledgeSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        resourceType,
        resourceId: resource.resourceId,
        principalType: entry.principalType,
        principalId: entry.principalId,
        permission: entry.permission,
        inheritMode: 'override',
        snapshotVersion: 1,
      })),
      { ordered: true },
    );
  }

  async transitionSourcePermission(
    sourceId: string,
    action: SourcePermissionAction,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission('source', sourceId, 'manage', context);
    if (Number(input.expectedPermissionRevision) !== resource.permissionRevision) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'expectedPermissionRevision' },
      });
    }
    const next = transitionSourcePermission(resource.permissionState, action, context);
    const expectedVersion = Number(input.version);
    const source = await this.sources.findOne({
      workspaceId: context.workspaceId,
      _id: resource.resourceId,
      deletedAt: null,
    });
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        if (next === 'independent') {
          const inherited = await this.effectiveEntries(resource, context);
          await this.replaceLocalEntries(
            resource,
            inherited,
            resource.permissionRevision + 2,
            context,
            session,
          );
        } else {
          await this.permissions.deleteMany(
            {
              workspaceId: context.workspaceId,
              resourceType: 'source',
              resourceId: resource.resourceId,
            },
            { session },
          );
        }
        const result = await this.sources.updateOne(
          {
            _id: resource.resourceId,
            workspaceId: context.workspaceId,
            version: expectedVersion,
            permissionRevision: resource.permissionRevision,
            deletedAt: null,
          },
          {
            $set: {
              permissionState: next,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1, permissionRevision: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'version' },
          });
        }
        await this.writeAudit(
          {
            workspaceId: resource.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: `source.permission.${action}`,
            resourceType: 'source',
            resourceId: sourceId,
            outcome: 'succeeded',
            safeDiff: { from: resource.permissionState, to: next },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return this.getAcl('source', sourceId, context);
  }

  async listCollaborators(spaceId: string, context: TenantContext) {
    await this.assertPermission('space', spaceId, 'read', context);
    const docs = (await this.collaborators
      .find({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        status: 'active',
        deletedAt: null,
      })
      .sort({ grantedAt: 1, memberId: 1 })
      .lean()) as unknown as Plain<KnowledgeCollaboratorDoc>[];
    return { items: docs.map(collaboratorDto) };
  }

  private async upsertCollaboratorPermission(
    resource: ResourceAccess,
    memberId: string,
    role: PermissionLevel,
    context: TenantContext,
    session: ClientSession,
  ) {
    await this.permissions.updateOne(
      {
        workspaceId: context.workspaceId,
        resourceType: 'space',
        resourceId: resource.resourceId,
        principalType: 'member',
        principalId: memberId,
      },
      {
        $set: {
          knowledgeSpaceId: resource.knowledgeSpaceId,
          permission: role,
          inheritMode: 'override',
          deletedAt: null,
          updatedByMemberId: context.memberId,
        },
        $setOnInsert: {
          createdByMemberId: context.memberId,
          snapshotVersion: resource.permissionRevision + 2,
        },
        $inc: { version: 1 },
      },
      { upsert: true, session },
    );
  }

  private async bumpSpacePermissionRevision(
    resource: ResourceAccess,
    context: TenantContext,
    session: ClientSession,
  ) {
    const result = await this.spaces.updateOne(
      { _id: resource.resourceId, workspaceId: context.workspaceId, deletedAt: null },
      {
        $set: { updatedByMemberId: context.memberId },
        $inc: { version: 1, permissionRevision: 1 },
      },
      { session },
    );
    if (result.modifiedCount !== 1) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
  }

  async createCollaborator(
    spaceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission('space', spaceId, 'manage', context);
    const memberId = String(input.memberId ?? '');
    const role = input.role as PermissionLevel;
    if (!memberId || !['read', 'write', 'manage'].includes(role)) throw tenantError(context);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.collaborators.create(
          [
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: resource.knowledgeSpaceId,
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              memberId,
              role,
              status: 'active',
              grantedAt: new Date(),
              grantedByMemberId: context.memberId,
              revokedAt: null,
            },
          ],
          { session },
        );
        await this.upsertCollaboratorPermission(resource, memberId, role, context, session);
        await this.bumpSpacePermissionRevision(resource, context, session);
        await this.writeAudit(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'collaborator.create',
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: { memberId, role },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return {
      memberId,
      role,
      status: 'active' as const,
      grantedAt: new Date().toISOString(),
      version: 1,
    };
  }

  async updateCollaborator(
    spaceId: string,
    memberId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission('space', spaceId, 'manage', context);
    const role = input.role as PermissionLevel;
    const expectedVersion = Number(input.version);
    if (!['read', 'write', 'manage'].includes(role) || !Number.isInteger(expectedVersion)) {
      throw tenantError(context);
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await this.collaborators.updateOne(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.resourceId,
            memberId,
            version: expectedVersion,
            status: 'active',
            deletedAt: null,
          },
          {
            $set: { role, updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { memberId, expectedVersion },
          });
        }
        await this.upsertCollaboratorPermission(resource, memberId, role, context, session);
        await this.bumpSpacePermissionRevision(resource, context, session);
        await this.writeAudit(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'collaborator.update',
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: { memberId, role },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return this.getCollaborator(spaceId, memberId, context);
  }

  private async getCollaborator(spaceId: string, memberId: string, context: TenantContext) {
    const doc = await this.collaborators.findOne({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      memberId,
      status: 'active',
      deletedAt: null,
    });
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return collaboratorDto(doc.toObject() as unknown as Plain<KnowledgeCollaboratorDoc>);
  }

  async deleteCollaborator(spaceId: string, memberId: string, context: TenantContext) {
    const resource = await this.assertPermission('space', spaceId, 'manage', context);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const result = await this.collaborators.updateOne(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.resourceId,
            memberId,
            status: 'active',
            deletedAt: null,
          },
          {
            $set: {
              status: 'revoked',
              revokedAt: now,
              deletedAt: now,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
        await this.permissions.deleteOne(
          {
            workspaceId: context.workspaceId,
            resourceType: 'space',
            resourceId: resource.resourceId,
            principalType: 'member',
            principalId: memberId,
          },
          { session },
        );
        await this.bumpSpacePermissionRevision(resource, context, session);
        await this.writeAudit(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'collaborator.delete',
            resourceType: 'space',
            resourceId: spaceId,
            outcome: 'succeeded',
            safeDiff: { memberId },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async transferOwnership(
    resourceType: AclResourceType,
    resourceId: string,
    input: Record<string, unknown>,
    context: TenantContext,
  ) {
    const resource = await this.assertPermission(resourceType, resourceId, 'owner', context);
    const targetMemberId = String(input.targetMemberId ?? '');
    const expectedVersion = Number(input.version);
    if (!targetMemberId || !Number.isInteger(expectedVersion)) throw tenantError(context);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const filter = {
          _id: resource.resourceId,
          workspaceId: context.workspaceId,
          version: expectedVersion,
          deletedAt: null,
        };
        const mutation = {
          $set: {
            ownershipMemberId: targetMemberId,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1, permissionRevision: 1 },
        };
        const result =
          resourceType === 'space'
            ? await this.spaces.updateOne(filter, mutation, { session })
            : resourceType === 'directory'
              ? await this.directories.updateOne(filter, mutation, { session })
              : await this.sources.updateOne(filter, mutation, { session });
        if (result.modifiedCount !== 1) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CONFLICT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { field: 'version' },
          });
        }
        await this.permissions.deleteOne(
          {
            workspaceId: context.workspaceId,
            resourceType,
            resourceId: resource.resourceId,
            principalType: 'member',
            principalId: resource.ownershipMemberId,
          },
          { session },
        );
        await this.permissions.updateOne(
          {
            workspaceId: context.workspaceId,
            resourceType,
            resourceId: resource.resourceId,
            principalType: 'member',
            principalId: targetMemberId,
          },
          {
            $set: {
              knowledgeSpaceId: resource.knowledgeSpaceId,
              permission: 'owner',
              inheritMode: 'override',
              deletedAt: null,
              updatedByMemberId: context.memberId,
            },
            $setOnInsert: {
              createdByMemberId: context.memberId,
              snapshotVersion: resource.permissionRevision + 2,
            },
            $inc: { version: 1 },
          },
          { upsert: true, session },
        );
        await this.writeAudit(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            action: 'ownership.transfer',
            resourceType,
            resourceId,
            outcome: 'succeeded',
            safeDiff: { from: resource.ownershipMemberId, to: targetMemberId },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return this.getAcl(resourceType, resourceId, context);
  }
}
