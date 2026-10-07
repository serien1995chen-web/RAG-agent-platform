import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.15 usages 字段字典（Usage 聚合事实，TTL 360 天）。 */
export interface UsageDoc {
  teamId: Types.ObjectId;
  tmbId: Types.ObjectId;
  source: string;
  appName: string;
  totalPoints: number;
  time: Date;
  appId: string | null;
  skillId: string | null;
  datasetId: Types.ObjectId | null;
  list: unknown[];
}

export const UsageSchema = new Schema<UsageDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    tmbId: { type: Schema.Types.ObjectId, required: true },
    source: { type: String, required: true },
    appName: { type: String, required: true },
    totalPoints: { type: Number, required: true },
    time: { type: Date, default: () => new Date(), required: true },
    appId: { type: String, default: null },
    skillId: { type: String, default: null },
    datasetId: { type: Schema.Types.ObjectId, default: null },
    list: { type: [Schema.Types.Mixed], default: [] },
  },
  { collection: 'usages', versionKey: false },
);

defineIndex(UsageSchema, {
  name: 'ds_usages_team_time_idx',
  key: { teamId: 1, time: -1 },
});
defineIndex(UsageSchema, {
  name: 'ds_usages_team_source_idx',
  key: { teamId: 1, source: 1 },
});
defineIndex(UsageSchema, {
  name: 'ds_usages_team_dataset_idx',
  key: { teamId: 1, datasetId: 1 },
});
defineIndex(UsageSchema, {
  name: 'ds_usages_time_ttl_idx',
  key: { time: 1 },
  options: { expireAfterSeconds: 31104000 },
});
