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
  S3TtlRecordSchema,
  type CrossStoreOperationDoc,
  type DatasetAclDoc,
  type DatasetCollectionDoc,
  type DatasetDataDoc,
  type DatasetDataTextDoc,
  type DatasetDeleteJobDoc,
  type DatasetDoc,
  type DatasetTrainingDoc,
  type ImageAssetDoc,
  type S3TtlRecordDoc,
} from '../../../shared/persistence/schemas';

/** 删除范围（dataset/collection/data 三类入口）。 */
export type DeleteScopeKind = 'dataset' | 'collection' | 'data';

export interface DeleteScope {
  kind: DeleteScopeKind;
  /** 对账扫描的显式租户范围；缺省表示 Root/global 扫描。 */
  teamId?: string;
  datasetId?: string;
  collectionId?: string;
  dataId?: string;
}

export interface ExecuteDeleteTransactionInput {
  scope: DeleteScope;
  expectedVersion?: number;
  /** 服务层已按冻结格式算出的稳定 jobId；collection/data 范围缺省时由本仓储补齐格式。 */
  jobId?: string;
  ownerTmbId?: string;
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

export interface ReconcileVectorCandidates {
  datasets: Array<{ datasetId: string; teamId: string }>;
  liveDataIds: string[];
  liveDatasetIds: string[];
  liveCollectionIds: string[];
}

export interface ReconcileWindow {
  start: Date;
  end: Date;
}

const MAX_RECONCILE_SCAN = 5000;

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
  private readonly ttlRecords: Model<S3TtlRecordDoc>;

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
    this.ttlRecords =
      (connection.models.S3TtlRecord as Model<S3TtlRecordDoc>) ??
      connection.model<S3TtlRecordDoc>('S3TtlRecord', S3TtlRecordSchema);
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
      const objectRefs = await this.collectObjectRefs(
        input.scope,
        { teamId, datasetId },
        session,
        requestId,
      );

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
            actorTmbId: toOid(context.tenant.tmbId, 'tmbId', requestId),
            ownerTmbId: input.ownerTmbId ? toOid(input.ownerTmbId, 'ownerTmbId', requestId) : null,
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

  // -------------------------------------------------------------------------
  // P6-03 对账扫描与清理（E2）：只返回 id/hash 级字段，不读取正文。
  // -------------------------------------------------------------------------

