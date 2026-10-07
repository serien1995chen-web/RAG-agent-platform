import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.11 dataset_delete_jobs 字段字典（跨存储删除事实源）。 */
export interface DatasetDeleteJobProgressValue {
  total: number;
  done: number;
  failed: number;
  skipped: number;
}

export interface DatasetDeleteJobDoc {
  jobId: string;
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  state: string;
  stage: string;
  progress: DatasetDeleteJobProgressValue;
  attempt: number;
  error: Record<string, unknown> | null;
  leaseOwner: string | null;
  leaseExpireAt: Date | null;
  createTime: Date;
  updateTime: Date;
}

const ProgressSchema = new Schema<DatasetDeleteJobProgressValue>(
  {
    total: { type: Number, default: 0, required: true },
    done: { type: Number, default: 0, required: true },
    failed: { type: Number, default: 0, required: true },
    skipped: { type: Number, default: 0, required: true },
  },
  { _id: false },
);

export const DatasetDeleteJobSchema = new Schema<DatasetDeleteJobDoc>(
  {
    jobId: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    state: {
      type: String,
      enum: ['marked', 'queued', 'deleting', 'completed', 'failed'],
      required: true,
    },
    stage: { type: String, enum: ['mongo', 'vector', 's3', 'verify'], required: true },
    progress: { type: ProgressSchema, required: true, default: () => ({}) },
    attempt: { type: Number, default: 0, required: true },
    error: { type: Schema.Types.Mixed, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpireAt: { type: Date, default: null },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_delete_jobs', versionKey: false },
);

defineIndex(DatasetDeleteJobSchema, {
  name: 'ds_dataset_delete_jobs_team_job_unique',
  key: { teamId: 1, jobId: 1 },
  options: { unique: true },
});
defineIndex(DatasetDeleteJobSchema, {
  name: 'ds_dataset_delete_jobs_state_update_idx',
  key: { state: 1, updateTime: 1 },
});
defineIndex(DatasetDeleteJobSchema, {
  name: 'ds_dataset_delete_jobs_team_dataset_state_idx',
  key: { teamId: 1, datasetId: 1, state: 1 },
});
