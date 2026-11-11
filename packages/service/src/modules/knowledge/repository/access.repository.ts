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
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
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
  snapshotVersion: number;
  permissionState: SourcePermissionState;
  parentDirectoryId: Types.ObjectId | null;
  parentSpaceId: Types.ObjectId | null;
  sourcePermissionEnabled: boolean;
}

interface AclEntry {
  principalType: 'member' | 'group' | 'org' | 'workspace';
  principalId: string;
  permission: PermissionLevel;
}

type PrincipalMembershipContext = TenantContext & {
  groupIds?: readonly string[];
  orgIds?: readonly string[];
};

export interface KnowledgePrincipalDirectoryPort {
  isActiveMember(workspaceId: string, memberId: string): Promise<boolean>;
}

export class StaticKnowledgePrincipalDirectory implements KnowledgePrincipalDirectoryPort {
  private readonly members: ReadonlySet<string>;

  constructor(entries: readonly { workspaceId: string; memberId: string }[]) {
    this.members = new Set(entries.map((entry) => `${entry.workspaceId}:${entry.memberId}`));
  }

  async isActiveMember(workspaceId: string, memberId: string): Promise<boolean> {
    return this.members.has(`${workspaceId}:${memberId}`);
  }
}

function membershipIds(context: TenantContext, key: 'groupIds' | 'orgIds'): ReadonlySet<string> {
  const values = (context as PrincipalMembershipContext)[key];
  return new Set((values ?? []).map(String));
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
      details: { reason: 'duplicate_collaborator' },
    });
  }
  return error;
}

export class KnowledgeAccessRepository {
  private readonly spaces: Model<KnowledgeSpaceDoc>;
  private readonly directories: Model<KnowledgeDirectoryDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly permissions: Model<KnowledgeResourcePermissionDoc>;
  private readonly collaborators: Model<KnowledgeCollaboratorDoc>;
  private readonly audits: Model<KnowledgeAuditEventDoc>;

