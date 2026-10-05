import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';
import { ChunkPolicySchema, DEFAULT_CHUNK_POLICY, type ChunkPolicyValue } from './common';

/** 设计文档 10.3 datasets 字段字典。 */
export interface DatasetDoc {
  teamId: Types.ObjectId;
  createdBy: Types.ObjectId;
  parentId: Types.ObjectId | null;
  type: string;
  name: string;
  intro: string;
  avatar: string;
  vectorModel: string;
  indexVersion: string;
  agentModel: string | null;
  vlmModel: string | null;
  chunkPolicy: ChunkPolicyValue;
  apiDatasetConfig: Record<string, unknown> | null;
  inheritPermission: boolean;
  autoSync: boolean;
  deleteTime: Date | null;
  /** 派生 CAS 字段：10.3 未登记 version，但 DatasetUpdateBody 与 Repository 契约要求版本控制。 */
  version: number;
  createTime: Date;
  updateTime: Date;
}

export const DatasetSchema = new Schema<DatasetDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    // websiteDataset 不在枚举内，创建入口必须返回 501001。
    type: {
      type: String,
      enum: ['knowledge', 'folder', 'external', 'api', 'feishu', 'yuque', 'dingtalk'],
      default: 'knowledge',
      required: true,
    },
    name: { type: String, required: true },
    intro: { type: String, default: '' },
    avatar: { type: String, default: '' },
    vectorModel: { type: String, required: true },
    indexVersion: { type: String, required: true },
    agentModel: { type: String, default: null },
    vlmModel: { type: String, default: null },
    chunkPolicy: { type: ChunkPolicySchema, required: true, default: () => DEFAULT_CHUNK_POLICY },
    apiDatasetConfig: { type: Schema.Types.Mixed, default: null },
    inheritPermission: { type: Boolean, default: true, required: true },
    autoSync: { type: Boolean, default: false, required: true },
    deleteTime: { type: Date, default: null },
    version: { type: Number, default: 1, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'datasets', versionKey: false },
);

defineIndex(DatasetSchema, {
  name: 'ds_datasets_team_parent_idx',
  key: { teamId: 1, parentId: 1, type: 1, deleteTime: 1 },
});
defineIndex(DatasetSchema, {
  name: 'ds_datasets_team_delete_update_idx',
  key: { teamId: 1, deleteTime: 1, updateTime: -1 },
});
defineIndex(DatasetSchema, {
  name: 'ds_datasets_team_autosync_idx',
  key: { teamId: 1, autoSync: 1, deleteTime: 1 },
});
