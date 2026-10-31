import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export type KnowledgeJobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'retry_wait'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'dead_letter'
  | 'succeeded';

export interface KnowledgeJobDoc extends WorkspaceFields {
  kind:
    | 'import'
    | 'parse'
    | 'segment'
    | 'qa'
    | 'ocr'
    | 'caption'
    | 'embed'
    | 'index'
    | 'fulltext'
    | 'rebuild'
    | 'synonym_rebuild'
    | 'search_projection'
    | 'sync'
    | 'delete'
    | 'export'
    | 'cleanup'
    | 'reconcile'
    | 'outbox';
  resourceType:
    | 'workspace'
    | 'space'
    | 'directory'
    | 'source'
    | 'segment'
    | 'job'
    | 'connector'
    | 'api_key'
    | 'synonym'
    | 'system';
  resourceId: string;
  status: KnowledgeJobStatus;
  priority: number;
  idempotencyKey: string;
  inputSnapshot: Record<string, unknown>;
  progress: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  attemptEpoch: number;
  fencingToken: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  availableAt: Date;
  cancelRequestedAt: Date | null;
  pausedAt: Date | null;
  error: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeJobSchema = new Schema(
  {
    ...knowledgeCommonFields,
    kind: {
      type: String,
      enum: [
        'import',
        'parse',
        'segment',
        'qa',
        'ocr',
        'caption',
        'embed',
        'index',
        'fulltext',
        'rebuild',
        'synonym_rebuild',
        'search_projection',
        'sync',
        'delete',
        'export',
        'cleanup',
        'reconcile',
        'outbox',
      ],
      required: true,
    },
    resourceType: {
      type: String,
      enum: [
        'workspace',
        'space',
        'directory',
        'source',
        'segment',
        'job',
        'connector',
        'api_key',
        'synonym',
        'system',
      ],
      required: true,
    },
    resourceId: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'queued',
        'leased',
        'running',
        'retry_wait',
        'paused',
        'cancelling',
        'cancelled',
        'failed',
        'dead_letter',
        'succeeded',
      ],
      required: true,
      default: 'queued',
    },
    priority: { type: Number, required: true, default: 0 },
    idempotencyKey: { type: String, required: true },
    inputSnapshot: { type: Schema.Types.Mixed, required: true, default: {} },
    progress: { type: Schema.Types.Mixed, required: true, default: {} },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, default: 3 },
    attemptEpoch: { type: Number, required: true, min: 0, default: 0 },
    fencingToken: { type: String, required: true, default: 'unassigned' },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    heartbeatAt: { type: Date, default: null },
    availableAt: { type: Date, required: true, default: () => new Date() },
    cancelRequestedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_jobs'),
);

defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ux_job_idempotency',
  key: { workspaceId: 1, idempotencyKey: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ix_job_schedule',
  key: { workspaceId: 1, status: 1, availableAt: 1, priority: -1 },
});
defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ix_job_resource',
  key: { workspaceId: 1, resourceType: 1, resourceId: 1, createdAt: -1 },
});
defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ix_job_lease',
  key: { status: 1, leaseExpiresAt: 1 },
});
defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ix_job_root',
  key: { workspaceId: 1, 'inputSnapshot.rootJobId': 1, status: 1, updatedAt: 1 },
});
defineKnowledgeIndex(KnowledgeJobSchema, {
  name: 'ttl_job_expiry',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeJobStepDoc extends WorkspaceFields {
  jobId: Types.ObjectId;
  stepKey: string;
  status: 'pending' | 'running' | 'succeeded' | 'retry_wait' | 'failed' | 'compensated' | 'skipped';
  idempotencyKey: string;
  attempts: number;
  externalEvidence: Record<string, unknown> | null;
  compensationState: 'none' | 'required' | 'running' | 'succeeded' | 'failed';
  error: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeJobStepSchema = new Schema(
  {
    ...knowledgeCommonFields,
    jobId: { type: Schema.Types.ObjectId, required: true },
    stepKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'retry_wait', 'failed', 'compensated', 'skipped'],
      required: true,
      default: 'pending',
    },
    idempotencyKey: { type: String, required: true },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    externalEvidence: { type: Schema.Types.Mixed, default: null },
    compensationState: {
      type: String,
      enum: ['none', 'required', 'running', 'succeeded', 'failed'],
      required: true,
      default: 'none',
    },
    error: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_job_steps'),
);

defineKnowledgeIndex(KnowledgeJobStepSchema, {
  name: 'ux_job_step',
  key: { workspaceId: 1, jobId: 1, stepKey: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeJobStepSchema, {
  name: 'ix_job_step_status',
  key: { workspaceId: 1, status: 1, updatedAt: 1 },
});
defineKnowledgeIndex(KnowledgeJobStepSchema, {
  name: 'ttl_job_step_expiry',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeOutboxEventDoc extends WorkspaceFields {
  eventKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'dead_letter';
  attempts: number;
  replayJobId: Types.ObjectId | null;
  availableAt: Date;
  publishedAt: Date | null;
  error: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeOutboxEventSchema = new Schema(
  {
    ...knowledgeCommonFields,
    eventKey: { type: String, required: true },
    eventType: { type: String, required: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ['pending', 'publishing', 'published', 'failed', 'dead_letter'],
      required: true,
      default: 'pending',
    },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    replayJobId: { type: Schema.Types.ObjectId, default: null },
    availableAt: { type: Date, required: true, default: () => new Date() },
    publishedAt: { type: Date, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_outbox_events'),
);

defineKnowledgeIndex(KnowledgeOutboxEventSchema, {
  name: 'ux_outbox_event',
  key: { workspaceId: 1, eventKey: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeOutboxEventSchema, {
  name: 'ix_outbox_dispatch',
  key: { status: 1, availableAt: 1, replayJobId: 1 },
});
defineKnowledgeIndex(KnowledgeOutboxEventSchema, {
  name: 'ttl_outbox_dispatch',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeIdempotencyRecordDoc extends WorkspaceFields {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: 'in_progress' | 'completed' | 'failed';
  statusCode: number | null;
  responseBody: Record<string, unknown> | null;
  requestId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeIdempotencyRecordSchema = new Schema(
  {
    ...knowledgeCommonFields,
    scope: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: ['in_progress', 'completed', 'failed'],
      required: true,
      default: 'in_progress',
    },
    statusCode: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_idempotency_records'),
);

defineKnowledgeIndex(KnowledgeIdempotencyRecordSchema, {
  name: 'ux_idempotency_key',
  key: { workspaceId: 1, scope: 1, idempotencyKey: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeIdempotencyRecordSchema, {
  name: 'ttl_idempotency',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});
