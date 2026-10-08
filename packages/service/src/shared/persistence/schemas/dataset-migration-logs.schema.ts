import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.14 dataset_migration_logs 字段字典（迁移批次日志）。 */
export interface DatasetMigrationLogResourceRefValue {
  resourceType: string;
  resourceId: string;
  version: number;
}

export interface DatasetMigrationLogDoc {
  migrationId: string;
  version: string;
  batchId: string;
  teamId: Types.ObjectId;
  resourceRef: DatasetMigrationLogResourceRefValue;
  dataId: string | null;
  state: string;
  attempts: number;
  operations: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  rollbackInfo: Record<string, unknown> | null;
  createTime: Date;
  updateTime: Date;
}

const ResourceRefSchema = new Schema<DatasetMigrationLogResourceRefValue>(
  {
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    version: { type: Number, required: true },
  },
  { _id: false },
);

export const DatasetMigrationLogSchema = new Schema<DatasetMigrationLogDoc>(
  {
    migrationId: { type: String, required: true },
    version: { type: String, required: true },
    batchId: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, required: true },
    resourceRef: { type: ResourceRefSchema, required: true },
    dataId: { type: String, default: null },
    state: { type: String, required: true },
    attempts: { type: Number, default: 0, required: true },
    operations: { type: Schema.Types.Mixed, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    rollbackInfo: { type: Schema.Types.Mixed, default: null },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_migration_logs', versionKey: false },
);

defineIndex(DatasetMigrationLogSchema, {
  name: 'ds_dataset_migration_logs_batch_idx',
  key: { migrationId: 1, batchId: 1, dataId: 1 },
});
defineIndex(DatasetMigrationLogSchema, {
  name: 'ds_dataset_migration_logs_team_resource_idx',
  key: { teamId: 1, 'resourceRef.resourceId': 1 },
});
defineIndex(DatasetMigrationLogSchema, {
  name: 'ds_dataset_migration_logs_migration_data_unique',
  key: { migrationId: 1, dataId: 1 },
  options: { unique: true, partialFilterExpression: { dataId: { $type: 'string' } } },
});
