import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.6 dataset_data_texts 字段字典（全文投影）。 */
export interface DatasetDataTextDoc {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  collectionId: Types.ObjectId;
  dataId: Types.ObjectId;
  fullTextToken: string;
  createTime: Date;
  updateTime: Date;
}

export const DatasetDataTextSchema = new Schema<DatasetDataTextDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    collectionId: { type: Schema.Types.ObjectId, required: true },
    dataId: { type: Schema.Types.ObjectId, required: true },
    fullTextToken: { type: String, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_data_texts', versionKey: false },
);

defineIndex(DatasetDataTextSchema, {
  name: 'teamId_1_fullTextToken_text',
  key: { teamId: 1, fullTextToken: 'text' },
  options: { default_language: 'none' },
});
defineIndex(DatasetDataTextSchema, {
  name: 'ds_dataset_data_texts_scope_idx',
  key: { teamId: 1, datasetId: 1, collectionId: 1, dataId: 1 },
});
defineIndex(DatasetDataTextSchema, {
  name: 'ds_dataset_data_texts_data_hashed_idx',
  key: { dataId: 'hashed' },
});
