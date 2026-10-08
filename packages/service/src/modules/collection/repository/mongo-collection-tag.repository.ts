import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../../ports/types';
import {
  DatasetCollectionSchema,
  DatasetTagSchema,
  type DatasetCollectionDoc,
  type DatasetTagDoc,
} from '../../../shared/persistence/schemas';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import { MAX_DATASET_TAGS, type CollectionTagRepository, type TagSnapshot } from '../domain/tag';

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

function duplicateNameError(name: string, datasetId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501043, requestId, params: { name, datasetId } }),
  );
}

function tagLimitError(current: number, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501044,
      requestId,
      params: { limit: MAX_DATASET_TAGS, current },
    }),
  );
}

function bindingConflict(
  tagId: string,
  conflictCount: number,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501045, requestId, params: { tagId, conflictCount } }),
  );
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export class MongoCollectionTagRepository implements CollectionTagRepository {
  private readonly connection: Connection;
  private readonly tags: Model<DatasetTagDoc>;
  private readonly collections: Model<DatasetCollectionDoc>;

  constructor(connection: Connection) {
    this.connection = connection;
    this.tags =
      (connection.models.DatasetTag as Model<DatasetTagDoc>) ??
      connection.model<DatasetTagDoc>('DatasetTag', DatasetTagSchema);
    this.collections =
      (connection.models.DatasetCollection as Model<DatasetCollectionDoc>) ??
      connection.model<DatasetCollectionDoc>('DatasetCollection', DatasetCollectionSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private toSnapshot(doc: DatasetTagDoc & { _id: Types.ObjectId }): TagSnapshot {
    return {
      tagId: String(doc._id),
      teamId: String(doc.teamId),
      datasetId: String(doc.datasetId),
      name: doc.name,
      version: doc.updateTime.getTime(),
      createTime: doc.createTime.toISOString(),
      updateTime: doc.updateTime.toISOString(),
    };
  }

  private async requireTag(
    datasetId: Types.ObjectId,
    tagId: string,
    teamId: Types.ObjectId,
    requestId: string,
  ): Promise<DatasetTagDoc & { _id: Types.ObjectId }> {
    const tag: (DatasetTagDoc & { _id: Types.ObjectId }) | null = await this.tags
      .findOne({ _id: toOid(tagId, 'tagId', requestId), teamId, datasetId })
      .lean();
    if (!tag) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'tag', resourceId: tagId },
        }),
      );
    }
    return tag;
  }

  async list(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<TagSnapshot[]> {
    const docs = await this.tags
      .find({
        teamId: this.teamId(context),
        datasetId: toOid(input.datasetId, 'datasetId', context.requestId),
      })
      .sort({ name: 1 })
      .lean();
    return docs.map((doc) => this.toSnapshot(doc as DatasetTagDoc & { _id: Types.ObjectId }));
  }

  async create(
    input: { datasetId: string; name: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ tagId: string }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const count = await this.tags.countDocuments({ teamId, datasetId });
    if (count >= MAX_DATASET_TAGS) throw tagLimitError(count, context.requestId);
    const now = new Date();
    try {
      const doc = await this.tags.create({
        teamId,
        datasetId,
        name: input.name,
        createTime: now,
        updateTime: now,
      } as DatasetTagDoc);
      return { tagId: String(doc._id) };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw duplicateNameError(input.name, input.datasetId, context.requestId);
      }
      throw error;
    }
  }

  async update(
    input: {
      datasetId: string;
      tagId: string;
      version: number;
      name: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ tagId: string; version: number }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const current = await this.requireTag(datasetId, input.tagId, teamId, context.requestId);
    if (current.updateTime.getTime() !== input.version) {
      throw duplicateNameError(input.name, input.datasetId, context.requestId);
    }
    try {
      const nextVersion = Math.max(Date.now(), current.updateTime.getTime() + 1);
      const updated = await this.tags.findOneAndUpdate(
        {
          _id: current._id,
          teamId,
          datasetId,
          updateTime: current.updateTime,
        },
        { $set: { name: input.name, updateTime: new Date(nextVersion) } },
        { new: true },
      );
      if (!updated) {
        throw bindingConflict(input.tagId, 1, context.requestId);
      }
      return { tagId: String(updated._id), version: updated.updateTime.getTime() };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw duplicateNameError(input.name, input.datasetId, context.requestId);
      }
      throw error;
    }
  }

  async delete(
    input: { datasetId: string; tagId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ affectedCollections: number }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const tag = await this.requireTag(datasetId, input.tagId, teamId, context.requestId);
    return withMongoTransaction(this.connection, async (session) => {
      const update = await this.collections.updateMany(
        { teamId, datasetId, tagIds: tag._id },
        { $pull: { tagIds: tag._id }, $set: { updateTime: new Date() } },
        { session },
      );
      await this.tags.deleteOne({ _id: tag._id, teamId, datasetId }, { session });
      return { affectedCollections: update.modifiedCount };
    });
  }

  private async requireCollections(
    datasetId: Types.ObjectId,
    collectionIds: string[],
    teamId: Types.ObjectId,
    requestId: string,
  ): Promise<(DatasetCollectionDoc & { _id: Types.ObjectId })[]> {
    const ids = collectionIds.map((id) => toOid(id, 'collectionId', requestId));
    const docs = await this.collections.find({ _id: { $in: ids }, teamId, datasetId }).lean();
    if (docs.length !== ids.length) {
      throw bindingConflict('', ids.length - docs.length, requestId);
    }
    return docs as (DatasetCollectionDoc & { _id: Types.ObjectId })[];
  }

  private async bind(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
    add: boolean,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const tag = await this.requireTag(datasetId, input.tagId, teamId, context.requestId);
    const docs = await this.requireCollections(
      datasetId,
      input.collectionIds,
      teamId,
      context.requestId,
    );
    const updated: string[] = [];
    const skipped: string[] = [];
    for (const doc of docs) {
      const hasTag = doc.tagIds.some((id) => String(id) === String(tag._id));
      if ((add && hasTag) || (!add && !hasTag)) {
        skipped.push(String(doc._id));
        continue;
      }
      const nextTagIds = add
        ? [...doc.tagIds, tag._id]
        : doc.tagIds.filter((id) => String(id) !== String(tag._id));
      if (nextTagIds.length > MAX_DATASET_TAGS) {
        throw tagLimitError(nextTagIds.length, context.requestId);
      }
      const result = await this.collections.findOneAndUpdate(
        { _id: doc._id, teamId, datasetId, updateTime: doc.updateTime },
        { $set: { tagIds: nextTagIds, updateTime: new Date() } },
      );
      if (!result) {
        throw bindingConflict(input.tagId, updated.length + 1, context.requestId);
      }
      updated.push(String(doc._id));
    }
    return { updated, skipped };
  }

  addToCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    return this.bind(input, context, true);
  }

  removeFromCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    return this.bind(input, context, false);
  }
}
