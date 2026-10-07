import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.15 usage_items 字段字典（计量明细，TTL 360 天）。 */
export interface UsageItemDoc {
  teamId: Types.ObjectId;
  usageId: string;
  name: string;
  amount: number;
  itemType: string;
  time: Date;
  inputTokens: number | null;
  outputTokens: number | null;
  charsLength: number | null;
  duration: number | null;
  pages: number | null;
  count: number | null;
  model: string | null;
  dedupKey: string | null;
}

export const UsageItemSchema = new Schema<UsageItemDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    usageId: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
    itemType: { type: String, required: true },
    time: { type: Date, default: () => new Date(), required: true },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    charsLength: { type: Number, default: null },
    duration: { type: Number, default: null },
    pages: { type: Number, default: null },
    count: { type: Number, default: null },
    model: { type: String, default: null },
    dedupKey: { type: String, default: null },
  },
  { collection: 'usage_items', versionKey: false },
);

defineIndex(UsageItemSchema, {
  name: 'ds_usage_items_team_dedup_unique',
  key: { teamId: 1, dedupKey: 1 },
  options: { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } },
});
defineIndex(UsageItemSchema, {
  name: 'ds_usage_items_team_usage_idx',
  key: { teamId: 1, usageId: 1 },
});
defineIndex(UsageItemSchema, {
  name: 'ds_usage_items_team_model_time_idx',
  key: { teamId: 1, model: 1, time: -1 },
});
defineIndex(UsageItemSchema, {
  name: 'ds_usage_items_time_ttl_idx',
  key: { time: 1 },
  options: { expireAfterSeconds: 31104000 },
});
