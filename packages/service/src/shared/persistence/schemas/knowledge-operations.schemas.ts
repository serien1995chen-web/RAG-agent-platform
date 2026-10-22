import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeUsageEventDoc extends WorkspaceFields {
  eventId: string;
  eventType:
    | 'parse'
    | 'ocr'
    | 'embedding'
    | 'rerank'
    | 'llm'
    | 'vlm'
    | 'stt'
    | 'tts'
    | 'storage'
    | 'sync';
  quantity: number;
  unit: 'page' | 'image' | 'token' | 'vector' | 'byte' | 'request' | 'second';
  modelId: string | null;
  resourceType: 'space' | 'source' | 'segment' | 'job';
  resourceId: Types.ObjectId;
  jobId: Types.ObjectId | null;
  source: 'console' | 'api';
  occurredAt: Date;
  deliveredAt: Date | null;
  deliveryStatus: 'pending' | 'delivered' | 'failed';
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeUsageEventSchema = new Schema(
  {
    ...knowledgeCommonFields,
    eventId: { type: String, required: true },
    eventType: {
      type: String,
      enum: ['parse', 'ocr', 'embedding', 'rerank', 'llm', 'vlm', 'stt', 'tts', 'storage', 'sync'],
      required: true,
    },
    quantity: { type: Number, required: true, min: 0 },
    unit: {
      type: String,
      enum: ['page', 'image', 'token', 'vector', 'byte', 'request', 'second'],
      required: true,
    },
    modelId: { type: String, default: null },
    resourceType: {
      type: String,
      enum: ['space', 'source', 'segment', 'job'],
      required: true,
    },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    jobId: { type: Schema.Types.ObjectId, default: null },
    source: { type: String, enum: ['console', 'api'], required: true },
    occurredAt: { type: Date, required: true },
    deliveredAt: { type: Date, default: null },
    deliveryStatus: {
      type: String,
      enum: ['pending', 'delivered', 'failed'],
      required: true,
      default: 'pending',
    },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_usage_events'),
);

defineKnowledgeIndex(KnowledgeUsageEventSchema, {
  name: 'ux_usage_event',
  key: { workspaceId: 1, eventId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeUsageEventSchema, {
  name: 'ix_usage_query',
  key: { workspaceId: 1, knowledgeSpaceId: 1, occurredAt: -1, eventType: 1 },
});
defineKnowledgeIndex(KnowledgeUsageEventSchema, {
  name: 'ix_usage_delivery',
  key: { deliveryStatus: 1, occurredAt: 1 },
});
defineKnowledgeIndex(KnowledgeUsageEventSchema, {
  name: 'ttl_usage_event',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeAuditEventDoc extends WorkspaceFields {
  eventId: string;
  action: string;
  actorMemberId: string;
  apiKeyId: Types.ObjectId | null;
  resourceType:
    | 'workspace'
    | 'space'
    | 'directory'
    | 'source'
    | 'segment'
    | 'job'
    | 'connector'
    | 'api_key';
  resourceId: string;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  traceId: string;
  requestId: string;
  ipHash: string;
  userAgentHash: string;
  safeDiff: Record<string, unknown>;
  occurredAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeAuditEventSchema = new Schema(
  {
    ...knowledgeCommonFields,
    eventId: { type: String, required: true },
    action: { type: String, required: true },
    actorMemberId: { type: String, required: true },
    apiKeyId: { type: Schema.Types.ObjectId, default: null },
    resourceType: {
      type: String,
      enum: ['workspace', 'space', 'directory', 'source', 'segment', 'job', 'connector', 'api_key'],
      required: true,
    },
    resourceId: { type: String, required: true },
    outcome: {
      type: String,
      enum: ['allowed', 'denied', 'succeeded', 'failed'],
      required: true,
    },
    traceId: { type: String, required: true },
    requestId: { type: String, required: true },
    ipHash: { type: String, required: true },
    userAgentHash: { type: String, required: true },
    safeDiff: { type: Schema.Types.Mixed, required: true, default: {} },
    occurredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_audit_events'),
);

defineKnowledgeIndex(KnowledgeAuditEventSchema, {
  name: 'ux_audit_event',
  key: { workspaceId: 1, eventId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeAuditEventSchema, {
  name: 'ix_audit_query',
  key: { workspaceId: 1, occurredAt: -1, resourceType: 1, resourceId: 1 },
});
defineKnowledgeIndex(KnowledgeAuditEventSchema, {
  name: 'ix_audit_actor',
  key: { workspaceId: 1, actorMemberId: 1, occurredAt: -1 },
});
defineKnowledgeIndex(KnowledgeAuditEventSchema, {
  name: 'ttl_audit_event',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeObjectRefDoc extends WorkspaceFields {
  provider: 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
  bucket: string;
  objectKey: string;
  purpose: 'source' | 'image' | 'export' | 'preview' | 'avatar';
  sourceId: Types.ObjectId | null;
  mimeType: string;
  sizeBytes: number;
  etag: string;
  sha256: string;
  state: 'pending' | 'active' | 'deleting' | 'deleted';
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeObjectRefSchema = new Schema(
  {
    ...knowledgeCommonFields,
    provider: {
      type: String,
      enum: ['minio', 'aws-s3', 'r2', 'cos', 'oss'],
      required: true,
    },
    bucket: { type: String, required: true },
    objectKey: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['source', 'image', 'export', 'preview', 'avatar'],
      required: true,
    },
    sourceId: { type: Schema.Types.ObjectId, default: null },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    etag: { type: String, required: true },
    sha256: { type: String, required: true },
    state: {
      type: String,
      enum: ['pending', 'active', 'deleting', 'deleted'],
      required: true,
      default: 'pending',
    },
    expiresAt: { type: Date, default: null },
  },
  knowledgeSchemaOptions('knowledge_object_refs'),
);

defineKnowledgeIndex(KnowledgeObjectRefSchema, {
  name: 'ux_object_key',
  key: { workspaceId: 1, bucket: 1, objectKey: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeObjectRefSchema, {
  name: 'ix_object_source',
  key: { workspaceId: 1, knowledgeSpaceId: 1, sourceId: 1, state: 1 },
});
defineKnowledgeIndex(KnowledgeObjectRefSchema, {
  name: 'ix_object_ttl',
  key: { state: 1, expiresAt: 1 },
});

export interface KnowledgeCitationDoc extends WorkspaceFields {
  citationId: string;
  searchRequestId: string;
  segmentId: Types.ObjectId;
  sourceId: Types.ObjectId;
  title: string;
  sourceUrl: string | null;
  segmentRange: Record<string, unknown>;
  score: number;
  snapshotHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeCitationSchema = new Schema(
  {
    ...knowledgeCommonFields,
    citationId: { type: String, required: true },
    searchRequestId: { type: String, required: true },
    segmentId: { type: Schema.Types.ObjectId, required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    sourceUrl: { type: String, default: null },
    segmentRange: { type: Schema.Types.Mixed, required: true },
    score: { type: Number, required: true },
    snapshotHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_citations'),
);

defineKnowledgeIndex(KnowledgeCitationSchema, {
  name: 'ux_citation_id',
  key: { workspaceId: 1, citationId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeCitationSchema, {
  name: 'ttl_citation',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});
