import { createKnowledgeError } from '@kb/contracts';
import type { Types, Connection, Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type {
  KnowledgeTagDoc,
  KnowledgeTagValueDoc,
} from '../../../shared/persistence/schemas/knowledge-taxonomy.schemas';
import { workspaceCasUpdate } from '../../../shared/persistence/knowledge/cas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { assertResourceName } from '../domain/hierarchy';

type Plain<T> = T & { _id: Types.ObjectId };
type TagType = KnowledgeTagDoc['tagType'];

function tagDto(document: Plain<KnowledgeTagDoc>) {
  return {
    id: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    key: document.key,
    label: document.label,
    tagType: document.tagType,
    options: document.options,
    required: document.required,
    status: document.status,
    version: document.version,
  };
}

function normalizedValue(value: unknown, type: TagType, context: TenantContext): unknown {
  if (value === null) return null;
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw tenantError(context);
    return value;
  }
  if (type === 'datetime') {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Date.parse(value)
          : Number.NaN;
    if (!Number.isFinite(parsed)) throw tenantError(context);
    return parsed;
  }
  if (type === 'array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw tenantError(context);
    }
    return [...new Set(value)].sort();
  }
  if (typeof value !== 'string') throw tenantError(context);
  return value;
}

function valueKey(value: unknown): string {
  return Array.isArray(value) ? value.join('\u0000') : String(value);
}

function validateOptions(value: unknown, options: string[] | null, context: TenantContext): void {
  if (options === null) return;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string' || !options.includes(item))) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'value', reason: 'option_not_allowed' },
    });
  }
}

