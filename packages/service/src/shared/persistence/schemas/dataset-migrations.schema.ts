import { Schema } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.14 dataset_migrations 字段字典（迁移注册表）。 */
export interface DatasetMigrationDoc {
  version: string;
  name: string;
  state: string;
  attempts: number;
  dryRun: boolean;
  resumeToken: Record<string, unknown> | null;
  rollbackInfo: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  scope: Record<string, unknown>;
  writeMode: string;
  estimatedWindow: Record<string, unknown> | null;
  rollbackWindow: Record<string, unknown> | null;
  backupRequired: boolean;
  createdBy: string;
  createTime: Date;
  updateTime: Date;
}

export const DatasetMigrationSchema = new Schema<DatasetMigrationDoc>(
  {
    version: { type: String, required: true },
    name: { type: String, required: true },
    state: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed', 'cancelled'],
      required: true,
    },
    attempts: { type: Number, default: 0, required: true },
    dryRun: { type: Boolean, default: false, required: true },
    resumeToken: { type: Schema.Types.Mixed, default: null },
    rollbackInfo: { type: Schema.Types.Mixed, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    scope: { type: Schema.Types.Mixed, required: true },
    writeMode: { type: String, enum: ['block', 'readonly', 'online'], required: true },
    estimatedWindow: { type: Schema.Types.Mixed, default: null },
    rollbackWindow: { type: Schema.Types.Mixed, default: null },
    backupRequired: { type: Boolean, default: false, required: true },
    createdBy: { type: String, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_migrations', versionKey: false },
);

defineIndex(DatasetMigrationSchema, {
  name: 'ds_dataset_migrations_version_unique',
  key: { version: 1 },
  options: { unique: true },
});
defineIndex(DatasetMigrationSchema, {
  name: 'ds_dataset_migrations_scope_running_unique',
  key: { scope: 1 },
  options: { unique: true, partialFilterExpression: { state: 'running' } },
});
defineIndex(DatasetMigrationSchema, {
  name: 'ds_dataset_migrations_state_update_idx',
  key: { state: 1, updateTime: -1 },
});
defineIndex(DatasetMigrationSchema, {
  name: 'ds_dataset_migrations_scope_version_idx',
  key: { scope: 1, version: 1 },
});