  constructor(
    private readonly connection: Connection,
    private readonly principalDirectory?: KnowledgePrincipalDirectoryPort,
  ) {
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
        snapshotVersion: doc.aclSnapshotVersion ?? 1,
        permissionState:
          doc.permissionState ?? (doc.accessMode === 'restricted' ? 'independent' : 'inherited'),
        parentDirectoryId: null,
        parentSpaceId: doc.parentSpaceId,
        sourcePermissionEnabled: doc.sourcePermissionEnabled,
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
        snapshotVersion: doc.aclSnapshotVersion ?? 1,
        permissionState: doc.aclMode === 'override' ? 'independent' : 'inherited',
        parentDirectoryId: doc.parentDirectoryId,
        parentSpaceId: null,
        sourcePermissionEnabled: true,
      };
    }
    const doc = await this.sources.findOne({
      workspaceId: context.workspaceId,
      _id: id,
      deletedAt: null,
    });
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    if (!doc.knowledgeSpaceId) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const space = await this.spaces.findOne({
      workspaceId: context.workspaceId,
      _id: doc.knowledgeSpaceId,
      deletedAt: null,
      status: 'active',
    });
    if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return {
      resourceType,
      resourceId: id,
      workspaceId: doc.workspaceId,
      knowledgeSpaceId: doc.knowledgeSpaceId,
      ownershipMemberId: doc.ownershipMemberId,
      version: doc.version,
      permissionRevision: doc.permissionRevision,
      snapshotVersion: doc.aclSnapshotVersion ?? 1,
      permissionState: space.sourcePermissionEnabled ? doc.permissionState : 'disabled',
      parentDirectoryId: doc.directoryId,
      parentSpaceId: null,
      sourcePermissionEnabled: space.sourcePermissionEnabled,
    };
  }

  private async assertEligibleMember(memberId: string, context: TenantContext): Promise<void> {
    if (!this.principalDirectory) return;
    const eligible = await this.principalDirectory.isActiveMember(context.workspaceId, memberId);
    if (!eligible) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'memberId',
        reason: 'member_not_eligible',
      });
    }
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
    const resource = await this.assertPermission(resourceType, resourceId, 'read', context);
    if (resource.resourceType === 'source' && !resource.sourcePermissionEnabled) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'permissionState', reason: 'source_permission_disabled' },
      });
    }
    const entries =
      resource.permissionState === 'independent'
        ? await this.localEntries(resourceType, resource.resourceId, context)
        : await this.effectiveEntries(resource, context);
    return {
      resourceType,
      resourceId,
      inheritMode: resource.permissionState === 'independent' ? 'override' : 'inherit',
      permissionState: resource.permissionState,
      permissionRevision: resource.permissionRevision,
      snapshotVersion: resource.snapshotVersion,
      entries,
    };
  }

  async exportAclSnapshot(
    resourceType: AclResourceType,
    resourceId: string,
    context: TenantContext,
  ) {
    const resource = await this.resolveResource(resourceType, resourceId, context);
    if (resource.resourceType === 'source' && !resource.sourcePermissionEnabled) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'permissionState', reason: 'source_permission_disabled' },
      });
    }
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
  ): Promise<ResourceAccess & { effectivePermission: PermissionLevel }> {
    const resource = await this.resolveResource(resourceType, resourceId, context);
    if (
      context.apiKeySpaceIds?.length &&
      !context.apiKeySpaceIds.includes(String(resource.knowledgeSpaceId))
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'api_key_space_scope' },
      });
    }
    if (context.isWorkspaceOwner || resource.ownershipMemberId === context.memberId) {
      return { ...resource, effectivePermission: 'owner' };
    }
    const groupIds = membershipIds(context, 'groupIds');
    const orgIds = membershipIds(context, 'orgIds');
    const entries = await this.effectiveEntries(resource, context);
    const strongest = entries.reduce<PermissionLevel | null>((current, entry) => {
      const applies =
        (entry.principalType === 'member' && entry.principalId === context.memberId) ||
        (entry.principalType === 'group' && groupIds.has(entry.principalId)) ||
        (entry.principalType === 'org' && orgIds.has(entry.principalId)) ||
        (entry.principalType === 'workspace' && entry.principalId === context.workspaceId);
      if (!applies) return current;
      return current === null || PERMISSION_LEVEL[entry.permission] > PERMISSION_LEVEL[current]
        ? entry.permission
        : current;
    }, null);
    if (!permissionAllows(strongest, required)) {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    }
    return { ...resource, effectivePermission: strongest! };
  }

  async batchAuthorizeSources(sourceIds: readonly string[], context: TenantContext) {
    const workspaceId = requireWorkspaceId(context);
    const uniqueIds = [...new Set(sourceIds)];
    if (uniqueIds.length === 0) return [];
    const objectIds = uniqueIds.map((sourceId) => objectIdOf(sourceId, context, 'sourceIds'));
    const sourceDocuments = (await this.sources
      .find({
        workspaceId,
        _id: { $in: objectIds },
        deletedAt: null,
      })
      .lean()) as unknown as Array<Plain<KnowledgeSourceDoc>>;
    const sourceById = new Map(sourceDocuments.map((source) => [String(source._id), source]));
    const authorized = await Promise.all(
      uniqueIds.map(async (sourceId) => {
        const source = sourceById.get(sourceId);
        if (!source || !source.searchEnabled) return undefined;
        try {
          const resource = await this.assertPermission('source', sourceId, 'read', context);
          return {
            sourceId,
            knowledgeSpaceId: String(source.knowledgeSpaceId),
            permissionRevision: resource.permissionRevision,
            permissionState: resource.permissionState,
            sourceVersion: source.sourceVersion,
            sourceVersionUpdatedAt: source.updatedAt,
            searchEnabled: true,
            allowed: true as const,
          };
        } catch (error) {
          const code =
            typeof error === 'object' && error !== null && 'problem' in error
              ? (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code
              : undefined;
          if (code === 'KNOWLEDGE_NOT_FOUND') return undefined;
          throw error;
        }
      }),
    );
    return authorized.filter(
      (item): item is NonNullable<(typeof authorized)[number]> => item !== undefined,
    );
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
          apiKeyPrefix: context.apiKeyPrefix ?? null,
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
        ? { permissionState }
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
      $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
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
    if (resource.resourceType === 'source') {
      if (!resource.sourcePermissionEnabled) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'permissionState', reason: 'source_permission_disabled' },
        });
      }
      if (resource.permissionState === 'disabled') {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'permissionState', reason: 'enable_required' },
        });
      }
    }
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    if (!Array.isArray(input.entries)) throw tenantError(context);
    const entries = input.entries.map((raw) => {
      const entry = raw as Record<string, unknown>;
      const permission = entry.permission as PermissionLevel;
      const principalType = entry.principalType as AclEntry['principalType'];
      if (!['member', 'group', 'org', 'workspace'].includes(principalType)) {
        throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: 'principalType',
        });
      }
      if (!['read', 'write', 'manage', 'owner'].includes(permission)) throw tenantError(context);
      return {
        principalType,
        principalId: String(entry.principalId),
        permission,
      };
    }) as AclEntry[];
    if (input.inheritMode !== 'override' && input.inheritMode !== 'inherit') {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', { field: 'inheritMode' });
    }
    const principalKeys = entries.map((entry) => `${entry.principalType}:${entry.principalId}`);
    if (new Set(principalKeys).size !== principalKeys.length) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'entries',
        reason: 'duplicate_principal',
      });
    }
    const inheritMode = input.inheritMode;
    const permissionState = this.stateForMode(inheritMode);
    if (
      permissionState === 'independent' &&
      !entries.some(
        (entry) =>
          entry.principalType === 'member' &&
          entry.principalId === resource.ownershipMemberId &&
          entry.permission === 'owner',
      )
    ) {
      entries.unshift({
        principalType: 'member',
        principalId: resource.ownershipMemberId,
        permission: 'owner',
      });
    }
    const snapshotVersion = resource.snapshotVersion + 1;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.replaceLocalEntries(
          resource,
          permissionState === 'independent' ? entries : [],
          snapshotVersion,
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
    if (resource.resourceType === 'source' && !resource.sourcePermissionEnabled) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'permissionState', reason: 'source_permission_disabled' },
      });
    }
    const expectedVersion = Number(input.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw tenantError(context);
    if (resourceType === 'space' && !resource.parentSpaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'parentSpaceId', reason: 'no_inherited_parent' },
      });
    }
    if (resource.permissionState === 'inherited') {
      if (expectedVersion !== resource.version) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'version' },
        });
      }
      return this.getAcl(resourceType, resourceId, context);
    }
    if (resource.permissionState !== 'independent') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'permissionState', state: resource.permissionState },
      });
    }
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
    if (!resource.sourcePermissionEnabled) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'permissionState', reason: 'source_permission_disabled' },
      });
    }
    if (Number(input.expectedPermissionRevision) !== resource.permissionRevision) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_CONFLICT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'expectedPermissionRevision' },
      });
    }
    if (action === 'resume' && resource.permissionState === 'inherited') {
      if (Number(input.version) !== resource.version) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'version' },
        });
      }
      return this.getAcl('source', sourceId, context);
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
            resource.snapshotVersion + 1,
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
            $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
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
    try {
      await this.assertPermission('space', spaceId, 'manage', context);
    } catch (error) {
      try {
        await this.assertPermission('space', spaceId, 'read', context);
      } catch {
        throw error;
      }
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { required: 'manage' },
      });
    }
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
    snapshotVersion: number,
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
          snapshotVersion,
          inheritMode: 'override',
          deletedAt: null,
          updatedByMemberId: context.memberId,
        },
        $setOnInsert: { createdByMemberId: context.memberId },
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
        $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
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
    if (!memberId || !['read', 'write', 'manage'].includes(role)) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        ...(!memberId ? { field: 'memberId' } : { field: 'role' }),
      });
    }
    if (resource.ownershipMemberId === memberId) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'memberId',
        reason: 'owner_is_immutable',
      });
    }
    await this.assertEligibleMember(memberId, context);
    const session = await this.connection.startSession();
    try {
      const snapshotVersion = resource.snapshotVersion + 1;
      try {
        await session.withTransaction(async () => {
          const existing = await this.collaborators
            .findOne({
              workspaceId: context.workspaceId,
              knowledgeSpaceId: resource.knowledgeSpaceId,
              memberId,
            })
            .session(session);
          if (existing?.status === 'active' && existing.deletedAt === null) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_CONFLICT',
              requestId: context.requestId,
              traceId: context.traceId,
              details: { reason: 'duplicate_collaborator' },
            });
          }
          const now = new Date();
          if (existing) {
            await this.collaborators.updateOne(
              {
                workspaceId: context.workspaceId,
                knowledgeSpaceId: resource.knowledgeSpaceId,
                memberId,
              },
              {
                $set: {
                  role,
                  status: 'active',
                  grantedAt: now,
                  grantedByMemberId: context.memberId,
                  revokedAt: null,
                  deletedAt: null,
                  updatedByMemberId: context.memberId,
                },
                $inc: { version: 1 },
              },
              { session },
            );
          } else {
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
                  grantedAt: now,
                  grantedByMemberId: context.memberId,
                  revokedAt: null,
                },
              ],
              { session, ordered: true },
            );
          }
          await this.upsertCollaboratorPermission(
            resource,
            memberId,
            role,
            snapshotVersion,
            context,
            session,
          );
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
      } catch (error) {
        throw duplicateKeyConflict(error, context);
      }
    } finally {
      await session.endSession();
    }
    return this.getCollaborator(spaceId, memberId, context);
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
    if (resource.ownershipMemberId === memberId) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'memberId',
        reason: 'owner_is_immutable',
      });
    }
    const session = await this.connection.startSession();
    try {
      const snapshotVersion = resource.snapshotVersion + 1;
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
        await this.upsertCollaboratorPermission(
          resource,
          memberId,
          role,
          snapshotVersion,
          context,
          session,
        );
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
    if (resource.ownershipMemberId === memberId) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'memberId',
        reason: 'owner_is_immutable',
      });
    }
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
    if (!targetMemberId || !Number.isInteger(expectedVersion)) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: !targetMemberId ? 'targetMemberId' : 'version',
      });
    }
    if (targetMemberId === resource.ownershipMemberId) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'targetMemberId',
        reason: 'already_owner',
      });
    }
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const eligible = await this.collaborators
          .findOne({
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            memberId: targetMemberId,
            status: 'active',
            deletedAt: null,
            role: 'manage',
          })
          .session(session);
        if (!eligible) {
          throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
            field: 'targetMemberId',
            reason: 'member_not_eligible',
          });
        }
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
          $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
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
        const descendantDirectories =
          resourceType === 'space'
            ? await this.directories
                .find({
                  workspaceId: context.workspaceId,
                  knowledgeSpaceId: resource.knowledgeSpaceId,
                  deletedAt: null,
                })
                .select({ _id: 1, aclMode: 1 })
                .session(session)
                .lean()
            : [];
        const descendantSources =
          resourceType === 'space'
            ? await this.sources
                .find({
                  workspaceId: context.workspaceId,
                  knowledgeSpaceId: resource.knowledgeSpaceId,
                  deletedAt: null,
                })
                .select({ _id: 1, permissionState: 1 })
                .session(session)
                .lean()
            : [];
        if (resourceType === 'space') {
          await this.directories.updateMany(
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: resource.knowledgeSpaceId,
              deletedAt: null,
            },
            {
              $set: {
                ownershipMemberId: targetMemberId,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
            },
            { session },
          );
          await this.sources.updateMany(
            {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: resource.knowledgeSpaceId,
              deletedAt: null,
            },
            {
              $set: {
                ownershipMemberId: targetMemberId,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1, permissionRevision: 1, aclSnapshotVersion: 1 },
            },
            { session },
          );
        }
        const ownerResourceTypes =
          resourceType === 'space' ? ['space', 'directory', 'source'] : [resourceType];
        await this.permissions.deleteMany(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: resource.knowledgeSpaceId,
            resourceType: { $in: ownerResourceTypes },
            principalType: 'member',
            principalId: resource.ownershipMemberId,
            permission: 'owner',
          },
          { session },
        );
        const ownerTargets: Array<{
          resourceType: AclResourceType;
          resourceId: Types.ObjectId;
          snapshotVersion: number;
        }> = [
          {
            resourceType,
            resourceId: resource.resourceId,
            snapshotVersion: resource.snapshotVersion + 1,
          },
          ...descendantDirectories
            .filter((item) => item.aclMode === 'override')
            .map((item) => ({
              resourceType: 'directory' as const,
              resourceId: item._id,
              snapshotVersion: resource.snapshotVersion + 1,
            })),
          ...descendantSources
            .filter((item) => item.permissionState === 'independent')
            .map((item) => ({
              resourceType: 'source' as const,
              resourceId: item._id,
              snapshotVersion: resource.snapshotVersion + 1,
            })),
        ];
        if (ownerTargets.length > 0) {
          await this.permissions.bulkWrite(
            ownerTargets.map((target) => ({
              updateOne: {
                filter: {
                  workspaceId: context.workspaceId,
                  resourceType: target.resourceType,
                  resourceId: target.resourceId,
                  principalType: 'member',
                  principalId: targetMemberId,
                },
                update: {
                  $set: {
                    knowledgeSpaceId: resource.knowledgeSpaceId,
                    permission: 'owner',
                    inheritMode: 'override',
                    deletedAt: null,
                    updatedByMemberId: context.memberId,
                    snapshotVersion: target.snapshotVersion,
                  },
                  $setOnInsert: {
                    createdByMemberId: context.memberId,
                  },
                  $inc: { version: 1 },
                },
                upsert: true,
              },
            })),
            { session },
          );
        }
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
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: String(resource.knowledgeSpaceId),
            eventType: 'permission.ownership.transfer',
            aggregateType: resourceType,
            aggregateId: resourceId,
            queue: 'knowledge-index',
            payload: {
              resourceType,
              resourceId,
              fromMemberId: resource.ownershipMemberId,
              toMemberId: targetMemberId,
              permissionRevision: resource.permissionRevision + 1,
            },
          },
          context,
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }
}
