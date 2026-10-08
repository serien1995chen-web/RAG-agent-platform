import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../../ports/types';
import type { CollectionSnapshot, PageResult } from '../../../ports/types';
import {
  DatasetCollectionSchema,
  DatasetSchema,
  type ChunkPolicyValue,
  type DatasetCollectionDoc,
  type DatasetDoc,
} from '../../../shared/persistence/schemas';
import { DEFAULT_CHUNK_POLICY } from '../../../shared/persistence/schemas/common';
import type { CollectionTreeRepository, PathNode } from '../domain/tree';
import { MAX_COLLECTION_TAGS } from '../domain/tree';

interface CollectionUpdatePatch {
  name?: string;
  parentId?: string | null;
  tagIds?: string[];
  trainingPolicy?: ChunkPolicyValue;
}

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

function invalidParent(
  parentId: string | null,
  datasetId: string,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501004,
      requestId,
      params: { parentId: parentId ?? '', datasetId },
    }),
  );
}

function versionConflict(
  collectionId: string,
  expectedVersion: number,
  actualVersion: number,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501067,
      requestId,
      params: {
        resourceType: 'collection',
        resourceId: collectionId,
        expectedVersion,
        actualVersion,
      },
    }),
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

export class MongoCollectionRepository implements CollectionTreeRepository {
  private readonly model: Model<DatasetCollectionDoc>;
  private readonly datasetModel: Model<DatasetDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetCollection as Model<DatasetCollectionDoc>) ??
      connection.model<DatasetCollectionDoc>('DatasetCollection', DatasetCollectionSchema);
    this.datasetModel =
      (connection.models.Dataset as Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private toSnapshot(doc: DatasetCollectionDoc & { _id: Types.ObjectId }): CollectionSnapshot {
    return {
      collectionId: String(doc._id),
      teamId: String(doc.teamId),
      datasetId: String(doc.datasetId),
      parentId: doc.parentId ? String(doc.parentId) : null,
      type: doc.type,
      name: doc.name,
      tagIds: doc.tagIds.map(String),
      ...(doc.sourceRef ? { sourceRef: JSON.stringify(doc.sourceRef) } : {}),
      trainingPolicy: doc.trainingPolicy,
      version: doc.updateTime.getTime(),
      createTime: doc.createTime.toISOString(),
      updateTime: doc.updateTime.toISOString(),
    };
  }

  private async requireDataset(
    datasetId: string,
    teamId: Types.ObjectId,
    requestId: string,
  ): Promise<Types.ObjectId> {
    const id = toOid(datasetId, 'datasetId', requestId);
    const dataset = await this.datasetModel.exists({ _id: id, teamId, deleteTime: null });
    if (!dataset) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'dataset', resourceId: datasetId },
        }),
      );
    }
    return id;
  }

  private async requireParent(
    parentId: string,
    datasetId: Types.ObjectId,
    teamId: Types.ObjectId,
    requestId: string,
  ): Promise<Types.ObjectId> {
    const id = toOid(parentId, 'parentId', requestId);
    const parent = await this.model.findOne({ _id: id, teamId, datasetId, type: 'folder' }).lean();
    if (!parent) throw invalidParent(String(parentId), String(datasetId), requestId);
    return id;
  }

  async create(
    input: {
      collection: Omit<
        CollectionSnapshot,
        'collectionId' | 'version' | 'createTime' | 'updateTime'
      >;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ collectionId: string }> {
    const teamId = this.teamId(context);
    const datasetId = await this.requireDataset(
      input.collection.datasetId,
      teamId,
      context.requestId,
    );
    const parentId = input.collection.parentId
      ? await this.requireParent(input.collection.parentId, datasetId, teamId, context.requestId)
      : null;
    const tagIds = (input.collection.tagIds ?? []).map((id) =>
      toOid(id, 'tagId', context.requestId),
    );
    if (tagIds.length > MAX_COLLECTION_TAGS) {
      throw new ApiErrorException(
        createApiError({
          code: 501044,
          requestId: context.requestId,
          params: { limit: MAX_COLLECTION_TAGS, current: tagIds.length },
        }),
      );
    }

    const externalFileId =
      (input.collection as { externalFileId?: string | null }).externalFileId ?? null;
    const normalized = externalFileId?.trim().toLowerCase() ?? null;
    if (normalized) {
      const duplicate = await this.model.exists({
        teamId,
        datasetId,
        externalFileIdNormalized: normalized,
      });
      if (duplicate) {
        throw new ApiErrorException(
          createApiError({
            code: 501002,
            requestId: context.requestId,
            params: {
              externalFileIdNormalized: normalized,
              collectionId: '',
              datasetId: String(datasetId),
            },
          }),
        );
      }
    }

    const now = new Date();
    try {
      const doc = await this.model.create({
        teamId,
        datasetId,
        parentId,
        type: input.collection.type,
        name: input.collection.name,
        tagIds,
        sourceRef: null,
        externalFileId,
        externalFileIdNormalized: normalized,
        hashRawText: null,
        trainingPolicy: input.collection.trainingPolicy ?? DEFAULT_CHUNK_POLICY,
        indexVersion: null,
        forbid: false,
        trainingState: 'ready',
        remainingTraining: 0,
        createTime: now,
        updateTime: now,
      } as DatasetCollectionDoc);
      return { collectionId: String(doc._id) };
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ApiErrorException(
          createApiError({
            code: 501002,
            requestId: context.requestId,
            params: {
              externalFileIdNormalized: normalized ?? '',
              collectionId: '',
              datasetId: String(datasetId),
            },
          }),
        );
      }
      throw error;
    }
  }

  async list(
    input: {
      datasetId: string;
      parentId?: string | null;
      page: number;
      limit: number;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<PageResult<CollectionSnapshot>> {
    const teamId = this.teamId(context);
    const datasetId = await this.requireDataset(input.datasetId, teamId, context.requestId);
    const filter: Record<string, unknown> = { teamId, datasetId };
    if (input.parentId !== undefined) {
      filter.parentId = input.parentId
        ? toOid(input.parentId, 'parentId', context.requestId)
        : null;
    }
    const [docs, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ updateTime: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      this.model.countDocuments(filter),
    ]);
    return {
      total,
      list: docs.map((doc) =>
        this.toSnapshot(doc as DatasetCollectionDoc & { _id: Types.ObjectId }),
      ),
      cursor: null,
    };
  }

  async get(
    input: { collectionId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<CollectionSnapshot> {
    const doc = await this.model
      .findOne({
        _id: toOid(input.collectionId, 'collectionId', context.requestId),
        teamId: this.teamId(context),
      })
      .lean();
    if (!doc) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'collection', resourceId: input.collectionId },
        }),
      );
    }
    return this.toSnapshot(doc as DatasetCollectionDoc & { _id: Types.ObjectId });
  }

  async update(
    input: {
      collectionId: string;
      version: number;
      patch: CollectionUpdatePatch;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    const teamId = this.teamId(context);
    const collectionId = toOid(input.collectionId, 'collectionId', context.requestId);
    const current = await this.model.findOne({ _id: collectionId, teamId }).lean();
    if (!current) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'collection', resourceId: input.collectionId },
        }),
      );
    }
    const actualVersion = current.updateTime.getTime();
    if (actualVersion !== input.version) {
      throw versionConflict(input.collectionId, input.version, actualVersion, context.requestId);
    }

    const patch: Record<string, unknown> = {};
    if (input.patch.name !== undefined) patch.name = input.patch.name;
    if (input.patch.trainingPolicy !== undefined) patch.trainingPolicy = input.patch.trainingPolicy;
    if (input.patch.tagIds !== undefined) {
      if (input.patch.tagIds.length > MAX_COLLECTION_TAGS) {
        throw new ApiErrorException(
          createApiError({
            code: 501044,
            requestId: context.requestId,
            params: { limit: MAX_COLLECTION_TAGS, current: input.patch.tagIds.length },
          }),
        );
      }
      patch.tagIds = input.patch.tagIds.map((id) => toOid(id, 'tagId', context.requestId));
    }
    if (input.patch.parentId !== undefined) {
      const targetParentId =
        input.patch.parentId === null
          ? null
          : await this.requireParent(
              input.patch.parentId,
              current.datasetId,
              teamId,
              context.requestId,
            );
      await this.assertMoveDoesNotCycle(collectionId, targetParentId, teamId, context.requestId);
      patch.parentId = targetParentId;
    }

    const nextVersion = Math.max(Date.now(), actualVersion + 1);
    const updated = await this.model
      .findOneAndUpdate(
        {
          _id: collectionId,
          teamId,
          updateTime: new Date(actualVersion),
        },
        { $set: { ...patch, updateTime: new Date(nextVersion) } },
        { new: true },
      )
      .lean();
    if (!updated) {
      const latest = await this.model.findOne({ _id: collectionId, teamId }).lean();
      throw versionConflict(
        input.collectionId,
        input.version,
        latest?.updateTime.getTime() ?? -1,
        context.requestId,
      );
    }
    return { version: updated.updateTime.getTime() };
  }

  async deleteTree(
    input: { collectionId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ deleteJobId: string }> {
    const exists = await this.model.exists({
      _id: toOid(input.collectionId, 'collectionId', context.requestId),
      teamId: this.teamId(context),
    });
    if (!exists) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'collection', resourceId: input.collectionId },
        }),
      );
    }
    return { deleteJobId: `${context.tenant.teamId}:${input.collectionId}:delete` };
  }

  async paths(
    input: { datasetId: string; sourceId: string; type: 'collection' },
    context: RequestContext,
  ): Promise<PathNode[]> {
    const teamId = this.teamId(context);
    const datasetId = await this.requireDataset(input.datasetId, teamId, context.requestId);
    const nodes: PathNode[] = [];
    const seen = new Set<string>();
    let currentId: Types.ObjectId | null = toOid(input.sourceId, 'sourceId', context.requestId);
    while (currentId) {
      const key = String(currentId);
      if (seen.has(key)) break;
      seen.add(key);
      const doc: (DatasetCollectionDoc & { _id: Types.ObjectId }) | null = await this.model
        .findOne({ _id: currentId, teamId, datasetId })
        .lean();
      if (!doc) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'collection', resourceId: key },
          }),
        );
      }
      nodes.unshift({
        id: String(doc._id),
        name: doc.name,
        parentId: doc.parentId ? String(doc.parentId) : null,
      });
      currentId = doc.parentId;
    }
    return nodes;
  }

  move(
    input: {
      collectionId: string;
      version: number;
      targetParentId: string | null;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    return this.update(
      {
        collectionId: input.collectionId,
        version: input.version,
        patch: { parentId: input.targetParentId },
        options: input.options,
      },
      context,
    );
  }

  private async assertMoveDoesNotCycle(
    collectionId: Types.ObjectId,
    targetParentId: Types.ObjectId | null,
    teamId: Types.ObjectId,
    requestId: string,
  ): Promise<void> {
    if (!targetParentId) return;
    const seen = new Set<string>();
    let currentId: Types.ObjectId | null = targetParentId;
    let depth = 0;
    while (currentId) {
      depth += 1;
      const key = String(currentId);
      if (seen.has(key) || currentId.equals(collectionId)) {
        throw new ApiErrorException(
          createApiError({
            code: 501046,
            requestId,
            params: {
              resourceId: String(collectionId),
              targetParentId: String(targetParentId),
              depth,
            },
          }),
        );
      }
      seen.add(key);
      const parent: Pick<DatasetCollectionDoc, 'parentId'> | null = await this.model
        .findOne({ _id: currentId, teamId })
        .select({ parentId: 1 })
        .lean();
      if (!parent) throw invalidParent(String(currentId), '', requestId);
      currentId = parent.parentId ?? null;
    }
  }
}
