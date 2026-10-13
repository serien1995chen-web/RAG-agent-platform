import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { buildDeleteJobId } from '@kb/dal';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import type { ObjectRef, RequestContext } from '../../../ports/types';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import {
  CrossStoreOperationSchema,
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetDeleteJobSchema,
  DatasetSchema,
  DatasetTrainingSchema,
  ImageAssetSchema,
  type CrossStoreOperationDoc,
  type DatasetAclDoc,
  type DatasetCollectionDoc,
  type DatasetDataDoc,
  type DatasetDataTextDoc,
  type DatasetDeleteJobDoc,
  type DatasetDoc,
  type DatasetTrainingDoc,
  type ImageAssetDoc,
} from '../../../shared/persistence/schemas';

/** 删除范围（dataset/collection/data 三类入口）。 */
export type DeleteScopeKind = 'dataset' | 'collection' | 'data';

export interface DeleteScope {
  kind: DeleteScopeKind;
  datasetId?: string;
  collectionId?: string;
  dataId?: string;
}

export interface ExecuteDeleteTransactionInput {
  scope: DeleteScope;
  expectedVersion?: number;
  /** 服务层已按冻结格式算出的稳定 jobId；collection/data 范围缺省时由本仓储补齐格式。 */
  jobId?: string;
  resourceIds?: { collectionIds?: string[]; dataIds?: string[] };
}

export interface DeleteTransactionResult {
  deleteJobId: string;
  datasetId: string;
  state: 'marked' | 'completed' | 'failed';
  existing: boolean;
  objectRefs: ObjectRef[];
  vectorDataIds: string[];
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

function notFound(resourceType: string, resourceId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501070, requestId, params: { resourceType, resourceId } }),
  );
}

function deleteInProgress(jobId: string, state: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501068, requestId, params: { jobId, state } }),
  );
}

function versionConflict(
  resourceId: string,
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
        resourceId,
        expectedVersion,
        actualVersion,
      },
    }),
  );
}

/** operationId 中的 objectKeyHash 采用 sha256 前 16 位十六进制（稳定且不泄露完整 key）。 */
function objectKeyHash(objectKey: string): string {
  return createHash('sha256').update(objectKey).digest('hex').slice(0, 16);
}

/**
 * 删除事务事实源（E1）：单事务完成软删除/派生表物理清理/任务与跨存储操作落库；
 * 事务内不得调用 S3/pgvector/BullMQ；所有查询强制 teamId。
 */
export class MongoDeleteFactsRepository {
  private readonly connection: Connection;
  private readonly datasets: Model<DatasetDoc>;
  private readonly collections: Model<DatasetCollectionDoc>;
  private readonly datas: Model<DatasetDataDoc>;
  private readonly texts: Model<DatasetDataTextDoc>;
  private readonly trainings: Model<DatasetTrainingDoc>;
  private readonly acls: Model<DatasetAclDoc>;
  private readonly imageAssets: Model<ImageAssetDoc>;
  private readonly jobs: Model<DatasetDeleteJobDoc>;
  private readonly operations: Model<CrossStoreOperationDoc>;