  /** 向量候选判定所需的存活参照（dataset/collection/data 仅 id）。 */
  async scanVectorCandidates(
    scope: DeleteScope,
    window: ReconcileWindow,
  ): Promise<ReconcileVectorCandidates> {
    void window;
    const teamFilter = this.scanTeamFilter(scope);
    const datasetFilter: Record<string, unknown> = { ...teamFilter };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      datasetFilter._id = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    const datasetRows = (await this.datasets
      .find(datasetFilter)
      .select('_id teamId deleteTime')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      teamId: Types.ObjectId;
      deleteTime: Date | null;
    }>;

    const collectionFilter: Record<string, unknown> = { ...teamFilter };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      collectionFilter.datasetId = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    if (scope.collectionId !== undefined && scope.collectionId !== '') {
      collectionFilter._id = toOid(scope.collectionId, 'collectionId', 'reconcile');
    }
    const collectionRows = (await this.collections
      .find(collectionFilter)
      .select('_id')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;

    const dataFilter: Record<string, unknown> = { ...teamFilter };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      dataFilter.datasetId = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    if (scope.collectionId !== undefined && scope.collectionId !== '') {
      dataFilter.collectionId = toOid(scope.collectionId, 'collectionId', 'reconcile');
    }
    if (scope.dataId !== undefined && scope.dataId !== '') {
      dataFilter._id = toOid(scope.dataId, 'dataId', 'reconcile');
    }
    const dataRows = (await this.datas
      .find(dataFilter)
      .select('_id')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;

    return {
      datasets: datasetRows.map((row) => ({
        datasetId: String(row._id),
        teamId: String(row.teamId),
      })),
      liveDataIds: dataRows.map((row) => String(row._id)),
      liveDatasetIds: datasetRows
        .filter((row) => row.deleteTime === null)
        .map((row) => String(row._id)),
      liveCollectionIds: collectionRows.map((row) => String(row._id)),
    };
  }

  /** 全文孤儿候选（dataset_data_texts 行，仅 id 字段；窗口按 createTime 上界）。 */
  async scanFulltextCandidates(
    scope: DeleteScope,
    window: ReconcileWindow,
  ): Promise<Array<{ teamId: string; dataId: string; datasetId: string; collectionId: string }>> {
    const filter: Record<string, unknown> = {
      ...this.scanTeamFilter(scope),
      createTime: { $lte: window.end },
    };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      filter.datasetId = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    if (scope.collectionId !== undefined && scope.collectionId !== '') {
      filter.collectionId = toOid(scope.collectionId, 'collectionId', 'reconcile');
    }
    if (scope.dataId !== undefined && scope.dataId !== '') {
      filter.dataId = toOid(scope.dataId, 'dataId', 'reconcile');
    }
    const rows = (await this.texts
      .find(filter)
      .select('teamId dataId datasetId collectionId')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      teamId: Types.ObjectId;
      dataId: Types.ObjectId;
      datasetId: Types.ObjectId;
      collectionId: Types.ObjectId;
    }>;
    return rows.map((row) => ({
      teamId: String(row.teamId),
      dataId: String(row.dataId),
      datasetId: String(row.datasetId),
      collectionId: String(row.collectionId),
    }));
  }

  /** ACL 孤儿：指向已删除 Dataset 的 ACL 行（仅 id）。 */
  async scanAclOrphans(
    scope: DeleteScope,
  ): Promise<Array<{ id: string; teamId: string; resourceId: string }>> {
    const deletedFilter: Record<string, unknown> = {
      ...this.scanTeamFilter(scope),
      deleteTime: { $ne: null },
    };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      deletedFilter._id = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    const deleted = (await this.datasets
      .find(deletedFilter)
      .select('_id teamId')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{ _id: Types.ObjectId; teamId: Types.ObjectId }>;
    const orphans: Array<{ id: string; teamId: string; resourceId: string }> = [];
    for (const dataset of deleted) {
      const rows = (await this.acls
        .find({
          teamId: dataset.teamId,
          resourceType: 'dataset',
          resourceId: dataset._id,
        })
        .select('_id')
        .limit(MAX_RECONCILE_SCAN)
        .lean()) as unknown as Array<{ _id: Types.ObjectId }>;
      for (const row of rows) {
        orphans.push({
          id: String(row._id),
          teamId: String(dataset.teamId),
          resourceId: String(dataset._id),
        });
      }
    }
    return orphans;
  }

  /** Training 孤儿：指向已删除/不存在 Dataset 或 Collection 的 Training 行（仅 id）。 */
  async scanTrainingOrphans(
    scope: DeleteScope,
  ): Promise<Array<{ id: string; teamId: string; datasetId: string; collectionId: string }>> {
    const teamFilter = this.scanTeamFilter(scope);
    const datasetRows = (await this.datasets
      .find(teamFilter)
      .select('_id teamId deleteTime')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      teamId: Types.ObjectId;
      deleteTime: Date | null;
    }>;
    const liveDatasetIds = new Set(
      datasetRows.filter((row) => row.deleteTime === null).map((row) => String(row._id)),
    );
    const collectionRows = (await this.collections
      .find(teamFilter)
      .select('_id')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{ _id: Types.ObjectId }>;
    const liveCollectionIds = new Set(collectionRows.map((row) => String(row._id)));

    const trainingFilter: Record<string, unknown> = { ...teamFilter };
    if (scope.datasetId !== undefined && scope.datasetId !== '') {
      trainingFilter.datasetId = toOid(scope.datasetId, 'datasetId', 'reconcile');
    }
    if (scope.collectionId !== undefined && scope.collectionId !== '') {
      trainingFilter.collectionId = toOid(scope.collectionId, 'collectionId', 'reconcile');
    }
    const rows = (await this.trainings
      .find(trainingFilter)
      .select('_id teamId datasetId collectionId')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      _id: Types.ObjectId;
      teamId: Types.ObjectId;
      datasetId: Types.ObjectId;
      collectionId: Types.ObjectId;
    }>;
    return rows
      .filter(
        (row) =>
          !liveDatasetIds.has(String(row.datasetId)) ||
          !liveCollectionIds.has(String(row.collectionId)),
      )
      .map((row) => ({
        id: String(row._id),
        teamId: String(row.teamId),
        datasetId: String(row.datasetId),
        collectionId: String(row.collectionId),
      }));
  }

  /** 卡住删除任务：state=deleting 且租约过期超过一个窗口。 */
  async scanStuckDeleteJobs(
    now: Date,
    windowMs: number,
    teamId?: string,
  ): Promise<Array<{ jobId: string; teamId: string; attempt: number }>> {
    const staleAt = new Date(now.getTime() - windowMs);
    const filter: Record<string, unknown> = {
      $or: [
        { state: 'deleting', leaseExpireAt: { $lte: staleAt } },
        { state: 'queued', updateTime: { $lte: staleAt } },
      ],
      attempt: { $lt: 10 },
      ...(teamId !== undefined && teamId !== ''
        ? { teamId: toOid(teamId, 'teamId', 'reconcile') }
        : {}),
    };
    const rows = (await this.jobs
      .find(filter)
      .select('jobId teamId attempt')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      jobId: string;
      teamId: Types.ObjectId;
      attempt: number;
    }>;
    return rows.map((row) => ({
      jobId: row.jobId,
      teamId: String(row.teamId),
      attempt: row.attempt,
    }));
  }

  /** 跨存储失败超限（stage=failed 且 attempt≥10）——schema 无 job/dataset 外键，按团队范围收敛。 */
  async scanFailedCrossStoreOps(
    scope: DeleteScope,
  ): Promise<Array<{ operationId: string; operation: string; attempt: number }>> {
    const rows = (await this.operations
      .find({
        ...this.scanTeamFilter(scope),
        operation: { $in: ['delete_vector', 'delete_s3', 'switch_ref'] },
        stage: 'failed',
        attempt: { $gte: 10 },
      })
      .select('operationId operation attempt')
      .limit(MAX_RECONCILE_SCAN)
      .lean()) as unknown as Array<{
      operationId: string;
      operation: string;
      attempt: number;
    }>;
    return rows.map((row) => ({
      operationId: row.operationId,
      operation: row.operation,
      attempt: row.attempt,
    }));
  }

  /** TTL 记录存在性（teamId 缺省时按显式 Root 范围查询）。 */
  async hasTtlRecord(input: { teamId?: string; objectKey: string }): Promise<boolean> {
    const exists = await this.ttlRecords.exists({
      ...(input.teamId !== undefined && input.teamId !== ''
        ? { teamId: toOid(input.teamId, 'teamId', 'reconcile') }
        : {}),
      objectKey: input.objectKey,
    });
    return Boolean(exists);
  }

  /** 按显式 id 集合 + teamId 清理 ACL 行（仅可证明孤儿调用）。 */
  async deleteAclRows(ids: string[], teamId: string): Promise<number> {
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return 0;
    const result = await this.acls.deleteMany({
      _id: { $in: objectIds },
      teamId: toOid(teamId, 'teamId', 'reconcile'),
    });
    return result.deletedCount ?? 0;
  }

  /** 按显式 id 集合 + teamId 清理 Training 行（仅可证明孤儿调用）。 */
  async deleteTrainingRows(ids: string[], teamId: string): Promise<number> {
    const objectIds = ids
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return 0;
    const result = await this.trainings.deleteMany({
      _id: { $in: objectIds },
      teamId: toOid(teamId, 'teamId', 'reconcile'),
    });
    return result.deletedCount ?? 0;
  }

  /** 卡住任务重排：attempt<10 时 deleting/failed→queued 且 attempt+1；超限返回 manual_review。 */
  async requeueStuckJob(jobId: string, teamId: string): Promise<string> {
    const updated = await this.jobs.findOneAndUpdate(
      {
        teamId: toOid(teamId, 'teamId', 'reconcile'),
        jobId,
        state: { $in: ['deleting', 'failed', 'queued'] },
        attempt: { $lt: 10 },
      },
      {
        $set: {
          state: 'queued',
          leaseOwner: null,
          leaseExpireAt: null,
          updateTime: new Date(),
        },
        $inc: { attempt: 1 },
      },
      { new: true },
    );
    return updated ? jobId : 'manual_review';
  }

  private scanTeamFilter(scope: DeleteScope): Record<string, unknown> {
    if (scope.teamId === undefined || scope.teamId === '') return {};
    return { teamId: toOid(scope.teamId, 'teamId', 'reconcile') };
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
    scope: DeleteScope,
    filter: { teamId: Types.ObjectId; datasetId: Types.ObjectId },
    session: ClientSession,
    requestId: string,
  ): Promise<ObjectRef[]> {
    const assetFilter: Record<string, unknown> = {
      teamId: filter.teamId,
      datasetId: filter.datasetId,
    };
    if (scope.kind === 'collection') {
      const collectionId = toOid(scope.collectionId ?? '', 'collectionId', requestId);
      const dataRows = (await this.datas
        .find({ teamId: filter.teamId, datasetId: filter.datasetId, collectionId })
        .select('imageId')
        .session(session)
        .lean()) as unknown as Array<{ imageId: string | null }>;
      const imageIds = dataRows
        .map((row) => row.imageId)
        .filter((imageId): imageId is string => imageId !== null && imageId !== '');
      assetFilter.$or = [
        { collectionId },
        ...(imageIds.length > 0 ? [{ imageId: { $in: imageIds } }] : []),
      ];
    }
    if (scope.kind === 'data') {
      const dataRows = (await this.datas
        .find({
          teamId: filter.teamId,
          datasetId: filter.datasetId,
          _id: toOid(scope.dataId ?? '', 'dataId', requestId),
        })
        .select('imageId')
        .session(session)
        .lean()) as unknown as Array<{ imageId: string | null }>;
      const imageIds = dataRows
        .map((row) => row.imageId)
        .filter((imageId): imageId is string => imageId !== null && imageId !== '');
      if (imageIds.length === 0) return [];
      assetFilter.imageId = { $in: imageIds };
    }
    const docs = (await this.imageAssets
      .find(assetFilter)
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
