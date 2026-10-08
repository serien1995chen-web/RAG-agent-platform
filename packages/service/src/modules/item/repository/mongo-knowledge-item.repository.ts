import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../../ports/types';
import type { KnowledgeItemSnapshot, PageResult } from '../../../ports/types';
import {
  DatasetDataSchema,
  type DataHistoryEntryValue,
  type DatasetDataDoc,
  type KnowledgeItemIndexValue as StoredIndexValue,
} from '../../../shared/persistence/schemas';
import type { KnowledgeItemQueryRepository } from '../domain';
import { buildQaDedupKey } from '../domain/dedup-key';

function toOid(value: string, field: string, requestId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId,
        params: { resourceType: field, resourceId: value },
      }),
    );
  }
  return new Types.ObjectId(value);
}

function duplicateError(
  dedupKey: string,
  datasetId: string,
  collectionId: string,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501003,
      requestId,
      params: { dedupKey, datasetId, collectionId },
    }),
  );
}

function versionConflict(
  dataId: string,
  expectedVersion: number,
  actualVersion: number,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501067,
      requestId,
      params: {
        resourceType: 'data',
        resourceId: dataId,
        expectedVersion,
        actualVersion,
      },
    }),
  );
}

function toStoredIndexes(indexes: KnowledgeItemSnapshot['indexes']): StoredIndexValue[] {
  return indexes.map((index) => ({
    type: index.type,
    dataId: index.dataId ?? null,
    text: index.text,
  }));
}

