import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.15 tracks 字段字典（SaaS/扩展启用的事件分桶，无 TTL）。 */
export interface TrackDoc {
  event: string;
  uid: string | null;
  teamId: Types.ObjectId;
  tmbId: Types.ObjectId;
  createTime: Date;
  data: Record<string, unknown> | null;
}

export const TrackSchema = new Schema<TrackDoc>(
  {
    event: { type: String, required: true },
    uid: { type: String, default: null },
    teamId: { type: Schema.Types.ObjectId, required: true },
    tmbId: { type: Schema.Types.ObjectId, required: true },
    createTime: { type: Date, default: () => new Date(), required: true },
    data: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'tracks', versionKey: false },
);

defineIndex(TrackSchema, {
  name: 'ds_tracks_team_time_idx',
  key: { teamId: 1, createTime: -1 },
});
defineIndex(TrackSchema, {
  name: 'ds_tracks_event_time_idx',
  key: { event: 1, createTime: -1 },
});
