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
import type { TagApplyResult } from '../application/ports';

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

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function knowledgeErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
  ) {
    return String((error as { problem: { error: { code: string } } }).problem.error.code);
  }
  return null;
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
    let created: Plain<KnowledgeTagDoc>;
    try {
      created = (await this.tags.create({
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
      })) as unknown as Plain<KnowledgeTagDoc>;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_CONFLICT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { field: 'key', reason: 'duplicate_tag_key', key: String(input.key) },
        });
      }
      throw error;
    }
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

  async apply(input: Record<string, unknown>, context: TenantContext): Promise<TagApplyResult> {
    requireWorkspaceId(context);
    const items = Array.isArray(input.items)
      ? input.items.map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            sourceId: String(item.sourceId ?? ''),
            tagId: String(item.tagId ?? ''),
            value: item.value,
          };
        })
      : [];
    if (items.length < 1 || items.length > 200) throw tenantError(context);
    const pairKeys = items.map((item) => `${item.sourceId}:${item.tagId}`);
    if (new Set(pairKeys).size !== pairKeys.length) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'items',
        reason: 'duplicate_source_tag_pair',
      });
    }
    const sourceIds = [...new Set(items.map((item) => item.sourceId))].sort();
    const rawVersions =
      typeof input.sourceVersions === 'object' &&
      input.sourceVersions !== null &&
      !Array.isArray(input.sourceVersions)
        ? (input.sourceVersions as Record<string, unknown>)
        : null;
    if (
      !rawVersions ||
      Object.keys(rawVersions).length !== sourceIds.length ||
      sourceIds.some((sourceId) => !Object.hasOwn(rawVersions, sourceId))
    ) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'sourceVersions',
        reason: 'exact_item_versions_required',
      });
    }
    const sourceVersions: Record<string, number> = {};
    for (const sourceId of sourceIds) {
      const expectedVersion = Number(rawVersions[sourceId]);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: `sourceVersions.${sourceId}`,
          reason: 'positive_integer_required',
        });
      }
      sourceVersions[sourceId] = expectedVersion;
    }

    const results: Array<{
      id: string;
      tagId: string;
      success: boolean;
      code?: string;
    }> = items.map((item) => ({
      id: item.sourceId,
      tagId: item.tagId,
      success: false,
    }));
    const indexedBySource = new Map<string, number[]>();
    for (const [index, item] of items.entries()) {
      indexedBySource.set(item.sourceId, [...(indexedBySource.get(item.sourceId) ?? []), index]);
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const sourceId of sourceIds) {
          const itemIndexes = indexedBySource.get(sourceId) ?? [];
          const expectedVersion = sourceVersions[sourceId]!;
          const source = await this.sources
            .findOne({
              _id: objectIdOf(sourceId, context, 'sourceId'),
              workspaceId: context.workspaceId,
              deletedAt: null,
            })
            .session(session);
          if (!source) {
            for (const index of itemIndexes) {
              results[index] = {
                ...results[index]!,
                code: 'KNOWLEDGE_NOT_FOUND',
              };
            }
            continue;
          }
          if (source.version !== expectedVersion) {
            for (const index of itemIndexes) {
              results[index] = {
                ...results[index]!,
                code: 'KNOWLEDGE_CONFLICT',
              };
            }
            continue;
          }

          let sourceTagValues = [...source.tagValues];
          let sourceSucceeded = false;
          for (const index of itemIndexes) {
            const item = items[index]!;
            try {
              const tag = await this.tags
                .findOne({
                  _id: objectIdOf(item.tagId, context, 'tagId'),
                  workspaceId: context.workspaceId,
                  deletedAt: null,
                  status: 'active',
                })
                .session(session);
              if (!tag) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
              if (String(source.knowledgeSpaceId) !== String(tag.knowledgeSpaceId)) {
                throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
                  field: 'tagId',
                  reason: 'cross_space_reference',
                });
              }
              if (item.value === null || item.value === undefined) {
                if (tag.required) {
                  throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
                    tagId: item.tagId,
                    reason: 'required_tag_cannot_be_removed',
                  });
                }
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
                sourceTagValues = sourceTagValues.filter(
                  (entry) => String(entry.tagId) !== String(tag._id),
                );
              } else {
                const value = normalizedValue(item.value, tag.tagType, context);
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
                    {
                      _id: existing._id,
                      workspaceId: context.workspaceId,
                      version: existing.version,
                    },
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
                sourceTagValues = sourceTagValues.filter(
                  (entry) => String(entry.tagId) !== String(tag._id),
                );
                sourceTagValues.push({ tagId: tag._id, valueKey: key, value });
              }
              results[index] = { ...results[index]!, success: true };
              sourceSucceeded = true;
            } catch (error) {
              const code = knowledgeErrorCode(error);
              if (!code) throw error;
              results[index] = { ...results[index]!, code };
            }
          }
          if (sourceSucceeded) {
            const updated = await this.sources.updateOne(
              {
                _id: source._id,
                workspaceId: context.workspaceId,
                version: expectedVersion,
                deletedAt: null,
              },
              {
                $set: {
                  tagValues: sourceTagValues,
                  updatedByMemberId: context.memberId,
                },
                $inc: { version: 1 },
              },
              { session },
            );
            if (updated.modifiedCount !== 1) {
              throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
                sourceId,
                expectedVersion,
              });
            }
          }
        }
      });
      const succeeded = results.filter((result) => result.success).length;
      const failed = results.length - succeeded;
      return {
        requested: results.length,
        succeeded,
        failed,
        ...(failed > 0 ? { code: 'KNOWLEDGE_PARTIAL_SUCCESS' } : {}),
        items: results,
      };
    } finally {
      await session.endSession();
    }
  }
}
