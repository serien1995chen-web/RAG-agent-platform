import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';
import {
  DataHistoryEntrySchema,
  KnowledgeItemIndexSchema,
  type DataHistoryEntryValue,
  type KnowledgeItemIndexValue,
} from './common';

/** 设计文档 10.5 dataset_datas 字段字典。 */
export interface DatasetDataDoc {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  collectionId: Types.ObjectId;
  q: string | null;
  a: string;
  imageId: string | null;
  imageDescMap: Record<string, unknown> | null;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  history: DataHistoryEntryValue[];
  indexes: KnowledgeItemIndexValue[];
  dedupKey: string | null;
  rebuilding: boolean;
  createTime: Date;
  updateTime: Date;
}

export const DatasetDataSchema = new Schema<DatasetDataDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    collectionId: { type: Schema.Types.ObjectId, required: true },
    q: { type: String, default: null },
    a: { type: String, default: '' },
    imageId: { type: String, default: null },
    imageDescMap: { type: Schema.Types.Mixed, default: null },
    chunkIndex: { type: Number, default: 0, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    history: { type: [DataHistoryEntrySchema], default: [] },
    indexes: { type: [KnowledgeItemIndexSchema], default: [] },
    dedupKey: { type: String, default: null },
    rebuilding: { type: Boolean, default: false, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_datas', versionKey: false },
);

defineIndex(DatasetDataSchema, {
  name: 'ds_dataset_datas_team_chunk_idx',
  key: { teamId: 1, datasetId: 1, collectionId: 1, chunkIndex: 1 },
});
defineIndex(DatasetDataSchema, {
  name: 'ds_dataset_datas_team_index_ref_idx',
  key: { teamId: 1, datasetId: 1, 'indexes.dataId': 1 },
});
defineIndex(DatasetDataSchema, {
  name: 'ds_dataset_datas_team_dedup_unique',
  key: { teamId: 1, datasetId: 1, collectionId: 1, dedupKey: 1 },
  options: {
    unique: true,
    partialFilterExpression: { dedupKey: { $type: 'string' } },
  },
});
