import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.11 dataset_delete_failures 字段字典（删除失败资源明细）。 */
export interface DatasetDeleteFailureDoc {
  teamId: Types.ObjectId;
  jobId: string;
  resourceType: string;
  resourceId: string;
  stage: string;
  attempt: number;
  errorClass: string;
  retryable: boolean;
  lastError: string;
  createTime: Date;
  updateTime: Date;
}

export const DatasetDeleteFailureSchema = new Schema<DatasetDeleteFailureDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    jobId: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    stage: { type: String, required: true },
    attempt: { type: Number, default: 0, required: true },
    errorClass: { type: String, required: true },
    retryable: { type: Boolean, default: false, required: true },
    lastError: { type: String, default: '', required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_delete_failures', versionKey: false },
);

defineIndex(DatasetDeleteFailureSchema, {
  name: 'ds_dataset_delete_failures_resource_idx',
  key: { jobId: 1, resourceType: 1, resourceId: 1, attempt: 1 },
});
defineIndex(DatasetDeleteFailureSchema, {
  name: 'ds_dataset_delete_failures_team_create_idx',
  key: { teamId: 1, createTime: -1 },
});
