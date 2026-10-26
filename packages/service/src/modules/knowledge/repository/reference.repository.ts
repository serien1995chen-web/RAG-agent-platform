import { createKnowledgeError } from '@kb/contracts';
import { Types, type ClientSession, type Connection } from 'mongoose';
import type { ReferenceEventPort, ReferencePort, ReferenceView } from '../application/ports';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeReferenceBindingDoc } from '../../../shared/persistence/schemas/knowledge-access.schemas';

type Plain<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

function referenceDto(document: Plain<KnowledgeReferenceBindingDoc>): ReferenceView {
  return {
    referrerType: document.referrerType,
    referrerId: document.referrerId,
    referrerVersion: document.referrerVersion,
    referrerName: document.referrerName,
    status: document.status,
    lastSeenAt: document.lastSeenAt.toISOString(),
  };
}

function conflict(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

export class KnowledgeReferenceRepository implements ReferencePort, ReferenceEventPort {
  private readonly models;
  private readonly audit: KnowledgeAuditRepository;

  constructor(private readonly connection: Connection) {
    this.models = registerKnowledgeModels(connection);
    this.audit = new KnowledgeAuditRepository(connection);
  }

  private async activeSpace(spaceId: string, context: TenantContext) {
    const id = objectIdOf(spaceId, context, 'spaceId');
    const space = await this.models.KnowledgeSpace.findOne({
      _id: id,
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
      status: 'active',
    });
    if (!space) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return space;
  }

  private async bumpSpace(
    space: { _id: Types.ObjectId; workspaceId: string; version: number },
    context: TenantContext,
    session: ClientSession,
  ): Promise<number> {
    const updated = await this.models.KnowledgeSpace.findOneAndUpdate(
      {
        _id: space._id,
        workspaceId: space.workspaceId,
        version: space.version,
        deletedAt: null,
        status: 'active',
      },
      {
        $set: { updatedByMemberId: context.memberId },
        $inc: { version: 1, referenceRevision: 1 },
      },
      { new: true, session },
    );
    if (!updated) throw conflict(context, { field: 'referenceRevision' });
    return updated.referenceRevision;
  }

  async list(spaceId: string, context: TenantContext) {
    const space = await this.activeSpace(spaceId, context);
    const now = new Date();
    const docs = (await this.models.KnowledgeReferenceBinding.find({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: space._id,
      deletedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
      .sort({ lastSeenAt: -1, referrerId: 1, referrerVersion: 1 })
      .lean()) as unknown as Plain<KnowledgeReferenceBindingDoc>[];
    const items = docs.map(referenceDto);
    return {
      referenceRevision: space.referenceRevision,
      count: items.length,
      items,
    };
  }

  async applyUpsert(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      referrerName: string;
      registryRevision: number;
    },
    context: TenantContext,
  ) {
    if (!Number.isInteger(input.registryRevision) || input.registryRevision < 1) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'registryRevision',
      });
    }
    return withMongoTransaction(this.connection, async (session) => {
      const space = await this.activeSpace(input.spaceId, context);
      const exact = await this.models.KnowledgeReferenceBinding.findOne({
        workspaceId: context.workspaceId,
        resourceType: 'space',
        resourceId: space._id,
        referrerType: input.referrerType,
        referrerId: input.referrerId,
        referrerVersion: input.referrerVersion,
      }).session(session);
      if (exact && exact.registryRevision > input.registryRevision) {
        throw conflict(context, { field: 'registryRevision' });
      }
      if (exact && exact.registryRevision === input.registryRevision && exact.status === 'active') {
        return {
          referenceRevision: space.referenceRevision,
          item: referenceDto(exact.toObject() as unknown as Plain<KnowledgeReferenceBindingDoc>),
        };
      }
      if (exact && exact.registryRevision === input.registryRevision) {
        throw conflict(context, { field: 'registryRevision', reason: 'state_mismatch' });
      }

      const now = new Date();
      await this.models.KnowledgeReferenceBinding.updateMany(
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: space._id,
          referrerType: input.referrerType,
          referrerId: input.referrerId,
          status: 'active',
          _id: { $ne: exact?._id ?? new Types.ObjectId() },
          deletedAt: null,
        },
        {
          $set: {
            status: 'stale',
            expiresAt: new Date(now.getTime() + 30 * 86_400_000),
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      const item = exact
        ? await this.models.KnowledgeReferenceBinding.findOneAndUpdate(
            {
              _id: exact._id,
              workspaceId: context.workspaceId,
              version: exact.version,
            },
            {
              $set: {
                referrerName: input.referrerName,
                status: 'active',
                registryRevision: input.registryRevision,
                lastSeenAt: now,
                expiresAt: null,
                deletedAt: null,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
        : await this.models.KnowledgeReferenceBinding.create(
            [
              {
                workspaceId: context.workspaceId,
                knowledgeSpaceId: space._id,
                resourceType: 'space',
                resourceId: space._id,
                referrerType: input.referrerType,
                referrerId: input.referrerId,
                referrerVersion: input.referrerVersion,
                referrerName: input.referrerName,
                status: 'active',
                registryRevision: input.registryRevision,
                lastSeenAt: now,
                expiresAt: null,
                version: 1,
                deletedAt: null,
                createdByMemberId: context.memberId,
                updatedByMemberId: context.memberId,
              },
            ],
            { session },
          ).then((created) => created[0]);
      if (!item) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      const referenceRevision = await this.bumpSpace(space, context, session);
      await this.audit.append(
        {
          knowledgeSpaceId: input.spaceId,
          action: 'reference.upsert',
          resourceType: 'space',
          resourceId: input.spaceId,
          outcome: 'succeeded',
          safeDiff: {
            referrerType: input.referrerType,
            referrerId: input.referrerId,
            referrerVersion: input.referrerVersion,
            registryRevision: input.registryRevision,
            referenceRevision,
          },
        },
        context,
        session,
      );
      return {
        referenceRevision,
        item: referenceDto(item.toObject() as unknown as Plain<KnowledgeReferenceBindingDoc>),
      };
    });
  }

  async applyRemove(
    input: {
      spaceId: string;
      referrerType: 'app' | 'workflow';
      referrerId: string;
      referrerVersion: string;
      registryRevision: number;
    },
    context: TenantContext,
  ) {
    return withMongoTransaction(this.connection, async (session) => {
      const space = await this.activeSpace(input.spaceId, context);
      const exact = await this.models.KnowledgeReferenceBinding.findOne({
        workspaceId: context.workspaceId,
        resourceType: 'space',
        resourceId: space._id,
        referrerType: input.referrerType,
        referrerId: input.referrerId,
        referrerVersion: input.referrerVersion,
        deletedAt: null,
      }).session(session);
      if (!exact) {
        throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: 'referrerVersion',
          reason: 'unregistered_reference',
        });
      }
      if (exact.registryRevision > input.registryRevision) {
        throw conflict(context, { field: 'registryRevision' });
      }
      if (exact.registryRevision === input.registryRevision && exact.status === 'removed') {
        return {
          referenceRevision: space.referenceRevision,
          item: referenceDto(exact.toObject() as unknown as Plain<KnowledgeReferenceBindingDoc>),
        };
      }
      if (exact.registryRevision === input.registryRevision) {
        throw conflict(context, { field: 'registryRevision', reason: 'state_mismatch' });
      }
      const now = new Date();
      const item = await this.models.KnowledgeReferenceBinding.findOneAndUpdate(
        {
          _id: exact._id,
          workspaceId: context.workspaceId,
          version: exact.version,
        },
        {
          $set: {
            status: 'removed',
            registryRevision: input.registryRevision,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + 30 * 86_400_000),
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!item) throw conflict(context, { resourceId: input.spaceId });
      const referenceRevision = await this.bumpSpace(space, context, session);
      await this.audit.append(
        {
          knowledgeSpaceId: input.spaceId,
          action: 'reference.remove',
          resourceType: 'space',
          resourceId: input.spaceId,
          outcome: 'succeeded',
          safeDiff: {
            referrerType: input.referrerType,
            referrerId: input.referrerId,
            referrerVersion: input.referrerVersion,
            registryRevision: input.registryRevision,
            referenceRevision,
          },
        },
        context,
        session,
      );
      return {
        referenceRevision,
        item: referenceDto(item.toObject() as unknown as Plain<KnowledgeReferenceBindingDoc>),
      };
    });
  }
}
