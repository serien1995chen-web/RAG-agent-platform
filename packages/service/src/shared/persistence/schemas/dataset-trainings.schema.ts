import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.7 dataset_trainings 字段字典。 */
export interface DatasetTrainingDoc {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  collectionId: Types.ObjectId;
  dataId: Types.ObjectId | string | null;
  mode: string;
  retryCount: number;
  lockTime: Date;
  errorMsg: string | null;
  weight: number;
  expireAt: Date;
  billId: string | null;
  payload: Record<string, unknown>;
  imageDescMap: Record<string, unknown> | null;
  indexes: Record<string, unknown>[];
  createTime: Date;
  updateTime: Date;
}

const EPOCH_LOCK_TIME = new Date('2000-01-01T00:00:00.000Z');

export const DatasetTrainingSchema = new Schema<DatasetTrainingDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    collectionId: { type: Schema.Types.ObjectId, required: true },
    dataId: { type: Schema.Types.Mixed, default: null },
    mode: {
      type: String,
      enum: ['parse', 'chunk', 'qa', 'image', 'imageParse'],
      required: true,
    },
    retryCount: { type: Number, default: 5, required: true },
    lockTime: { type: Date, default: () => EPOCH_LOCK_TIME, required: true },
    errorMsg: { type: String, default: null },
    weight: { type: Number, default: 0, required: true },
    expireAt: { type: Date, required: true },
    billId: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    imageDescMap: { type: Schema.Types.Mixed, default: null },
    indexes: { type: Schema.Types.Mixed, default: [] },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_trainings', versionKey: false },
);

defineIndex(DatasetTrainingSchema, {
  name: 'ds_dataset_trainings_claim_idx',
  key: { mode: 1, retryCount: 1, lockTime: 1, weight: 1, teamId: 1 },
});
defineIndex(DatasetTrainingSchema, {
  name: 'ds_dataset_trainings_scope_idx',
  key: { teamId: 1, datasetId: 1, collectionId: 1 },
});
// 设计文档 ADR-012：Training TTL 7 天，成功任务删除、不写 completed。
defineIndex(DatasetTrainingSchema, {
  name: 'ds_dataset_trainings_expire_ttl_idx',
  key: { expireAt: 1 },
  options: { expireAfterSeconds: 604800 },
});
