import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.13 reconcile_reports 字段字典（对账报告，不保存正文）。 */
export interface ReconcileCountsValue {
  scanned: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface ReconcileFindingValue {
  kind: string;
  sampleId: string;
  hash: string;
  action: string;
}

export interface ReconcileReportDoc {
  scope: Record<string, unknown>;
  teamId: Types.ObjectId | null;
  windowStart: Date;
  windowEnd: Date;
  state: string;
  counts: ReconcileCountsValue;
  findings: ReconcileFindingValue[];
  sampleHash: string;
  notificationId: string | null;
  dedupKey: string;
  reviewer: string | null;
  closedAt: Date | null;
  evidenceExpireAt: Date | null;
  createTime: Date;
}

const CountsSchema = new Schema<ReconcileCountsValue>(
  {
    scanned: { type: Number, default: 0, required: true },
    success: { type: Number, default: 0, required: true },
    failed: { type: Number, default: 0, required: true },
    skipped: { type: Number, default: 0, required: true },
  },
  { _id: false },
);

const FindingSchema = new Schema<ReconcileFindingValue>(
  {
    kind: { type: String, required: true },
    sampleId: { type: String, required: true },
    hash: { type: String, required: true },
    action: { type: String, required: true },
  },
  { _id: false },
);

export const ReconcileReportSchema = new Schema<ReconcileReportDoc>(
  {
    scope: { type: Schema.Types.Mixed, required: true },
    teamId: { type: Schema.Types.ObjectId, default: null },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    state: {
      type: String,
      enum: ['running', 'completed', 'failed', 'pending_review'],
      required: true,
    },
    counts: { type: CountsSchema, required: true, default: () => ({}) },
    findings: { type: [FindingSchema], default: [] },
    sampleHash: { type: String, required: true },
    notificationId: { type: String, default: null },
    dedupKey: { type: String, required: true },
    reviewer: { type: String, default: null },
    closedAt: { type: Date, default: null },
    evidenceExpireAt: { type: Date, default: null },
    createTime: { type: Date, default: () => new Date(), required: true },
  },
  { collection: 'reconcile_reports', versionKey: false },
);

defineIndex(ReconcileReportSchema, {
  name: 'ds_reconcile_reports_window_scope_idx',
  key: { windowStart: 1, windowEnd: 1, scope: 1 },
});
defineIndex(ReconcileReportSchema, {
  name: 'ds_reconcile_reports_team_create_idx',
  key: { teamId: 1, createTime: -1 },
});
defineIndex(ReconcileReportSchema, {
  name: 'ds_reconcile_reports_dedup_unique',
  key: { dedupKey: 1 },
  options: { unique: true },
});
