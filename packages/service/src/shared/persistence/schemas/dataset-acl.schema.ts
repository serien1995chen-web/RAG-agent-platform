import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.10 dataset_acl 字段字典。 */
export interface DatasetAclDoc {
  teamId: Types.ObjectId;
  resourceType: string;
  resourceId: Types.ObjectId;
  collaboratorType: 'member' | 'group' | 'org' | 'owner';
  collaboratorId: Types.ObjectId | string;
  /** 显式 0 是有效 deny，不代表行不存在。 */
  permission: number;
  permissionMask: number;
  inheritEnabled: boolean;
  version: number;
  source: 'local' | 'migrated' | 'owner-transfer';
  createTime: Date;
  updateTime: Date;
}

export const DatasetAclSchema = new Schema<DatasetAclDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    resourceType: { type: String, default: 'dataset', required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    collaboratorType: {
      type: String,
      enum: ['member', 'group', 'org', 'owner'],
      required: true,
    },
    collaboratorId: { type: Schema.Types.Mixed, required: true },
    permission: { type: Number, default: 0, required: true },
    permissionMask: { type: Number, default: 0, required: true },
    inheritEnabled: { type: Boolean, default: true, required: true },
    version: { type: Number, default: 1, required: true },
    source: {
      type: String,
      enum: ['local', 'migrated', 'owner-transfer'],
      default: 'local',
      required: true,
    },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_acl', versionKey: false },
);

defineIndex(DatasetAclSchema, {
  name: 'ds_dataset_acl_collaborator_unique',
  key: {
    teamId: 1,
    resourceType: 1,
    resourceId: 1,
    collaboratorType: 1,
    collaboratorId: 1,
  },
  options: { unique: true },
});
defineIndex(DatasetAclSchema, {
  name: 'ds_dataset_acl_team_resource_idx',
  key: { teamId: 1, resourceId: 1 },
});
defineIndex(DatasetAclSchema, {
  name: 'ds_dataset_acl_team_collaborator_idx',
  key: { teamId: 1, collaboratorId: 1 },
});
