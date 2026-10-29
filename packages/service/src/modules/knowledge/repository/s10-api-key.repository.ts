import { createKnowledgeError } from '@kb/contracts';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import type { S10ApiKeyRepositoryPort } from '../application/s10-operations.ports';
import type { S10ApiKeyAuthRecord, S10ApiKeyRecord } from '../domain/s10-api-key';
import { effectiveApiKeyStatus, rotateApiKeyState } from '../domain/s10-api-key';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeApiKeyDoc } from '../../../shared/persistence/schemas/knowledge-access.schemas';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { cursorFilter, decodeCursor, encodeCursor, parseLimit, parseSort } from './pagination';

type PlainKey = KnowledgeApiKeyDoc & { _id: Types.ObjectId };

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function keyView(document: PlainKey): S10ApiKeyRecord {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    name: document.name,
    keyPrefix: document.keyPrefix,
    scopes: document.scopes as S10ApiKeyRecord['scopes'],
    spaceIds: document.spaceIds.map(String),
    status: effectiveApiKeyStatus({
      status: document.status,
      expiresAt: document.expiresAt,
      retireAt: document.retireAt,
    }),
    expiresAt: iso(document.expiresAt),
    retireAt: iso(document.retireAt),
    lastUsedAt: iso(document.lastUsedAt),
    rotatedFromKeyId: document.rotatedFromKeyId ? String(document.rotatedFromKeyId) : null,
    rotatedToKeyId: document.rotatedToKeyId ? String(document.rotatedToKeyId) : null,
    rotatedAt: iso(document.rotatedAt),
    version: document.version,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function authView(document: PlainKey & { secretHash: string }): S10ApiKeyAuthRecord {
  return {
    ...keyView(document),
    secretHash: document.secretHash,
  };
}

export class S10ApiKeyRepository implements S10ApiKeyRepositoryPort {
  private readonly keys: Model<KnowledgeApiKeyDoc>;
  private readonly spaces: Model<Record<string, unknown>>;
  private readonly audits: KnowledgeAuditRepository;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.keys = models.KnowledgeApiKey;
    this.spaces = models.KnowledgeSpace as unknown as Model<Record<string, unknown>>;
    this.audits = new KnowledgeAuditRepository(connection);
  }

  private async validateSpaces(
    spaceIds: readonly string[],
    context: TenantContext,
  ): Promise<Types.ObjectId[]> {
    if (spaceIds.length === 0) return [];
    const ids = spaceIds.map((id) => objectIdOf(id, context, 'spaceIds'));
    if (new Set(ids.map(String)).size !== spaceIds.length) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'spaceIds',
        reason: 'duplicate',
      });
    }
    const count = await this.spaces.countDocuments({
      workspaceId: requireWorkspaceId(context),
      _id: { $in: ids },
      deletedAt: null,
      status: 'active',
    });
    if (count !== ids.length) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return ids;
  }

  private async audit(
    action: string,
    keyId: string,
    outcome: 'allowed' | 'denied' | 'succeeded' | 'failed',
    context: TenantContext,
    session: ClientSession,
    safeDiff: Record<string, unknown>,
  ): Promise<void> {
    await this.audits.append(
      {
        knowledgeSpaceId: null,
        action,
        resourceType: 'api_key',
        resourceId: keyId,
        outcome,
        safeDiff,
      },
      context,
      session,
    );
  }

  async list(
    query: { cursor?: string; limit?: number; sort?: string },
    context: TenantContext,
  ): Promise<{
    items: S10ApiKeyRecord[];
    pageInfo: { nextCursor: string | null; hasMore: boolean };
  }> {
    const sort = parseSort(query.sort, context);
    const limit = parseLimit(query.limit, context);
    const cursor = decodeCursor(query.cursor, context);
    const documents = (await this.keys
      .find({
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
        ...cursorFilter(sort, cursor),
      })
      .sort({ [sort.field]: sort.direction, _id: sort.direction })
      .limit(limit + 1)
      .lean()) as unknown as PlainKey[];
    const hasMore = documents.length > limit;
    const page = hasMore ? documents.slice(0, limit) : documents;
    const last = page.at(-1);
    return {
      items: page.map(keyView),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor(sort, last as unknown as Record<string, unknown> & { _id: unknown })
            : null,
      },
    };
  }

  async create(
    input: {
      name: string;
      scopes: S10ApiKeyRecord['scopes'];
      spaceIds: string[];
      expiresAt: Date | null;
    },
    secret: { secretHash: string; keyPrefix: string },
    context: TenantContext,
  ): Promise<S10ApiKeyRecord> {
    const workspaceId = requireWorkspaceId(context);
    const spaceIds = await this.validateSpaces(input.spaceIds, context);
    return withMongoTransaction(this.connection, async (session) => {
      const [created] = await this.keys.create(
        [
          {
            workspaceId,
            knowledgeSpaceId: null,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            name: input.name,
            keyPrefix: secret.keyPrefix,
            secretHash: secret.secretHash,
            scopes: input.scopes,
            spaceIds,
            status: 'active',
            expiresAt: input.expiresAt,
            lastUsedAt: null,
            rotatedFromKeyId: null,
            rotatedToKeyId: null,
            rotatedAt: null,
            retireAt: null,
          },
        ],
        { session },
      );
      if (!created) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'api_key_create_failed' },
        });
      }
      await this.audit('api_key.create', String(created._id), 'succeeded', context, session, {
        keyPrefix: secret.keyPrefix,
        scopes: input.scopes,
        spaceIds: input.spaceIds,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      });
      return keyView(created.toObject() as PlainKey);
    });
  }

  private async documentForMutation(
    keyId: string,
    expectedVersion: number,
    context: TenantContext,
  ): Promise<PlainKey> {
    const document = (await this.keys
      .findOne({
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(keyId, context, 'keyId'),
        deletedAt: null,
      })
      .lean()) as unknown as PlainKey | null;
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    if (document.version !== expectedVersion) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        expectedVersion,
        actualVersion: document.version,
      });
    }
    return document;
  }

  private async revokeChain(
    document: PlainKey,
    context: TenantContext,
    session: ClientSession,
  ): Promise<void> {
    const ids = [document._id];
    let previous = document.rotatedFromKeyId;
    for (let depth = 0; previous && depth < 64; depth += 1) {
      const ancestor = (await this.keys
        .findOne({
          workspaceId: document.workspaceId,
          _id: previous,
          deletedAt: null,
        })
        .select({ _id: 1, rotatedFromKeyId: 1 })
        .lean()) as unknown as {
        _id: Types.ObjectId;
        rotatedFromKeyId: Types.ObjectId | null;
      } | null;
      if (!ancestor) break;
      ids.push(ancestor._id);
      previous = ancestor.rotatedFromKeyId;
    }
    const now = new Date();
    await this.keys.updateMany(
      {
        workspaceId: document.workspaceId,
        _id: { $in: ids },
        deletedAt: null,
      },
      {
        $set: {
          status: 'revoked',
          retireAt: now,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    await this.audit('api_key.revoke', String(document._id), 'succeeded', context, session, {
      chainLength: ids.length,
    });
  }

  async update(
    keyId: string,
    input: {
      name?: string;
      scopes?: S10ApiKeyRecord['scopes'];
      spaceIds?: string[];
      status?: 'active' | 'revoked';
      version: number;
    },
    context: TenantContext,
  ): Promise<S10ApiKeyRecord> {
    const spaceIds =
      input.spaceIds === undefined ? undefined : await this.validateSpaces(input.spaceIds, context);
    return withMongoTransaction(this.connection, async (session) => {
      let current = await this.documentForMutation(keyId, input.version, context);
      if (input.status === 'active' && current.status !== 'active') {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          reason: 'non_active_key_cannot_be_reactivated',
        });
      }
      let expectedVersion = input.version;
      const update: Record<string, unknown> = {
        updatedByMemberId: context.memberId,
      };
      if (input.name !== undefined) update.name = input.name;
      if (input.scopes !== undefined) update.scopes = input.scopes;
      if (spaceIds !== undefined) update.spaceIds = spaceIds;
      if (Object.keys(update).length > 1) {
        const result = await this.keys.findOneAndUpdate(
          {
            workspaceId: current.workspaceId,
            _id: current._id,
            version: expectedVersion,
            deletedAt: null,
          },
          { $set: update, $inc: { version: 1 } },
          { new: true, session },
        );
        if (!result) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
        expectedVersion += 1;
        current = result.toObject() as PlainKey;
        await this.audit('api_key.update', keyId, 'succeeded', context, session, {
          fields: Object.keys(update).filter((field) => field !== 'updatedByMemberId'),
          version: expectedVersion,
        });
      }
      if (input.status === 'revoked' && current.status !== 'revoked') {
        await this.revokeChain(current, context, session);
      }
      const refreshed = await this.keys
        .findOne({ workspaceId: current.workspaceId, _id: current._id, deletedAt: null })
        .session(session)
        .lean();
      if (!refreshed) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      return keyView(refreshed as unknown as PlainKey);
    });
  }

  async revoke(keyId: string, expectedVersion: number, context: TenantContext): Promise<void> {
    await withMongoTransaction(this.connection, async (session) => {
      const current = await this.documentForMutation(keyId, expectedVersion, context);
      if (current.status !== 'revoked') await this.revokeChain(current, context, session);
    });
  }

  async rotate(
    keyId: string,
    expectedVersion: number,
    secret: { secretHash: string; keyPrefix: string },
    context: TenantContext,
  ): Promise<S10ApiKeyRecord> {
    return withMongoTransaction(this.connection, async (session) => {
      const current = await this.documentForMutation(keyId, expectedVersion, context);
      if (current.status !== 'active') {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          reason: 'only_active_key_can_rotate',
          status: current.status,
        });
      }
      const now = new Date();
      const { retireAt } = rotateApiKeyState(current, now);
      const [successor] = await this.keys.create(
        [
          {
            workspaceId: current.workspaceId,
            knowledgeSpaceId: current.knowledgeSpaceId,
            version: 1,
            deletedAt: null,
            createdByMemberId: context.memberId,
            updatedByMemberId: context.memberId,
            name: current.name,
            keyPrefix: secret.keyPrefix,
            secretHash: secret.secretHash,
            scopes: current.scopes,
            spaceIds: current.spaceIds,
            status: 'active',
            expiresAt: current.expiresAt,
            lastUsedAt: null,
            rotatedFromKeyId: current._id,
            rotatedToKeyId: null,
            rotatedAt: null,
            retireAt: null,
          },
        ],
        { session },
      );
      if (!successor) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'api_key_rotate_create_failed' },
        });
      }
      const result = await this.keys.updateOne(
        {
          workspaceId: current.workspaceId,
          _id: current._id,
          version: expectedVersion,
          deletedAt: null,
        },
        {
          $set: {
            status: 'rotated',
            rotatedToKeyId: successor._id,
            rotatedAt: now,
            retireAt,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (result.modifiedCount !== 1) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
      await this.audit('api_key.rotate', String(current._id), 'succeeded', context, session, {
        successorKeyId: String(successor._id),
        retireAt: retireAt.toISOString(),
      });
      return keyView(successor.toObject() as PlainKey);
    });
  }

  async findForAuthentication(
    workspaceId: string,
    prefix: string,
    context: TenantContext,
  ): Promise<S10ApiKeyAuthRecord | null> {
    if (workspaceId !== requireWorkspaceId(context)) return null;
    const document = (await this.keys
      .findOne({
        workspaceId,
        keyPrefix: prefix,
        deletedAt: null,
        status: { $in: ['active', 'rotated'] },
      })
      .select('+secretHash')
      .lean()) as unknown as (PlainKey & { secretHash: string }) | null;
    return document ? authView(document) : null;
  }

  async markUsed(keyId: string, now: Date, context: TenantContext): Promise<void> {
    await this.keys.updateOne(
      {
        workspaceId: requireWorkspaceId(context),
        _id: objectIdOf(keyId, context, 'keyId'),
        deletedAt: null,
        $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: new Date(now.getTime() - 60_000) } }],
      },
      {
        $set: { lastUsedAt: now, updatedByMemberId: context.memberId },
      },
    );
  }
}
