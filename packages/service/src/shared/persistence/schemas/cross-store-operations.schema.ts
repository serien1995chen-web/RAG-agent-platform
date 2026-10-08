import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.12 cross_store_operations 字段字典（跨存储补偿状态机）。 */
export interface CrossStoreResourceRefValue {
  resourceType: string;
  resourceId: string;
  version: number;
}

export interface CrossStoreOperationDoc {
  operationId: string;
  teamId: Types.ObjectId;
  resourceRef: CrossStoreResourceRefValue;
  operation: string;
  stage: string;
  attempt: number;
  error: Record<string, unknown> | null;
  leaseOwner: string | null;
  leaseExpireAt: Date | null;
  nextAttemptAt: Date;
  createTime: Date;
  updateTime: Date;
}

const ResourceRefSchema = new Schema<CrossStoreResourceRefValue>(
  {
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    version: { type: Number, required: true },
  },
  { _id: false },
);

export const CrossStoreOperationSchema = new Schema<CrossStoreOperationDoc>(
  {
    operationId: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, required: true },
    resourceRef: { type: ResourceRefSchema, required: true },
    operation: {
      type: String,
      enum: ['write_vector', 'delete_vector', 'delete_s3', 'switch_ref'],
      required: true,
    },
    stage: {
      type: String,
      enum: [
        'prepared',
        'vector_written',
        'mongo_committed',
        'projection_pending',
        'cleaned',
        'failed',
      ],
      required: true,
    },
    attempt: { type: Number, default: 0, required: true },
    error: { type: Schema.Types.Mixed, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpireAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: () => new Date(), required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'cross_store_operations', versionKey: false },
);

defineIndex(CrossStoreOperationSchema, {
  name: 'ds_cross_store_operations_team_operation_unique',
  key: {
    teamId: 1,
    operation: 1,
    'resourceRef.resourceType': 1,
    'resourceRef.resourceId': 1,
    'resourceRef.version': 1,
  },
  options: { unique: true },
});
defineIndex(CrossStoreOperationSchema, {
  name: 'ds_cross_store_operations_stage_next_idx',
  key: { stage: 1, nextAttemptAt: 1 },
});
defineIndex(CrossStoreOperationSchema, {
  name: 'ds_cross_store_operations_team_create_idx',
  key: { teamId: 1, createTime: -1 },
});
