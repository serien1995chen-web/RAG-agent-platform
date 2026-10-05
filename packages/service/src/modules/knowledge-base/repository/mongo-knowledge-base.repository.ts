import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { KnowledgeBaseRepository } from '../../../ports/repositories';
import type { KnowledgeBaseSnapshot, RequestContext } from '../../../ports/types';
import { DatasetSchema, type DatasetDoc } from '../../../shared/persistence/schemas';
import type {
  DatasetListQueryInput,
  DatasetListResult,
  DatasetSummaryValue,
  KnowledgeBaseQueryRepository,
} from '../domain/dataset-query';

/** 10.3：type=dataset 在物理层对应 knowledge/external/api/feishu/yuque/dingtalk。 */
const DATASET_TYPES = ['knowledge', 'external', 'api', 'feishu', 'yuque', 'dingtalk'] as const;
const WRITE_TIMEOUT_MS = 10_000;

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
    const parentId = input.dataset.parentId
      ? toOid(input.dataset.parentId, 'parentId', context.requestId)
      : null;
    if (parentId) {
      const parent = await this.model.exists({ _id: parentId, teamId, deleteTime: null });
      if (!parent) {
        throw new ApiErrorException(
          createApiError({
            code: 501004,
            requestId: context.requestId,
            params: { parentId: String(parentId), datasetId: '' },
          }),
        );
      }
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
    const allowed = ['name', 'intro', 'autoSync', 'inheritPermission', 'vectorModel'] as const;
    const patch: Record<string, unknown> = { updateTime: new Date() };
    for (const key of allowed) {
      if (input.patch[key] !== undefined) patch[key] = input.patch[key];
    }
    const updated = await this.model
      .findOneAndUpdate(
        {
          _id: toOid(input.datasetId, 'datasetId', context.requestId),
          teamId: this.teamId(context),
          deleteTime: null,
          version: input.version,
        },
        { $set: patch, $inc: { version: 1 } },
        { new: true },
      )
      .lean();
    if (!updated) {
      throw new ApiErrorException(
        createApiError({
          code: 501067,
          requestId: context.requestId,
          params: {
            resourceType: 'dataset',
            resourceId: input.datasetId,
            expectedVersion: input.version,
            actualVersion: -1,
          },
        }),
      );
    }
    return { version: updated.version };
  }

  async softDelete(
    input: { datasetId: string; version: number; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ deleteJobId: string }> {
    const updated = await this.model.findOneAndUpdate(
      {
        _id: toOid(input.datasetId, 'datasetId', context.requestId),
        teamId: this.teamId(context),
        deleteTime: null,
      },
      { $set: { deleteTime: new Date(), updateTime: new Date() } },
    );
    if (!updated) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: input.datasetId },
        }),
      );
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

  static writeTimeoutMs(): number {
    return WRITE_TIMEOUT_MS;
  }
}
