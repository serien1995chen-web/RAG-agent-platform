import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../../ports/types';
import {
  CrossStoreOperationSchema,
  ImageAssetSchema,
  type CrossStoreOperationDoc,
  type ImageAssetDoc,
} from '../../../shared/persistence/schemas';

/** 删除域可领取的跨存储操作（write_vector 等非删除域操作不在此列）。 */
export const DELETE_DOMAIN_OPERATIONS = ['delete_vector', 'delete_s3', 'switch_ref'] as const;

const MAX_OPERATION_ATTEMPTS = 10;

export interface CrossStoreOperationView {
  operationId: string;
  teamId: string;
  operation: string;
  stage: string;
  attempt: number;
  resourceRef: { resourceType: string; resourceId: string; version: number };
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpireAt: Date | null;
}

type CrossStoreOperationLean = CrossStoreOperationDoc & { _id: Types.ObjectId };

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

function toView(doc: CrossStoreOperationDoc): CrossStoreOperationView {
  return {
    operationId: doc.operationId,
    teamId: String(doc.teamId),
    operation: doc.operation,
    stage: doc.stage,
    attempt: doc.attempt,
    resourceRef: {
      resourceType: doc.resourceRef.resourceType,
      resourceId: doc.resourceRef.resourceId,
      version: doc.resourceRef.version,
    },
    nextAttemptAt: doc.nextAttemptAt,
    leaseOwner: doc.leaseOwner,
    leaseExpireAt: doc.leaseExpireAt,
  };
}

/**
 * 跨存储操作事实源（E1/E2）：按唯一索引幂等 upsert，领取过期租约，
 * 支撑删除重试（resetNextAttempt）与补偿 Sweeper。
 */
