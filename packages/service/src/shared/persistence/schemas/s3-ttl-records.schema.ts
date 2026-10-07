import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.9.1 s3_ttl_records 字段字典（临时对象 TTL 权威记录）。 */
export interface S3TtlRecordResourceRefValue {
  resourceType: string;
  resourceId: string;
  version: number;
}

export interface S3TtlRecordDoc {
  teamId: Types.ObjectId;
  bucketName: string;
  objectKey: string;
  expireAt: Date;
  state: string;
  attempt: number;
  nextAttemptAt: Date;
  resourceRef: S3TtlRecordResourceRefValue;
  operationId: string;
  createTime: Date;
  updateTime: Date;
}

const ResourceRefSchema = new Schema<S3TtlRecordResourceRefValue>(
  {
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    version: { type: Number, required: true },
  },
  { _id: false },
);

export const S3TtlRecordSchema = new Schema<S3TtlRecordDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    bucketName: { type: String, required: true },
    objectKey: { type: String, required: true },
    expireAt: { type: Date, required: true },
    state: {
      type: String,
      enum: ['pending', 'deleting', 'deleted', 'failed'],
      default: 'pending',
      required: true,
    },
    attempt: { type: Number, default: 0, required: true },
    nextAttemptAt: { type: Date, default: () => new Date(), required: true },
    resourceRef: { type: ResourceRefSchema, required: true },
    operationId: { type: String, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 's3_ttl_records', versionKey: false },
);

defineIndex(S3TtlRecordSchema, {
  name: 'ds_s3_ttl_records_expire_state_idx',
  key: { expireAt: 1, state: 1 },
});
defineIndex(S3TtlRecordSchema, {
  name: 'ds_s3_ttl_records_bucket_object_unique',
  key: { bucketName: 1, objectKey: 1 },
  options: { unique: true },
});
defineIndex(S3TtlRecordSchema, {
  name: 'ds_s3_ttl_records_operation_unique',
  key: { operationId: 1 },
  options: { unique: true },
});
defineIndex(S3TtlRecordSchema, {
  name: 'ds_s3_ttl_records_team_state_idx',
  key: { teamId: 1, state: 1 },
});
