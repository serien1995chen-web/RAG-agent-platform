import { Types, type Connection, type Model } from "mongoose";
import {
  ImageAssetSchema,
  S3TtlRecordSchema,
  type ImageAssetDoc,
  type S3TtlRecordDoc,
} from "../../../shared/persistence/schemas";
import type { RequestContext } from "../../../ports/types";

export type ImageAssetState = "temporary" | "referenced" | "deleting" | "deleted" | "failed";

export interface ImageAssetRecord {
  imageId: string;
  teamId: string;
  datasetId: string;
  collectionId: string | null;
  objectKey: string;
  mimeType: string;
  size: number;
  ttlExpireAt: Date | null;
  persistent: boolean;
  state: ImageAssetState;
}

export interface CreateTemporaryInput {
  imageId: string;
  datasetId: string;
  collectionId?: string | null;
  objectKey: string;
  bucketName: string;
  mimeType: string;
  size: number;
  ttlMs?: number;
  operationId: string;
}

export const DEFAULT_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toOid(value: string, field: string, context: RequestContext): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    const error = new Error("invalid_object_id:" + field) as Error & { code?: string };
    error.code = "501070";
    void context;
    throw error;
  }
  return new Types.ObjectId(value);
}

function toRecord(doc: ImageAssetDoc): ImageAssetRecord {
  return {
    imageId: doc.imageId,
    teamId: String(doc.teamId),
    datasetId: String(doc.datasetId),
    collectionId: doc.collectionId ? String(doc.collectionId) : null,
    objectKey: doc.objectKey,
    mimeType: doc.mimeType,
    size: doc.size,
    ttlExpireAt: doc.ttlExpireAt,
    persistent: doc.persistent,
    state: doc.state,
  };
}

/** 设计文档 10.9：image_assets 与 s3_ttl_records 的租户作用域读写，全部查询带 teamId。 */
export class MongoImageAssetRepository {
  private readonly imageModel: Model<ImageAssetDoc>;
  private readonly ttlModel: Model<S3TtlRecordDoc>;

  constructor(private readonly connection: Connection) {
    this.imageModel =
      (connection.models.ImageAsset as Model<ImageAssetDoc>) ??
      connection.model<ImageAssetDoc>("ImageAsset", ImageAssetSchema);
    this.ttlModel =
      (connection.models.S3TtlRecord as Model<S3TtlRecordDoc>) ??
      connection.model<S3TtlRecordDoc>("S3TtlRecord", S3TtlRecordSchema);
  }

  async createTemporary(input: CreateTemporaryInput, context: RequestContext): Promise<ImageAssetRecord> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const datasetId = toOid(input.datasetId, "datasetId", context);
    const collectionId = input.collectionId ? toOid(input.collectionId, "collectionId", context) : null;
    const now = new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_IMAGE_TTL_MS;
    const ttlExpireAt = new Date(now.getTime() + ttlMs);
    const doc = await this.imageModel.findOneAndUpdate(
      { teamId, imageId: input.imageId },
      {
        $setOnInsert: {
          imageId: input.imageId,
          teamId,
          datasetId,
          collectionId,
          objectKey: input.objectKey,
          mimeType: input.mimeType,
          size: input.size,
          ttlExpireAt,
          persistent: false,
          state: "temporary",
          createTime: now,
        },
        $set: { updateTime: now },
      },
      { upsert: true, new: true },
    );
    await this.registerTtl(
      {
        bucketName: input.bucketName,
        objectKey: input.objectKey,
        expireAt: ttlExpireAt,
        operationId: input.operationId,
        datasetId: input.datasetId,
      },
      context,
    );
    return toRecord(doc);
  }

  async findById(imageId: string, context: RequestContext): Promise<ImageAssetRecord | null> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const doc = await this.imageModel.findOne({ teamId, imageId }).lean<ImageAssetDoc | null>();
    return doc ? toRecord(doc) : null;
  }

  async promoteToReferenced(
    imageId: string,
    collectionId: string,
    context: RequestContext,
  ): Promise<ImageAssetRecord | null> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const collection = toOid(collectionId, "collectionId", context);
    const doc = await this.imageModel
      .findOneAndUpdate(
        { teamId, imageId },
        {
          $set: {
            state: "referenced",
            persistent: true,
            ttlExpireAt: null,
            collectionId: collection,
            updateTime: new Date(),
          },
        },
        { new: true },
      )
      .lean<ImageAssetDoc | null>();
    if (!doc) return null;
    await this.deleteTtl({ objectKey: doc.objectKey }, context);
    return toRecord(doc);
  }

  async markFailed(imageId: string, reason: string, context: RequestContext): Promise<void> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    await this.imageModel.updateOne(
      { teamId, imageId },
      { $set: { state: "failed", updateTime: new Date(), errorMsg: reason } },
    );
  }

  async purge(imageId: string, context: RequestContext): Promise<{ deleted: boolean }> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const doc = await this.imageModel
      .findOneAndUpdate(
        { teamId, imageId },
        { $set: { state: "deleted", persistent: false, ttlExpireAt: null, updateTime: new Date() } },
        { new: true },
      )
      .lean<ImageAssetDoc | null>();
    if (!doc) return { deleted: false };
    await this.deleteTtl({ objectKey: doc.objectKey }, context);
    return { deleted: true };
  }

  async registerTtl(
    input: {
      bucketName: string;
      objectKey: string;
      expireAt: Date;
      operationId: string;
      datasetId: string;
      resourceType?: string;
      resourceId?: string;
    },
    context: RequestContext,
  ): Promise<void> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const now = new Date();
    await this.ttlModel.updateOne(
      { bucketName: input.bucketName, objectKey: input.objectKey },
      {
        $setOnInsert: {
          teamId,
          bucketName: input.bucketName,
          objectKey: input.objectKey,
          resourceRef: {
            resourceType: input.resourceType ?? "image",
            resourceId: input.resourceId ?? input.objectKey,
            version: 1,
          },
          createTime: now,
        },
        $set: {
          expireAt: input.expireAt,
          state: "pending",
          attempt: 0,
          nextAttemptAt: input.expireAt,
          operationId: input.operationId,
          updateTime: now,
        },
      },
      { upsert: true },
    );
  }

  async deleteTtl(input: { objectKey: string }, context: RequestContext): Promise<{ deleted: number }> {
    const teamId = toOid(context.tenant.teamId, "teamId", context);
    const result = await this.ttlModel.deleteOne({ teamId, objectKey: input.objectKey });
    return { deleted: result.deletedCount ?? 0 };
  }
}

export function createImageAssetRepository(connection?: Connection): MongoImageAssetRepository | null {
  return connection ? new MongoImageAssetRepository(connection) : null;
}
