import { Schema, type Types } from 'mongoose';
import { defineIndex } from '../define-index';

/** 设计文档 10.15 operationLogs 字段字典（Audit 权威记录，长期保留）。 */
export interface OperationLogDoc {
  teamId: Types.ObjectId;
  tmbId: Types.ObjectId;
  timestamp: Date;
  event: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
  operation: string | null;
  resourceType: string | null;
  resourceId: string | null;
  result: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  params: Record<string, unknown> | null;
}

export const OperationLogSchema = new Schema<OperationLogDoc>(
  {
    teamId: { type: Schema.Types.ObjectId, required: true },
    tmbId: { type: Schema.Types.ObjectId, required: true },
    timestamp: { type: Date, default: () => new Date(), required: true },
    event: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    // extension 附加字段（可空），不构成第二主名称。
    requestId: { type: String, default: null },
    operation: { type: String, default: null },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    result: { type: String, default: null },
    beforeHash: { type: String, default: null },
    afterHash: { type: String, default: null },
    params: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'operationLogs', versionKey: false },
);

defineIndex(OperationLogSchema, {
  name: 'ds_operation_logs_team_time_idx',
  key: { teamId: 1, timestamp: -1 },
});
defineIndex(OperationLogSchema, {
  name: 'ds_operation_logs_team_resource_idx',
  key: { teamId: 1, resourceType: 1, resourceId: 1 },
});
defineIndex(OperationLogSchema, {
  name: 'ds_operation_logs_team_actor_idx',
  key: { teamId: 1, tmbId: 1, timestamp: -1 },
});
