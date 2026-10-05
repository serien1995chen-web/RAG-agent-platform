import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.8 dataset_tags 字段字典。 */
export interface DatasetTagDoc {
  teamId: Types.ObjectId;
  datasetId: Types.ObjectId;
  name: string;
  createTime: Date;
  updateTime: Date;
}

export const DatasetTagSchema = new Schema<DatasetTagDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    datasetId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    updateTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'dataset_tags', versionKey: false },
);

defineIndex(DatasetTagSchema, {
  name: 'ds_dataset_tags_team_name_unique',
  key: { teamId: 1, datasetId: 1, name: 1 },
  options: { unique: true },
});