function toPortIndexes(indexes: StoredIndexValue[]): KnowledgeItemSnapshot['indexes'] {
  return indexes.map((index) => ({
    indexId: `${index.type}:${index.dataId ?? ''}:${index.text}`,
    type: index.type,
    dataId: index.dataId ?? '',
    text: index.text,
  }));
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export class MongoKnowledgeItemRepository implements KnowledgeItemQueryRepository {
  private readonly model: Model<DatasetDataDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetData as Model<DatasetDataDoc>) ??
      connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private toSnapshot(doc: DatasetDataDoc & { _id: Types.ObjectId }): KnowledgeItemSnapshot {
    return {
      dataId: String(doc._id),
      teamId: String(doc.teamId),
      datasetId: String(doc.datasetId),
      collectionId: String(doc.collectionId),
      ...(doc.q !== null ? { q: doc.q } : {}),
      a: doc.a,
      ...(doc.imageId !== null ? { imageId: doc.imageId } : {}),
      chunkIndex: doc.chunkIndex,
      metadata: doc.metadata,
      indexes: toPortIndexes(doc.indexes),
      rebuilding: doc.rebuilding,
      version: doc.updateTime.getTime(),
      createTime: doc.createTime.toISOString(),
      updateTime: doc.updateTime.toISOString(),
    };
  }

  async bulkUpsert(
    input: { items: KnowledgeItemSnapshot[]; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ upserted: number; duplicates: number }> {
    const teamId = this.teamId(context);
    let upserted = 0;
    let duplicates = 0;
    for (const item of input.items) {
      if (item.teamId !== context.tenant.teamId) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'data', resourceId: item.dataId },
          }),
        );
      }
      if (!item.q && !item.imageId) {
        throw duplicateError('', item.datasetId, item.collectionId, context.requestId);
      }
      const datasetId = toOid(item.datasetId, 'datasetId', context.requestId);
      const collectionId = toOid(item.collectionId, 'collectionId', context.requestId);
      const dedupKey = item.q ? buildQaDedupKey(item.q, item.a ?? '') : null;
      const now = new Date();
      const identity: Record<string, unknown>[] = [];
      if (dedupKey) identity.push({ dedupKey });
      if (item.dataId) identity.push({ _id: toOid(item.dataId, 'dataId', context.requestId) });
      const existing = await this.model.findOne(
        identity.length === 1
          ? { teamId, datasetId, collectionId, ...identity[0] }
          : { teamId, datasetId, collectionId, $or: identity },
      );
      if (existing) {
        const history = [...existing.history];
        if (existing.q !== (item.q ?? null) || existing.a !== (item.a ?? '')) {
          history.push({
            oldQuestion: existing.q ?? '',
            oldAnswer: existing.a,
            updatedAt: now,
          });
        }
        const nextHistory: DataHistoryEntryValue[] = history.slice(-10);
        await this.model.updateOne(
          { _id: existing._id, teamId },
          {
            $set: {
              q: item.q ?? null,
              a: item.a ?? '',
              imageId: item.imageId ?? null,
              chunkIndex: item.chunkIndex ?? 0,
              metadata: item.metadata ?? {},
              indexes: toStoredIndexes(item.indexes),
              history: nextHistory,
              dedupKey,
              rebuilding: item.rebuilding,
              updateTime: now,
            },
          },
        );
        duplicates += 1;
        continue;
      }

      try {
        await this.model.create({
          _id: item.dataId ? toOid(item.dataId, 'dataId', context.requestId) : new Types.ObjectId(),
          teamId,
          datasetId,
          collectionId,
          q: item.q ?? null,
          a: item.a ?? '',
          imageId: item.imageId ?? null,
          imageDescMap: null,
          chunkIndex: item.chunkIndex ?? 0,
          metadata: item.metadata ?? {},
          history: [],
          indexes: toStoredIndexes(item.indexes),
          dedupKey,
          rebuilding: item.rebuilding,
          createTime: now,
          updateTime: now,
        } as unknown as DatasetDataDoc);
        upserted += 1;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        throw duplicateError(dedupKey ?? '', item.datasetId, item.collectionId, context.requestId);
      }
    }
    return { upserted, duplicates };
  }

  async updateIndexes(
    input: {
      dataId: string;
      version: number;
      indexes: KnowledgeItemSnapshot['indexes'];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    const teamId = this.teamId(context);
    const dataId = toOid(input.dataId, 'dataId', context.requestId);
    const current = await this.model.findOne({ _id: dataId, teamId }).lean();
    if (!current) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'data', resourceId: input.dataId },
        }),
      );
    }
    const actualVersion = current.updateTime.getTime();
    if (actualVersion !== input.version) {
      throw versionConflict(input.dataId, input.version, actualVersion, context.requestId);
    }
    const nextVersion = Math.max(Date.now(), actualVersion + 1);
    const updated = await this.model
      .findOneAndUpdate(
        { _id: dataId, teamId, updateTime: new Date(actualVersion) },
        {
          $set: {
            indexes: toStoredIndexes(input.indexes),
            updateTime: new Date(nextVersion),
          },
        },
        { new: true },
      )
      .lean();
    if (!updated) {
      const latest = await this.model.findOne({ _id: dataId, teamId }).lean();
      throw versionConflict(
        input.dataId,
        input.version,
        latest?.updateTime.getTime() ?? -1,
        context.requestId,
      );
    }
    return { version: updated.updateTime.getTime() };
  }

  async deleteByScope(
    input: {
      datasetId: string;
      collectionId?: string;
      dataIds?: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    const filter: Record<string, unknown> = {
      teamId: this.teamId(context),
      datasetId: toOid(input.datasetId, 'datasetId', context.requestId),
    };
    if (input.collectionId) {
      filter.collectionId = toOid(input.collectionId, 'collectionId', context.requestId);
    }
    if (input.dataIds) {
      filter._id = {
        $in: input.dataIds.map((id) => toOid(id, 'dataId', context.requestId)),
      };
    }
    const result = await this.model.deleteMany(filter);
    return { deleted: result.deletedCount };
  }

  async list(
    input: {
      collectionId: string;
      page: number;
      limit: number;
      search?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<PageResult<KnowledgeItemSnapshot>> {
    const filter: Record<string, unknown> = {
      teamId: this.teamId(context),
      collectionId: toOid(input.collectionId, 'collectionId', context.requestId),
    };
    if (input.search) {
      const escaped = input.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { q: { $regex: escaped, $options: 'i' } },
        { a: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [docs, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ chunkIndex: 1, updateTime: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      this.model.countDocuments(filter),
    ]);
    return {
      total,
      list: docs.map((doc) => this.toSnapshot(doc as DatasetDataDoc & { _id: Types.ObjectId })),
      cursor: null,
    };
  }

  async get(
    input: { dataId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot> {
    const doc = await this.model
      .findOne({
        _id: toOid(input.dataId, 'dataId', context.requestId),
        teamId: this.teamId(context),
      })
      .lean();
    if (!doc) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'data', resourceId: input.dataId },
        }),
      );
    }
    return this.toSnapshot(doc as DatasetDataDoc & { _id: Types.ObjectId });
  }
}
