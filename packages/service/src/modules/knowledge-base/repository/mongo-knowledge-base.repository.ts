import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { KnowledgeBaseRepository } from '../../../ports/repositories';
import type { KnowledgeBaseSnapshot, RequestContext } from '../../../ports/types';
import { DatasetSchema, type DatasetDoc } from '../../../shared/persistence/schemas';
import type {
  DatasetUpdateInput,
  DatasetListQueryInput,
  DatasetListResult,
  DatasetSummaryValue,
  KnowledgeBaseQueryRepository,
} from '../domain/dataset-query';

/** 10.3：type=dataset 在物理层对应 knowledge/external/api/feishu/yuque/dingtalk。 */
const DATASET_TYPES = ['knowledge', 'external', 'api', 'feishu', 'yuque', 'dingtalk'] as const;
const WRITE_TIMEOUT_MS = 10_000;
const ALLOWED_TYPES = new Set<string>([...DATASET_TYPES, 'folder']);

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

function duplicateNameError(
  name: string,
  parentId: Types.ObjectId | null,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501066,
      requestId,
      params: { name, parentId: parentId ? String(parentId) : null },
    }),
  );
}

function typeError(type: string, requestId: string): ApiErrorException {
  return new ApiErrorException(createApiError({ code: 501001, requestId, params: { type } }));
}

function versionConflict(
  datasetId: string,
  expectedVersion: number,
  actualVersion: number,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501067,
      requestId,
      params: {
        resourceType: 'dataset',
        resourceId: datasetId,
        expectedVersion,
        actualVersion,
      },
    }),
  );
}

function invalidParent(parentId: string, datasetId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501004,
      requestId,
      params: { parentId, datasetId },
    }),
  );
}

/**
 * Mongo 最小实现：所有查询强制 teamId 谓词；缺省即拒绝。
 * 完整 Repository（事务、索引管理器联动）在后续阶段补强。
 */