export class MongoCrossStoreOperationRepository {
  private readonly model: Model<CrossStoreOperationDoc>;
  private readonly imageAssets: Model<ImageAssetDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.CrossStoreOperation as Model<CrossStoreOperationDoc>) ??
      connection.model<CrossStoreOperationDoc>('CrossStoreOperation', CrossStoreOperationSchema);
    this.imageAssets =
      (connection.models.ImageAsset as Model<ImageAssetDoc>) ??
      connection.model<ImageAssetDoc>('ImageAsset', ImageAssetSchema);
  }

  /** 幂等申请：同一唯一索引（teamId+operation+resourceRef）重复写入不产生新行。 */
  async prepare(
    input: {
      operationId: string;
      teamId: string;
      resourceRef: { resourceType: string; resourceId: string; version: number };
      operation: string;
      stage: string;
    },
    context: RequestContext,
  ): Promise<CrossStoreOperationView> {
    const teamId = toOid(input.teamId, 'teamId', context.requestId);
    const now = new Date();
    const doc = (await this.model
      .findOneAndUpdate(
        {
          teamId,
          operation: input.operation,
          'resourceRef.resourceType': input.resourceRef.resourceType,
          'resourceRef.resourceId': input.resourceRef.resourceId,
          'resourceRef.version': input.resourceRef.version,
        },
        {
          $setOnInsert: {
            operationId: input.operationId,
            teamId,
            resourceRef: input.resourceRef,
            operation: input.operation,
            stage: input.stage,
            attempt: 0,
            error: null,
            leaseOwner: null,
            leaseExpireAt: null,
            nextAttemptAt: now,
            createTime: now,
            updateTime: now,
          },
        },
        { upsert: true, new: true },
      )
      .lean()) as unknown as CrossStoreOperationDoc;
    return toView(doc);
  }

  /** 阶段写入：按 operationId+teamId 定位；attemptDelta 缺省不动 attempt。 */
  async markStage(
    input: {
      operationId: string;
      stage: string;
      error?: Record<string, unknown> | null;
      attemptDelta?: number;
      now?: Date;
    },
    context: RequestContext,
  ): Promise<boolean> {
    const updated = await this.model.findOneAndUpdate(
      {
        teamId: toOid(context.tenant.teamId, 'teamId', context.requestId),
        operationId: input.operationId,
      },
      {
        $set: {
          stage: input.stage,
          error: input.error ?? null,
          updateTime: input.now ?? new Date(),
        },
        ...(input.attemptDelta !== undefined ? { $inc: { attempt: input.attemptDelta } } : {}),
      },
    );
    return Boolean(updated);
  }

  /**
   * 补偿/重试领取：stage!=cleaned、attempt<10、nextAttemptAt<=now，
   * 且未持有效租约；逐条 CAS 置租约（跨租户 Root 扫描，不按单一 teamId 过滤）。
   */
  async claimExpiredLease(input: {
    now: Date;
    limit: number;
    leaseOwner?: string;
    leaseMs?: number;
  }): Promise<CrossStoreOperationView[]> {
    const leaseOwner = input.leaseOwner ?? `compensation-${input.now.getTime()}`;
    const leaseMs = input.leaseMs ?? 300_000;
    const candidates = (await this.model
      .find({
        operation: { $in: [...DELETE_DOMAIN_OPERATIONS] },
        stage: { $ne: 'cleaned' },
        attempt: { $lt: MAX_OPERATION_ATTEMPTS },
        nextAttemptAt: { $lte: input.now },
        $or: [{ leaseExpireAt: null }, { leaseExpireAt: { $lte: input.now } }],
      })
      .sort({ nextAttemptAt: 1, createTime: 1 })
      .limit(input.limit)
      .lean()) as unknown as CrossStoreOperationLean[];

    const claimed: CrossStoreOperationView[] = [];
    for (const candidate of candidates) {
      const doc = (await this.model
        .findOneAndUpdate(
          {
            _id: candidate._id,
            stage: candidate.stage,
            attempt: candidate.attempt,
            nextAttemptAt: { $lte: input.now },
            $or: [{ leaseExpireAt: null }, { leaseExpireAt: { $lte: input.now } }],
          },
          {
            $set: {
              leaseOwner,
              leaseExpireAt: new Date(input.now.getTime() + leaseMs),
              updateTime: input.now,
            },
          },
          { new: true },
        )
        .lean()) as unknown as CrossStoreOperationDoc | null;
      if (doc) claimed.push(toView(doc));
    }
    return claimed;
  }

  /**
   * 按删除任务列出关联操作：
   * - delete_vector/switch_ref 通过 operationId 中的 datasetId 段匹配（同数据集范围内收敛）；
   * - delete_s3 通过 objectKey 归属（dataset/{datasetId}/ 前缀或 image_assets 关联）过滤，
   *   不使用版本号猜测，避免跨数据集误重排。
   */
  async listByJob(
    input: { teamId: string; jobId: string },
    context: RequestContext,
  ): Promise<CrossStoreOperationView[]> {
    const teamId = toOid(input.teamId, 'teamId', context.requestId);
    const segments = input.jobId.split(':');
    const datasetId = segments[1] ?? '';
    const all = (await this.model
      .find({ teamId, operation: { $in: [...DELETE_DOMAIN_OPERATIONS] } })
      .sort({ createTime: 1 })
      .lean()) as unknown as CrossStoreOperationDoc[];

    const matches: CrossStoreOperationDoc[] = [];
    for (const doc of all) {
      if (doc.operation !== 'delete_s3') {
        const parts = doc.operationId.split(':');
        if (doc.operation === 'delete-vector') {
          // delete-vector:<teamId>:<datasetId>:<resourceId>:<version>
          if (parts[2] === datasetId) matches.push(doc);
          continue;
        }
        // switch-ref:<teamId>:<datasetId>:<version>
        if (parts[2] === datasetId) matches.push(doc);
        continue;
      }
      const key = doc.resourceRef.resourceId;
      if (key.startsWith(`dataset/${datasetId}/`)) {
        matches.push(doc);
        continue;
      }
      const asset = (await this.imageAssets
        .findOne({ teamId, objectKey: key })
        .lean()) as unknown as ImageAssetDoc | null;
      if (asset && String(asset.datasetId) === datasetId) matches.push(doc);
    }
    return matches.map(toView);
  }

  /** 人工重试：把指定 operationIds 的 nextAttemptAt 提前到 now（保留既有 stage）。 */
  async resetNextAttempt(
    input: { operationIds: string[]; now: Date },
    context: RequestContext,
  ): Promise<number> {
    if (input.operationIds.length === 0) return 0;
    const result = await this.model.updateMany(
      {
        teamId: toOid(context.tenant.teamId, 'teamId', context.requestId),
        operationId: { $in: input.operationIds },
      },
      { $set: { nextAttemptAt: input.now, updateTime: new Date() } },
    );
    return result.modifiedCount;
  }
}
