import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeConnectorDoc extends WorkspaceFields {
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk';
  name: string;
  credentialSchemaVersion: number;
  credentialCiphertext: string;
  credentialKeyVersion: number;
  configSchemaVersion: number;
  config: Record<string, unknown>;
  status: 'active' | 'syncing' | 'paused' | 'failed' | 'deleting' | 'deleted';
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  nextSyncAt: Date | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: Record<string, unknown> | null;
  cursorVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeConnectorSchema = new Schema(
  {
    ...knowledgeCommonFields,
    provider: {
      type: String,
      enum: ['custom_api', 'feishu', 'yuque', 'dingtalk'],
      required: true,
    },
    name: { type: String, required: true, maxlength: 120 },
    credentialSchemaVersion: { type: Number, required: true, min: 1 },
    credentialCiphertext: { type: String, required: true },
    credentialKeyVersion: { type: Number, required: true, min: 1 },
    configSchemaVersion: { type: Number, required: true, min: 1 },
    config: { type: Schema.Types.Mixed, required: true, default: {} },
    status: {
      type: String,
      enum: ['active', 'syncing', 'paused', 'failed', 'deleting', 'deleted'],
      required: true,
      default: 'active',
    },
    syncEnabled: { type: Boolean, required: true, default: true },
    syncIntervalMinutes: { type: Number, required: true, min: 15, max: 1440, default: 60 },
    nextSyncAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastError: { type: Schema.Types.Mixed, default: null },
    cursorVersion: { type: Number, required: true, min: 1, default: 1 },
  },
  knowledgeSchemaOptions('knowledge_connectors'),
);

defineKnowledgeIndex(KnowledgeConnectorSchema, {
  name: 'ux_connector_provider',
  key: { workspaceId: 1, knowledgeSpaceId: 1, provider: 1 },
  options: { unique: true, partialFilterExpression: { deletedAt: null } },
});
defineKnowledgeIndex(KnowledgeConnectorSchema, {
  name: 'ix_connector_status',
  key: { workspaceId: 1, syncEnabled: 1, status: 1, nextSyncAt: 1 },
});

export interface KnowledgeConnectorScheduleDoc extends WorkspaceFields {
  connectorId: Types.ObjectId;
  knowledgeSpaceId: Types.ObjectId;
  dueAt: Date;
  status: 'scheduled' | 'claimed' | 'dispatched' | 'blocked';
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastDispatchedAt: Date | null;
  lastError: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeConnectorScheduleSchema = new Schema(
  {
    ...knowledgeCommonFields,
    connectorId: { type: Schema.Types.ObjectId, required: true },
    knowledgeSpaceId: { type: Schema.Types.ObjectId, required: true },
    dueAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'claimed', 'dispatched', 'blocked'],
      required: true,
      default: 'scheduled',
    },
    attempt: { type: Number, required: true, min: 0, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastDispatchedAt: { type: Date, default: null },
    lastError: { type: Schema.Types.Mixed, default: null },
  },
  knowledgeSchemaOptions('knowledge_connector_schedules'),
);

defineKnowledgeIndex(KnowledgeConnectorScheduleSchema, {
  name: 'ux_connector_schedule',
  key: { workspaceId: 1, connectorId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeConnectorScheduleSchema, {
  name: 'ix_connector_schedule_due',
  key: { workspaceId: 1, status: 1, dueAt: 1 },
});
defineKnowledgeIndex(KnowledgeConnectorScheduleSchema, {
  name: 'ix_connector_schedule_lease',
  key: { workspaceId: 1, leaseExpiresAt: 1 },
});

export interface KnowledgeConnectorCursorDoc extends WorkspaceFields {
  connectorId: Types.ObjectId;
  externalRootId: string;
  cursor: Record<string, unknown>;
  cursorVersion: number;
  syncRunId: Types.ObjectId | null;
  checkpointAt: Date;
  lastChangeSetHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeConnectorCursorSchema = new Schema(
  {
    ...knowledgeCommonFields,
    connectorId: { type: Schema.Types.ObjectId, required: true },
    externalRootId: { type: String, required: true },
    cursor: { type: Schema.Types.Mixed, required: true, default: {} },
    cursorVersion: { type: Number, required: true, min: 1, default: 1 },
    syncRunId: { type: Schema.Types.ObjectId, default: null },
    checkpointAt: { type: Date, required: true },
    lastChangeSetHash: { type: String, required: true },
  },
  knowledgeSchemaOptions('knowledge_connector_cursors'),
);

defineKnowledgeIndex(KnowledgeConnectorCursorSchema, {
  name: 'ux_connector_cursor',
  key: { workspaceId: 1, connectorId: 1, externalRootId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeConnectorCursorSchema, {
  name: 'ix_cursor_checkpoint',
  key: { workspaceId: 1, connectorId: 1, checkpointAt: -1 },
});