  constructor(connection: Connection) {
    this.connection = connection;
    this.datasets =
      (connection.models.Dataset as Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
    this.collections =
      (connection.models.DatasetCollection as Model<DatasetCollectionDoc>) ??
      connection.model<DatasetCollectionDoc>('DatasetCollection', DatasetCollectionSchema);
    this.datas =
      (connection.models.DatasetData as Model<DatasetDataDoc>) ??
      connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
    this.texts =
      (connection.models.DatasetDataText as Model<DatasetDataTextDoc>) ??
      connection.model<DatasetDataTextDoc>('DatasetDataText', DatasetDataTextSchema);
    this.trainings =
      (connection.models.DatasetTraining as Model<DatasetTrainingDoc>) ??
      connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
    this.acls =
      (connection.models.DatasetAcl as Model<DatasetAclDoc>) ??
      connection.model<DatasetAclDoc>('DatasetAcl', DatasetAclSchema);
    this.imageAssets =
      (connection.models.ImageAsset as Model<ImageAssetDoc>) ??
      connection.model<ImageAssetDoc>('ImageAsset', ImageAssetSchema);
    this.jobs =
      (connection.models.DatasetDeleteJob as Model<DatasetDeleteJobDoc>) ??
      connection.model<DatasetDeleteJobDoc>('DatasetDeleteJob', DatasetDeleteJobSchema);
    this.operations =
      (connection.models.CrossStoreOperation as Model<CrossStoreOperationDoc>) ??
      connection.model<CrossStoreOperationDoc>('CrossStoreOperation', CrossStoreOperationSchema);
  }

  private teamIdOf(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  /** dataset/collection/data 三类删除的事务事实源；幂等语义在事务内先判定。 */
  async executeDeleteTransaction(
    input: ExecuteDeleteTransactionInput,
    context: RequestContext,
  ): Promise<DeleteTransactionResult> {
    const teamId = this.teamIdOf(context);
    const requestId = context.requestId;
    const now = new Date();

    return withMongoTransaction(this.connection, async (session) => {
      const datasetId = await this.resolveDatasetId(input.scope, teamId, requestId, session);
      const dataset = (await this.datasets
        .findOne({ teamId, _id: datasetId })
        .session(session)
        .lean()) as unknown as (DatasetDoc & { _id: Types.ObjectId }) | null;
      if (!dataset) throw notFound('dataset', String(datasetId), requestId);

      const jobId = input.jobId ?? this.buildScopedJobId(String(teamId), input.scope, datasetId);
      const existing = (await this.jobs
        .findOne({ teamId, jobId })
        .session(session)
        .lean()) as unknown as DatasetDeleteJobDoc | null;
      if (existing) {
        const state = existing.state as 'marked' | 'queued' | 'deleting' | 'completed' | 'failed';
        if (state === 'completed' || state === 'failed') {
          return {
            deleteJobId: jobId,
            datasetId: String(datasetId),
            state,
            existing: true,
            objectRefs: [],
            vectorDataIds: [],
          };
        }
        throw deleteInProgress(jobId, state, requestId);
      }

      if (dataset.deleteTime !== null) {
        throw notFound('dataset', String(datasetId), requestId);
      }
      if (input.expectedVersion !== undefined && dataset.version !== input.expectedVersion) {
        throw versionConflict(String(datasetId), input.expectedVersion, dataset.version, requestId);
      }

      const scopeFilter: Record<string, unknown> = { teamId, datasetId };
      if (input.scope.kind === 'collection') {
        scopeFilter.collectionId = toOid(input.scope.collectionId ?? '', 'collectionId', requestId);
      }
      if (input.scope.kind === 'data') {
        scopeFilter._id = toOid(input.scope.dataId ?? '', 'dataId', requestId);
      }

      const vectorDataIds = await this.collectDataIds(scopeFilter, session);
      const objectRefs = await this.collectObjectRefs({ teamId, datasetId }, session);

      await this.cleanupDerivedTables(input.scope, { teamId, datasetId }, session, requestId);
      if (input.scope.kind === 'dataset') {
        await this.datasets.updateOne(
          { _id: datasetId, teamId, deleteTime: null, version: dataset.version },
          { $set: { deleteTime: now, updateTime: now }, $inc: { version: 1 } },
          { session },
        );
      }

      const nextVersion = input.scope.kind === 'dataset' ? dataset.version + 1 : dataset.version;
      await this.jobs.updateOne(
        { teamId, jobId },
        {
          $setOnInsert: {
            jobId,
            teamId,
            datasetId,
            state: 'marked',
            stage: 'mongo',
            progress: { total: 0, done: 0, failed: 0, skipped: 0 },
            attempt: 0,
            error: null,
            leaseOwner: null,
            leaseExpireAt: null,
            createTime: now,
            updateTime: now,
          },
        },
        { upsert: true, session },
      );
      await this.prepareCrossStoreOperations(
        {
          teamId,
          datasetId: String(datasetId),
          version: nextVersion,
          vectorDataIds,
          objectRefs,
        },
        session,
        now,
      );

      return {
        deleteJobId: jobId,
        datasetId: String(datasetId),
        state: 'marked',
        existing: false,
        objectRefs,
        vectorDataIds,
      };
    });
  }

  /** 供清理运行器按 scope 复核对象引用（image_assets.objectKey，即 dataset/{datasetId}/ 前缀对象）。 */
  async listObjectRefsForScope(scope: DeleteScope, context: RequestContext): Promise<ObjectRef[]> {
    const teamId = this.teamIdOf(context);
    const datasetId = await this.resolveDatasetId(scope, teamId, context.requestId);
    const docs = (await this.imageAssets
      .find({ teamId, datasetId })
      .lean()) as unknown as ImageAssetDoc[];
    return docs.map((doc) => ({ bucket: '', key: doc.objectKey }));
  }

  /** 供清理运行器按 scope 取向量清理资源（dataset_datas 主键）。 */
  async listVectorDataIds(scope: DeleteScope, context: RequestContext): Promise<string[]> {
    const teamId = this.teamIdOf(context);
    const datasetId = await this.resolveDatasetId(scope, teamId, context.requestId);
    const filter: Record<string, unknown> = { teamId, datasetId };
    if (scope.kind === 'collection') {
      filter.collectionId = toOid(scope.collectionId ?? '', 'collectionId', context.requestId);
    }
    if (scope.kind === 'data') {
      filter._id = toOid(scope.dataId ?? '', 'dataId', context.requestId);
    }
    const rows = (await this.datas.find(filter).select('_id').lean()) as unknown as Array<{
      _id: Types.ObjectId;
    }>;
    return rows.map((row) => String(row._id));
  }

  /**
   * 正式引用复核：对象 key 已 promote/正式引用，或 data/dataset 仍存活时为 true；
   * 无法证明为孤儿（对象记录缺失）时按 fail-safe 返回 true，绝不误删。
   */
  async hasLiveReference(
    input: { objectKey?: string; dataId?: string; datasetId?: string },
    context: RequestContext,
  ): Promise<boolean> {
    const teamId = this.teamIdOf(context);
    if (input.objectKey !== undefined) {
      const asset = (await this.imageAssets
        .findOne({ teamId, objectKey: input.objectKey })
        .lean()) as unknown as ImageAssetDoc | null;
      if (!asset) return true;
      if (asset.persistent || asset.state === 'referenced') return true;
      const referenced = await this.datas.exists({ teamId, imageId: asset.imageId });
      return Boolean(referenced);
    }
    if (input.dataId !== undefined) {
      const dataId = toOid(input.dataId, 'dataId', context.requestId);
      const alive = await this.datas.exists({
        teamId,
        $or: [{ _id: dataId }, { 'indexes.dataId': input.dataId }],
      });
      return Boolean(alive);
    }
    if (input.datasetId !== undefined) {
      const datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
      const alive = await this.datasets.exists({ teamId, _id: datasetId, deleteTime: null });
      return Boolean(alive);
    }
    return true;
  }

  private async resolveDatasetId(
    scope: DeleteScope,
    teamId: Types.ObjectId,
    requestId: string,
    session?: ClientSession,
  ): Promise<Types.ObjectId> {
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      const datasetId = toOid(scope.datasetId, 'datasetId', requestId);
      if (scope.kind === 'collection') {
        const collection = await this.collections
          .findOne({
            teamId,
            datasetId,
            _id: toOid(scope.collectionId ?? '', 'collectionId', requestId),
          })
          .session(session ?? null)
          .lean();
        if (!collection) throw notFound('collection', scope.collectionId ?? '', requestId);
      }
      if (scope.kind === 'data') {
        const data = await this.datas
          .findOne({
            teamId,
            datasetId,
            _id: toOid(scope.dataId ?? '', 'dataId', requestId),
          })
          .session(session ?? null)
          .lean();
        if (!data) throw notFound('data', scope.dataId ?? '', requestId);
      }
      return datasetId;
    }
    if (scope.kind === 'collection') {
      const collection = await this.collections
        .findOne({ teamId, _id: toOid(scope.collectionId ?? '', 'collectionId', requestId) })
        .session(session ?? null)
        .lean();
      if (!collection) {
        throw notFound('collection', scope.collectionId ?? '', requestId);
      }
      return collection.datasetId;
    }
    if (scope.kind === 'data') {
      const data = await this.datas
        .findOne({ teamId, _id: toOid(scope.dataId ?? '', 'dataId', requestId) })
        .session(session ?? null)
        .lean();
      if (!data) {
        throw notFound('data', scope.dataId ?? '', requestId);
      }
      return data.datasetId;
    }
    throw notFound('dataset', '', requestId);
  }

  private buildScopedJobId(teamId: string, scope: DeleteScope, datasetId: Types.ObjectId): string {
    if (scope.kind === 'collection') {
      return `${teamId}:${String(datasetId)}:collection:${scope.collectionId ?? ''}:delete`;
    }
    if (scope.kind === 'data') {
      return `${teamId}:${String(datasetId)}:data:${scope.dataId ?? ''}:delete`;
    }
    return buildDeleteJobId(teamId, String(datasetId));
  }

  private async collectDataIds(
    filter: Record<string, unknown>,
    session: ClientSession,
  ): Promise<string[]> {
    const rows = (await this.datas
      .find(filter)
      .select('_id')
      .session(session)
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;
    return rows.map((row) => String(row._id));
  }

  private async collectObjectRefs(
    filter: { teamId: Types.ObjectId; datasetId: Types.ObjectId },
    session: ClientSession,
  ): Promise<ObjectRef[]> {
    const docs = (await this.imageAssets
      .find(filter)
      .session(session)
      .lean()) as unknown as ImageAssetDoc[];
    return docs.map((doc) => ({ bucket: '', key: doc.objectKey }));
  }

  private async cleanupDerivedTables(
    scope: DeleteScope,
    filter: { teamId: Types.ObjectId; datasetId: Types.ObjectId },
    session: ClientSession,
    requestId: string,
  ): Promise<void> {
    const { teamId, datasetId } = filter;
    if (scope.kind === 'dataset') {
      await this.collections.deleteMany({ teamId, datasetId }, { session });
      await this.datas.deleteMany({ teamId, datasetId }, { session });
      await this.texts.deleteMany({ teamId, datasetId }, { session });
      await this.trainings.deleteMany({ teamId, datasetId }, { session });
      await this.acls.deleteMany(
        { teamId, resourceType: 'dataset', resourceId: datasetId },
        { session },
      );
      return;
    }
    if (scope.kind === 'collection') {
      const collectionId = toOid(scope.collectionId ?? '', 'collectionId', requestId);
      await this.collections.deleteMany({ teamId, datasetId, _id: collectionId }, { session });
      await this.datas.deleteMany({ teamId, datasetId, collectionId }, { session });
      await this.texts.deleteMany({ teamId, datasetId, collectionId }, { session });
      await this.trainings.deleteMany({ teamId, datasetId, collectionId }, { session });
      return;
    }
    const dataId = toOid(scope.dataId ?? '', 'dataId', requestId);
    await this.datas.deleteMany({ teamId, datasetId, _id: dataId }, { session });
    await this.texts.deleteMany({ teamId, datasetId, dataId }, { session });
    await this.trainings.deleteMany(
      { teamId, datasetId, dataId: { $in: [dataId, String(dataId)] } },
      { session },
    );
  }

  private async prepareCrossStoreOperations(
    input: {
      teamId: Types.ObjectId;
      datasetId: string;
      version: number;
      vectorDataIds: string[];
      objectRefs: ObjectRef[];
    },
    session: ClientSession,
    now: Date,
  ): Promise<void> {
    const upsert = async (
      operationId: string,
      operation: string,
      stage: string,
      resourceRef: { resourceType: string; resourceId: string; version: number },
    ): Promise<void> => {
      await this.operations.updateOne(
        {
          teamId: input.teamId,
          operation,
          'resourceRef.resourceType': resourceRef.resourceType,
          'resourceRef.resourceId': resourceRef.resourceId,
          'resourceRef.version': resourceRef.version,
        },
        {
          $setOnInsert: {
            operationId,
            teamId: input.teamId,
            resourceRef,
            operation,
            stage,
            attempt: 0,
            error: null,
            leaseOwner: null,
            leaseExpireAt: null,
            nextAttemptAt: now,
            createTime: now,
            updateTime: now,
          },
        },
        { upsert: true, session },
      );
    };

    for (const dataId of input.vectorDataIds) {
      await upsert(
        `delete-vector:${String(input.teamId)}:${input.datasetId}:${dataId}:${input.version}`,
        'delete_vector',
        'prepared',
        { resourceType: 'data', resourceId: dataId, version: input.version },
      );
    }
    for (const ref of input.objectRefs) {
      await upsert(
        `delete-s3:${String(input.teamId)}:${objectKeyHash(ref.key)}:${input.version}`,
        'delete_s3',
        'prepared',
        { resourceType: 'object', resourceId: ref.key, version: input.version },
      );
    }
    await upsert(
      `switch-ref:${String(input.teamId)}:${input.datasetId}:${input.version}`,
      'switch_ref',
      'mongo_committed',
      { resourceType: 'dataset', resourceId: input.datasetId, version: input.version },
    );
  }
}
