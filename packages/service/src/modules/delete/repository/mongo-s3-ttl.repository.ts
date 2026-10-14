import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import {
  DatasetDataSchema,
  DatasetSchema,
  ImageAssetSchema,
  S3TtlRecordSchema,
  type DatasetDataDoc,
  type DatasetDoc,
  type ImageAssetDoc,
  type S3TtlRecordDoc,
} from '../../../shared/persistence/schemas';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_TTL_ATTEMPTS = 10;

export interface S3TtlClaimedRecord {
  id: string;
  teamId: string;
  bucketName: string;
  objectKey: string;
  expireAt: Date;
  attempt: number;
  operationId: string;
  resourceRef: { resourceType: string; resourceId: string; version: number };
}

type S3TtlRecordLean = S3TtlRecordDoc & { _id: Types.ObjectId };

function toOid(value: string, field: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId: 's3-ttl',
        params: { resourceType: field, resourceId: value },
      }),
    );
  }
  return new Types.ObjectId(value);
}

/**
 * S3 TTL 记录仓储（E2）：claim 使用 5 分钟容差与 attempt<10 过滤；
 * 写操作含 teamId 谓词；backfill 幂等（operationId 唯一）。
 */
export class MongoS3TtlRepository {
  private readonly model: Model<S3TtlRecordDoc>;
  private readonly imageAssets: Model<ImageAssetDoc>;
  private readonly datas: Model<DatasetDataDoc>;
  private readonly datasets: Model<DatasetDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.S3TtlRecord as Model<S3TtlRecordDoc>) ??
      connection.model<S3TtlRecordDoc>('S3TtlRecord', S3TtlRecordSchema);
    this.imageAssets =
      (connection.models.ImageAsset as Model<ImageAssetDoc>) ??
      connection.model<ImageAssetDoc>('ImageAsset', ImageAssetSchema);
    this.datas =
      (connection.models.DatasetData as Model<DatasetDataDoc>) ??
      connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
    this.datasets =
      (connection.models.Dataset as Model<DatasetDoc>) ??
      connection.model<DatasetDoc>('Dataset', DatasetSchema);
  }

  /**
   * 批量领取：state in [pending,failed]、expireAt <= now-5min、nextAttemptAt <= now、attempt<10；
   * 先按 expireAt 排序查询，再按 _id+state 原子 CAS 置 deleting。
   */
  async claimBatch(input: { now: Date; limit: number }): Promise<S3TtlClaimedRecord[]> {
    const threshold = new Date(input.now.getTime() - FIVE_MINUTES_MS);
    const candidates = (await this.model
      .find({
        state: { $in: ['pending', 'failed'] },
        expireAt: { $lte: threshold },
        nextAttemptAt: { $lte: input.now },
        attempt: { $lt: MAX_TTL_ATTEMPTS },
      })
      .sort({ expireAt: 1 })
      .limit(input.limit)
      .lean()) as unknown as S3TtlRecordLean[];

    const claimed: S3TtlClaimedRecord[] = [];
    for (const candidate of candidates) {
      const doc = (await this.model
        .findOneAndUpdate(
          {
            _id: candidate._id,
            state: candidate.state,
            attempt: candidate.attempt,
            expireAt: { $lte: threshold },
            nextAttemptAt: { $lte: input.now },
          },
          { $set: { state: 'deleting', updateTime: input.now } },
          { new: true },
        )
        .lean()) as unknown as S3TtlRecordLean | null;
      if (!doc) continue;
      claimed.push({
        id: String(doc._id),
        teamId: String(doc.teamId),
        bucketName: doc.bucketName,
        objectKey: doc.objectKey,
        expireAt: doc.expireAt,
        attempt: doc.attempt,
        operationId: doc.operationId,
        resourceRef: {
          resourceType: doc.resourceRef.resourceType,
          resourceId: doc.resourceRef.resourceId,
          version: doc.resourceRef.version,
        },
      });
    }
    return claimed;
  }

  /** 失败写回：state=failed + attempt/nextAttemptAt 更新（teamId 强制）。 */
  async markFailed(input: {
    id: string;
    teamId: string;
    attempt: number;
    nextAttemptAt: Date;
    now?: Date;
  }): Promise<boolean> {
    const updated = await this.model.findOneAndUpdate(
      { _id: toOid(input.id, 'id'), teamId: toOid(input.teamId, 'teamId') },
      {
        $set: {
          state: 'failed',
          attempt: input.attempt,
          nextAttemptAt: input.nextAttemptAt,
          updateTime: input.now ?? new Date(),
        },
      },
    );
    return Boolean(updated);
  }

  /** 删除 TTL 记录（对象删除成功后；teamId 强制）。 */
  async deleteRecord(input: { id: string; teamId: string }): Promise<boolean> {
    const result = await this.model.deleteOne({
      _id: toOid(input.id, 'id'),
      teamId: toOid(input.teamId, 'teamId'),
    });
    return (result.deletedCount ?? 0) > 0;
  }

  /** 补写 TTL 记录（幂等 upsert：operationId 或 bucketName+objectKey 命中即不新增）。 */
  async backfill(input: {
    teamId: string;
    bucketName: string;
    objectKey: string;
    expireAt: Date;
    operationId: string;
    resourceRef: { resourceType: string; resourceId: string; version: number };
  }): Promise<void> {
    const teamId = toOid(input.teamId, 'teamId');
    const now = new Date();
    await this.model.updateOne(
      {
        $or: [
          { operationId: input.operationId },
          { bucketName: input.bucketName, objectKey: input.objectKey },
        ],
      },
      {
        $setOnInsert: {
          teamId,
          bucketName: input.bucketName,
          objectKey: input.objectKey,
          expireAt: input.expireAt,
          state: 'pending',
          attempt: 0,
          nextAttemptAt: now,
          resourceRef: input.resourceRef,
          operationId: input.operationId,
          createTime: now,
          updateTime: now,
        },
      },
      { upsert: true },
    );
  }

  async countByState(input: { state: string; teamId?: string }): Promise<number> {
    return this.model.countDocuments({
      state: input.state,
      ...(input.teamId !== undefined && input.teamId !== ''
        ? { teamId: toOid(input.teamId, 'teamId') }
        : {}),
    });
  }

  /**
   * 正式引用核对：image_assets referenced/persistent 或 dataset_datas.imageId 引用；
   * dataset/{datasetId}/ 前缀 key 先核对 dataset 归属，无法证明归属时按 fail-safe 返回 true。
   */
  async hasFormalReference(input: {
    teamId: string;
    objectKey: string;
    datasetId?: string;
  }): Promise<boolean> {
    const teamId = toOid(input.teamId, 'teamId');
    const segments = input.objectKey.split('/');
    if (segments[0] === 'dataset' && segments[1] !== undefined && segments[1] !== '') {
      if (!Types.ObjectId.isValid(segments[1])) return true;
      const owned = await this.datasets.exists({
        _id: new Types.ObjectId(segments[1]),
        teamId,
      });
      if (!owned) return true;
    }
    const asset = (await this.imageAssets
      .findOne({ teamId, objectKey: input.objectKey })
      .lean()) as unknown as ImageAssetDoc | null;
    if (!asset) return false;
    if (asset.persistent || asset.state === 'referenced') return true;
    const referenced = await this.datas.exists({ teamId, imageId: asset.imageId });
    return Boolean(referenced);
  }

  /** TTL 记录存在性（注册/补写前查重）。 */
  async hasTtlRecord(input: { bucketName: string; objectKey: string }): Promise<boolean> {
    const exists = await this.model.exists(input);
    return Boolean(exists);
  }

  /** dataset/{datasetId}/ 前缀的 teamId 解析（dataset 行缺失返回 null）。 */
  async resolveDatasetTeamId(datasetId: string): Promise<string | null> {
    if (!Types.ObjectId.isValid(datasetId)) return null;
    const doc = (await this.datasets
      .findOne({ _id: new Types.ObjectId(datasetId) })
      .select('teamId')
      .lean()) as unknown as { teamId: Types.ObjectId } | null;
    return doc ? String(doc.teamId) : null;
  }
}