export class MongoKnowledgeBaseRepository
  implements KnowledgeBaseRepository, KnowledgeBaseQueryRepository
{
  private readonly model: Model<DatasetDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.Dataset as Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private toSummary(doc: DatasetDoc & { _id: Types.ObjectId }): DatasetSummaryValue {
    return {
      datasetId: String(doc._id),
      teamId: String(doc.teamId),
      name: doc.name,
      type: doc.type,
      parentId: doc.parentId ? String(doc.parentId) : null,
      vectorModel: doc.vectorModel,
      indexVersion: doc.indexVersion,
      agentModel: doc.agentModel ?? null,
      vlmModel: doc.vlmModel ?? null,
      chunkPolicy: doc.chunkPolicy,
      inheritPermission: doc.inheritPermission,
      autoSync: doc.autoSync,
      deleteTime: doc.deleteTime ? doc.deleteTime.toISOString() : null,
      version: doc.version,
      createTime: doc.createTime.toISOString(),
      updateTime: doc.updateTime.toISOString(),
    };
  }

  async create(
    input: {
      dataset: Omit<
        KnowledgeBaseSnapshot,
        'datasetId' | 'deleteTime' | 'version' | 'createTime' | 'updateTime'
      >;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ datasetId: string; version: number }> {
    const teamId = this.teamId(context);
    if (!ALLOWED_TYPES.has(input.dataset.type)) {
      throw typeError(input.dataset.type, context.requestId);
    }
    const parentId = input.dataset.parentId
      ? toOid(input.dataset.parentId, 'parentId', context.requestId)
      : null;
    if (parentId) {
      const parent = await this.model.findOne({ _id: parentId, teamId, deleteTime: null }).lean();
      if (!parent) {
        throw invalidParent(String(parentId), '', context.requestId);
      }
      if (parent.type !== 'folder') throw invalidParent(String(parentId), '', context.requestId);
    }
    const duplicate = await this.model.exists({
      teamId,
      parentId,
      name: input.dataset.name,
      deleteTime: null,
    });
    if (duplicate) {
      throw duplicateNameError(input.dataset.name, parentId, context.requestId);
    }
    const now = new Date();
    const doc = await this.model.create({
      teamId,
      createdBy: toOid(context.tenant.tmbId, 'tmbId', context.requestId),
      parentId,
      type: input.dataset.type,
      name: input.dataset.name,
      intro: input.dataset.intro ?? '',
      avatar: '',
      vectorModel: input.dataset.vectorModel,
      indexVersion: `${input.dataset.vectorModel}:1536:v1`,
      agentModel: input.dataset.agentModel ?? null,
      vlmModel: input.dataset.vlmModel ?? null,
      inheritPermission: input.dataset.inheritPermission,
      autoSync: input.dataset.autoSync,
      deleteTime: null,
      version: 1,
      createTime: now,
      updateTime: now,
    } as DatasetDoc);
    return { datasetId: String(doc._id), version: doc.version };
  }

  async get(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<KnowledgeBaseSnapshot> {
    const doc = await this.model
      .findOne({
        _id: toOid(input.datasetId, 'datasetId', context.requestId),
        teamId: this.teamId(context),
        deleteTime: null,
      })
      .lean();
    if (!doc) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: input.datasetId },
        }),
      );
    }
    const summary = this.toSummary(doc as DatasetDoc & { _id: Types.ObjectId });
    return { ...summary, deleteTime: summary.deleteTime };
  }

  async update(
    input: {
      datasetId: string;
      version: number;
      patch: Partial<KnowledgeBaseSnapshot>;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    const patch: Record<string, unknown> = { updateTime: new Date() };
    for (const key of ['name', 'intro', 'autoSync', 'inheritPermission', 'vectorModel'] as const) {
      const value = input.patch[key];
      if (value !== undefined) patch[key] = value;
    }
    return this.applyUpdate(
      {
        datasetId: input.datasetId,
        version: input.version,
        patch,
        options: input.options,
      },
      context,
    );
  }

  async updateDataset(
    input: DatasetUpdateInput,
    context: RequestContext,
  ): Promise<{ version: number }> {
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const teamId = this.teamId(context);
    const current = await this.model.findOne({ _id: datasetId, teamId, deleteTime: null }).lean();
    if (!current) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: input.datasetId },
        }),
      );
    }
    if (current.version !== input.version) {
      throw versionConflict(input.datasetId, input.version, current.version, context.requestId);
    }

    const patch: Record<string, unknown> = { updateTime: new Date() };
    if (input.patch.parentId !== undefined) {
      const parentId = input.patch.parentId
        ? toOid(input.patch.parentId, 'parentId', context.requestId)
        : null;
      if (parentId?.equals(datasetId)) {
        throw new ApiErrorException(
          createApiError({
            code: 501046,
            requestId: context.requestId,
            params: {
              resourceId: input.datasetId,
              targetParentId: String(parentId),
              depth: 1,
            },
          }),
        );
      }
      if (parentId) {
        const parent = await this.model.findOne({ _id: parentId, teamId, deleteTime: null }).lean();
        if (!parent || parent.type !== 'folder') {
          throw invalidParent(String(parentId), input.datasetId, context.requestId);
        }
      }
      patch.parentId = parentId;
    }
    for (const key of [
      'type',
      'name',
      'intro',
      'vectorModel',
      'agentModel',
      'vlmModel',
      'chunkPolicy',
      'inheritPermission',
      'autoSync',
    ] as const) {
      const value = input.patch[key];
      if (value !== undefined) patch[key] = value;
    }
    if (typeof patch.type === 'string' && !ALLOWED_TYPES.has(patch.type)) {
      throw typeError(patch.type, context.requestId);
    }
    if (typeof input.patch.name === 'string') {
      const parentId = Object.prototype.hasOwnProperty.call(patch, 'parentId')
        ? (patch.parentId as Types.ObjectId | null)
        : current.parentId;
      const duplicate = await this.model.exists({
        _id: { $ne: datasetId },
        teamId,
        parentId,
        name: input.patch.name,
        deleteTime: null,
      });
      if (duplicate) {
        throw duplicateNameError(input.patch.name, parentId, context.requestId);
      }
    }
    return this.applyUpdate(
      {
        datasetId: input.datasetId,
        version: input.version,
        patch,
        options: input.options,
      },
      context,
    );
  }

  private async applyUpdate(
    input: {
      datasetId: string;
      version: number;
      patch: Record<string, unknown>;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const teamId = this.teamId(context);
    const updated = await this.model
      .findOneAndUpdate(
        {
          _id: datasetId,
          teamId,
          deleteTime: null,
          version: input.version,
        },
        { $set: input.patch, $inc: { version: 1 } },
        { new: true },
      )
      .lean();
    if (!updated) {
      const current = await this.model.findOne({ _id: datasetId, teamId, deleteTime: null }).lean();
      if (!current) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'dataset', resourceId: input.datasetId },
          }),
        );
      }
      throw versionConflict(input.datasetId, input.version, current.version, context.requestId);
    }
    return { version: updated.version };
  }

  async softDelete(
    input: { datasetId: string; version: number; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ deleteJobId: string }> {
    const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const teamId = this.teamId(context);
    const current = await this.model.findOne({ _id: datasetId, teamId, deleteTime: null }).lean();
    if (!current) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: input.datasetId },
        }),
      );
    }
    if (current.version !== input.version) {
      throw versionConflict(input.datasetId, input.version, current.version, context.requestId);
    }
    const updated = await this.model.findOneAndUpdate(
      {
        _id: datasetId,
        teamId,
        deleteTime: null,
        version: input.version,
      },
      { $set: { deleteTime: new Date(), updateTime: new Date() }, $inc: { version: 1 } },
      { new: true },
    );
    if (!updated) {
      const latest = await this.model.findOne({ _id: datasetId, teamId }).lean();
      if (!latest) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'dataset', resourceId: input.datasetId },
          }),
        );
      }
      throw versionConflict(input.datasetId, input.version, latest.version, context.requestId);
    }
    return { deleteJobId: `${context.tenant.teamId}:${input.datasetId}:delete` };
  }

  async listByTeam(
    input: DatasetListQueryInput,
    context: RequestContext,
  ): Promise<DatasetListResult> {
    const filter: Record<string, unknown> = {
      teamId: this.teamId(context),
      deleteTime: null,
    };
    if (input.parentId) {
      filter.parentId = toOid(input.parentId, 'parentId', context.requestId);
    } else {
      filter.parentId = null;
    }
    if (input.type === 'folder') filter.type = 'folder';
    if (input.type === 'dataset') filter.type = { $in: DATASET_TYPES };

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
      list: docs.map((doc) => this.toSummary(doc as DatasetDoc & { _id: Types.ObjectId })),
    };
  }

  async findByDatasetId(
    input: { datasetId: string },
    context: RequestContext,
  ): Promise<DatasetSummaryValue | null> {
    const doc = await this.model
      .findOne({
        _id: toOid(input.datasetId, 'datasetId', context.requestId),
        teamId: this.teamId(context),
        deleteTime: null,
      })
      .lean();
    return doc ? this.toSummary(doc as DatasetDoc & { _id: Types.ObjectId }) : null;
  }

  async countChildren(datasetId: string, context: RequestContext): Promise<number> {
    return this.model.countDocuments({
      teamId: this.teamId(context),
      parentId: toOid(datasetId, 'datasetId', context.requestId),
      deleteTime: null,
    });
  }

  async countDescendants(datasetId: string, context: RequestContext): Promise<number> {
    const rootId = toOid(datasetId, 'datasetId', context.requestId);
    const teamId = this.teamId(context);
    const queue = [rootId];
    const seen = new Set<string>();
    let count = 0;
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = await this.model
        .find({ teamId, parentId, deleteTime: null })
        .select({ _id: 1 })
        .lean();
      for (const child of children) {
        const id = String(child._id);
        if (seen.has(id)) continue;
        seen.add(id);
        count += 1;
        queue.push(child._id);
      }
    }
    return count;
  }

  static writeTimeoutMs(): number {
    return WRITE_TIMEOUT_MS;
  }
}