export class KnowledgeTagRepository {
  private readonly tags: Model<KnowledgeTagDoc>;
  private readonly tagValues: Model<KnowledgeTagValueDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.tags = models.KnowledgeTag as Model<KnowledgeTagDoc>;
    this.tagValues = models.KnowledgeTagValue as Model<KnowledgeTagValueDoc>;
    this.sources = models.KnowledgeSource as Model<KnowledgeSourceDoc>;
  }

  async list(spaceId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const docs = (await this.tags
      .find({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
        deletedAt: null,
      })
      .sort({ label: 1, _id: 1 })
      .lean()) as unknown as Plain<KnowledgeTagDoc>[];
    return { items: docs.map(tagDto) };
  }

  async create(spaceId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    const label = assertResourceName(input.label, 'label', 80, context);
    const tagType = input.tagType as TagType;
    if (!['string', 'number', 'datetime', 'array'].includes(tagType)) {
      throw tenantError(context);
    }
    if ((tagType === 'string' || tagType === 'array') && !Array.isArray(input.options)) {
      throw tenantError(context);
    }
    const options = Array.isArray(input.options) ? [...new Set(input.options.map(String))] : null;
    if (options && options.length > 1000) throw tenantError(context);
    const created = await this.tags.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      key: String(input.key),
      label,
      tagType,
      options,
      required: Boolean(input.required),
      status: 'active',
    });
    return tagDto(created as unknown as Plain<KnowledgeTagDoc>);
  }

  async get(tagId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const doc = (await this.tags
      .findOne({
        workspaceId: context.workspaceId,
        deletedAt: null,
        _id: objectIdOf(tagId, context, 'tagId'),
      })
      .lean()) as unknown as Plain<KnowledgeTagDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    return tagDto(doc);
  }

  async update(tagId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    const version = Number(input.version);
    const update: Record<string, unknown> = {};
    if (input.label !== undefined) {
      update.label = assertResourceName(input.label, 'label', 80, context);
    }
    if (input.required !== undefined) update.required = Boolean(input.required);
    if (input.options !== undefined) {
      update.options = Array.isArray(input.options)
        ? [...new Set(input.options.map(String))]
        : null;
    }
    if (input.status !== undefined) update.status = input.status;
    const updated = await workspaceCasUpdate(
      this.tags,
      { id: tagId, expectedVersion: version, update },
      context,
    );
    return tagDto(updated as unknown as Plain<KnowledgeTagDoc>);
  }

  async delete(tagId: string, context: TenantContext): Promise<void> {
    requireWorkspaceId(context);
    const tagObjectId = objectIdOf(tagId, context, 'tagId');
    const tag = await this.tags.findOne({
      _id: tagObjectId,
      workspaceId: context.workspaceId,
      deletedAt: null,
    });
    if (!tag) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        await this.tags.updateOne(
          { _id: tagObjectId, workspaceId: context.workspaceId, deletedAt: null },
          {
            $set: { deletedAt: now, updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.tagValues.updateMany(
          { workspaceId: context.workspaceId, tagId: tagObjectId, deletedAt: null },
          {
            $set: { deletedAt: now, updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.sources.updateMany(
          {
            workspaceId: context.workspaceId,
            'tagValues.tagId': tagObjectId,
            deletedAt: null,
          },
          {
            $pull: { tagValues: { tagId: tagObjectId } },
            $set: { updatedByMemberId: context.memberId },
            $inc: { version: 1 },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async updateOptions(tagId: string, input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    if (!Array.isArray(input.options)) throw tenantError(context);
    const options = [...new Set(input.options.map(String))];
    const updated = await workspaceCasUpdate(
      this.tags,
      {
        id: tagId,
        expectedVersion: Number(input.version),
        update: { options },
      },
      context,
    );
    return tagDto(updated as unknown as Plain<KnowledgeTagDoc>);
  }

  async apply(input: Record<string, unknown>, context: TenantContext) {
    requireWorkspaceId(context);
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200) {
      throw tenantError(context);
    }
    const session = await this.connection.startSession();
    const results: Array<{ sourceId: string; tagId: string; valueKey: string | null }> = [];
    try {
      await session.withTransaction(async () => {
        for (const item of input.items as Array<Record<string, unknown>>) {
          const sourceId = String(item.sourceId ?? '');
          const tagId = String(item.tagId ?? '');
          const source = await this.sources
            .findOne({
              _id: objectIdOf(sourceId, context, 'sourceId'),
              workspaceId: context.workspaceId,
              deletedAt: null,
            })
            .session(session);
          const tag = await this.tags
            .findOne({
              _id: objectIdOf(tagId, context, 'tagId'),
              workspaceId: context.workspaceId,
              deletedAt: null,
              status: 'active',
            })
            .session(session);
          if (!source || !tag) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
          if (String(source.knowledgeSpaceId) !== String(tag.knowledgeSpaceId)) {
            throw tenantError(context);
          }
          if (item.value === null || item.value === undefined) {
            await this.tagValues.updateMany(
              {
                workspaceId: context.workspaceId,
                tagId: tag._id,
                sourceId: source._id,
                deletedAt: null,
              },
              {
                $set: { deletedAt: new Date(), updatedByMemberId: context.memberId },
                $inc: { version: 1 },
              },
              { session },
            );
            await this.sources.updateOne(
              { _id: source._id, workspaceId: context.workspaceId, version: source.version },
              {
                $pull: { tagValues: { tagId: tag._id } },
                $set: { updatedByMemberId: context.memberId },
                $inc: { version: 1 },
              },
              { session },
            );
            results.push({ sourceId, tagId, valueKey: null });
            continue;
          }
          let value: unknown;
          try {
            value = normalizedValue(item.value, tag.tagType, context);
          } catch {
            throw tenantError(context);
          }
          validateOptions(value, tag.options, context);
          const key = valueKey(value);
          const existing = await this.tagValues
            .findOne({
              workspaceId: context.workspaceId,
              tagId: tag._id,
              sourceId: source._id,
              deletedAt: null,
            })
            .session(session);
          if (existing) {
            await this.tagValues.updateOne(
              { _id: existing._id, workspaceId: context.workspaceId, version: existing.version },
              {
                $set: {
                  value,
                  valueType: tag.tagType,
                  valueKey: key,
                  sourceVersion: source.sourceVersion,
                  updatedByMemberId: context.memberId,
                },
                $inc: { version: 1 },
              },
              { session },
            );
          } else {
            await this.tagValues.create(
              [
                {
                  workspaceId: context.workspaceId,
                  knowledgeSpaceId: source.knowledgeSpaceId,
                  version: 1,
                  deletedAt: null,
                  createdByMemberId: context.memberId,
                  updatedByMemberId: context.memberId,
                  tagId: tag._id,
                  sourceId: source._id,
                  value,
                  valueType: tag.tagType,
                  valueKey: key,
                  sourceVersion: source.sourceVersion,
                },
              ],
              { session },
            );
          }
          const snapshot = { tagId: tag._id, valueKey: key, value };
          await this.sources.updateOne(
            { _id: source._id, workspaceId: context.workspaceId, version: source.version },
            {
              $pull: { tagValues: { tagId: tag._id } },
              $set: { updatedByMemberId: context.memberId },
              $inc: { version: 1 },
            },
            { session },
          );
          await this.sources.updateOne(
            { _id: source._id, workspaceId: context.workspaceId },
            { $push: { tagValues: snapshot } },
            { session },
          );
          results.push({ sourceId, tagId, valueKey: key });
        }
      });
      return {
        requested: (input.items as unknown[]).length,
        succeeded: results.length,
        failed: 0,
        items: results.map((result) => ({
          id: result.sourceId,
          success: true,
        })),
      };
    } finally {
      await session.endSession();
    }
  }
}
