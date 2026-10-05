import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';
import {
  ChunkPolicySchema,
  SourceRefSchema,
  type ChunkPolicyValue,
  type SourceRefValue,
} from './common';

/** 设计文档 10.4 dataset_collections 字段字典。 */
export interface DatasetCollectionDoc {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  parentId: Types.ObjectId | null;
  type: string;
  name: string;
  tagIds: Types.ObjectId[];
  sourceRef: SourceRefValue | null;
  externalFileId: string | null;
  externalFileIdNormalized: string | null;
  hashRawText: string | null;
  trainingPolicy: ChunkPolicyValue;
  indexVersion: string | null;
  forbid: boolean;
  trainingState: 'running' | 'error' | 'ready';
  remainingTraining: number;
  createTime: Date;
  updateTime: Date;
}

export const DatasetCollectionSchema = new Schema<DatasetCollectionDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    type: {
      type: String,
      enum: ['folder', 'virtual', 'file', 'link', 'externalFile', 'apiFile', 'images'],
      required: true,
    },
    name: { type: String, required: true },
    tagIds: { type: [Schema.Types.ObjectId], default: [] },
    sourceRef: { type: SourceRefSchema, default: null },
    externalFileId: { type: String, default: null },
    externalFileIdNormalized: { type: String, default: null },
    hashRawText: { type: String, default: null },
    trainingPolicy: { type: ChunkPolicySchema, required: true },
    indexVersion: { type: String, default: null },
    forbid: { type: Boolean, default: false, required: true },
    trainingState: {
      type: String,
      enum: ['running', 'error', 'ready'],
      default: 'ready',
      required: true,
    },
    remainingTraining: { type: Number, default: 0, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_collections', versionKey: false },
);

defineIndex(DatasetCollectionSchema, {
  name: 'ds_dataset_collections_team_parent_idx',
  key: { teamId: 1, datasetId: 1, parentId: 1, updateTime: -1 },
});
defineIndex(DatasetCollectionSchema, {
  name: 'ds_dataset_collections_team_type_idx',
  key: { teamId: 1, datasetId: 1, type: 1 },
});
defineIndex(DatasetCollectionSchema, {
  name: 'ds_dataset_collections_team_parent_only_idx',
  key: { teamId: 1, parentId: 1 },
});
defineIndex(DatasetCollectionSchema, {
  name: 'ds_dataset_collections_team_tags_idx',
  key: { teamId: 1, datasetId: 1, tagIds: 1 },
});
defineIndex(DatasetCollectionSchema, {
  name: 'ds_dataset_collections_team_external_file_unique',
  key: { teamId: 1, datasetId: 1, externalFileIdNormalized: 1 },
  options: {
    unique: true,
    partialFilterExpression: { externalFileIdNormalized: { $type: 'string' } },
  },
});
