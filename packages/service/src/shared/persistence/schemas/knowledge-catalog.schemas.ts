import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import {
  knowledgeCommonFields,
  knowledgeSchemaOptions,
  normalizedName,
} from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeSpaceDoc extends WorkspaceFields {
  kind: 'space' | 'folder';
  parentSpaceId: Types.ObjectId | null;
  name: string;
  normalizedName: string;
  description: string;
  iconKey: string;
  ownershipMemberId: string;
  accessMode: 'workspace' | 'restricted';
  sourceAclMode: 'inherited' | 'enforced';
  sourcePermissionEnabled: boolean;
  referenceRevision: number;
  permissionRevision: number;
  modelBindings: Record<string, unknown>;
  defaultChunking: Record<string, unknown>;
  status: 'active' | 'deleting' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeSpaceSchema = new Schema(
  {
    ...knowledgeCommonFields,
    kind: { type: String, enum: ['space', 'folder'], required: true },
    parentSpaceId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, minlength: 1, maxlength: 120 },
    normalizedName: { type: String, required: true },
    description: { type: String, default: '', maxlength: 2000 },
    iconKey: { type: String, default: 'book-open' },
    ownershipMemberId: { type: String, required: true },
    accessMode: { type: String, enum: ['workspace', 'restricted'], required: true },
    sourceAclMode: { type: String, enum: ['inherited', 'enforced'], required: true },
    sourcePermissionEnabled: { type: Boolean, required: true, default: true },
    referenceRevision: { type: Number, required: true, min: 0, default: 0 },
    permissionRevision: { type: Number, required: true, min: 0, default: 0 },
    modelBindings: { type: Schema.Types.Mixed, required: true, default: {} },
    defaultChunking: { type: Schema.Types.Mixed, required: true, default: {} },
    status: {
      type: String,
      enum: ['active', 'deleting', 'deleted'],
      required: true,
      default: 'active',
    },
  },
  knowledgeSchemaOptions('knowledge_spaces'),
);

KnowledgeSpaceSchema.pre('validate', function normalizeName(next) {
  if (this.name) this.normalizedName = normalizedName(this.name);
  next();
});

defineKnowledgeIndex(KnowledgeSpaceSchema, {
  name: 'ux_space_sibling_name',
  key: { workspaceId: 1, parentSpaceId: 1, normalizedName: 1, deletedAt: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeSpaceSchema, {
  name: 'ix_space_workspace_updated',
  key: { workspaceId: 1, kind: 1, updatedAt: -1 },
});
defineKnowledgeIndex(KnowledgeSpaceSchema, {
  name: 'ix_space_status',
  key: { workspaceId: 1, status: 1, updatedAt: -1 },
});

export interface KnowledgeDirectoryDoc extends WorkspaceFields {
  parentDirectoryId: Types.ObjectId | null;
  name: string;
  normalizedName: string;
  path: Types.ObjectId[];
  depth: number;
  sortOrder: number;
  aclMode: 'inherited' | 'override';
  permissionRevision: number;
  ownershipMemberId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeDirectorySchema = new Schema(
  {
    ...knowledgeCommonFields,
    parentDirectoryId: { type: Schema.Types.ObjectId, default: null },
    name: { type: String, required: true, minlength: 1, maxlength: 120 },
    normalizedName: { type: String, required: true },
    path: { type: [Schema.Types.ObjectId], required: true, default: [] },
    depth: { type: Number, required: true, min: 0, max: 4 },
    sortOrder: { type: Number, required: true, default: 0 },
    aclMode: {
      type: String,
      enum: ['inherited', 'override'],
      required: true,
      default: 'inherited',
    },
    permissionRevision: { type: Number, required: true, min: 0, default: 0 },
    ownershipMemberId: { type: String, required: true },
  },
  knowledgeSchemaOptions('knowledge_directories'),
);

KnowledgeDirectorySchema.pre('validate', function normalizeName(next) {
  if (this.name) this.normalizedName = normalizedName(this.name);
  next();
});

defineKnowledgeIndex(KnowledgeDirectorySchema, {
  name: 'ux_directory_sibling_name',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    parentDirectoryId: 1,
    normalizedName: 1,
    deletedAt: 1,
  },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeDirectorySchema, {
  name: 'ix_directory_tree',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    parentDirectoryId: 1,
    sortOrder: 1,
  },
});

export interface KnowledgeSourceDoc extends WorkspaceFields {
  directoryId: Types.ObjectId | null;
  kind:
    | 'file'
    | 'text'
    | 'url'
    | 'template'
    | 'backup'
    | 'api_library'
    | 'feishu'
    | 'yuque'
    | 'dingtalk'
    | 'image';
  name: string;
  externalId: string | null;
  connectorId: Types.ObjectId | null;
  blobRefId: Types.ObjectId | null;
  originalUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  parseProvider: 'liteparse' | 'sangfor' | 'somark' | 'textin' | 'doc2x';
  processingStatus:
    | 'draft'
    | 'queued'
    | 'parsing'
    | 'indexing'
    | 'ready'
    | 'partial'
    | 'failed'
    | 'deleting'
    | 'deleted';
  sourceVersion: number;
  searchEnabled: boolean;
  permissionState: 'disabled' | 'inherited' | 'independent';
  permissionRevision: number;
  ownershipMemberId: string;
  metadata: Record<string, unknown>;
  tagValues: Array<{ tagId: Types.ObjectId; valueKey: string; value: unknown }>;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeSourceSchema = new Schema(
  {
    ...knowledgeCommonFields,
    directoryId: { type: Schema.Types.ObjectId, default: null },
    kind: {
      type: String,
      enum: [
        'file',
        'text',
        'url',
        'template',
        'backup',
        'api_library',
        'feishu',
        'yuque',
        'dingtalk',
        'image',
      ],
      required: true,
    },
    name: { type: String, required: true, minlength: 1, maxlength: 240 },
    externalId: { type: String, default: null },
    connectorId: { type: Schema.Types.ObjectId, default: null },
    blobRefId: { type: Schema.Types.ObjectId, default: null },
    originalUrl: { type: String, default: null },
    mimeType: { type: String, required: true, default: 'application/octet-stream' },
    sizeBytes: { type: Number, required: true, min: 0, default: 0 },
    contentHash: {
      type: String,
      required: true,
      default: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
    parseProvider: {
      type: String,
      enum: ['liteparse', 'sangfor', 'somark', 'textin', 'doc2x'],
      required: true,
      default: 'liteparse',
    },
    processingStatus: {
      type: String,
      enum: [
        'draft',
        'queued',
        'parsing',
        'indexing',
        'ready',
        'partial',
        'failed',
        'deleting',
        'deleted',
      ],
      required: true,
      default: 'draft',
    },
    sourceVersion: { type: Number, required: true, min: 1, default: 1 },
    searchEnabled: { type: Boolean, required: true, default: true },
    permissionState: {
      type: String,
      enum: ['disabled', 'inherited', 'independent'],
      required: true,
      default: 'disabled',
    },
    permissionRevision: { type: Number, required: true, min: 0, default: 0 },
    ownershipMemberId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, required: true, default: {} },
    tagValues: { type: [Schema.Types.Mixed], required: true, default: [] },
  },
  knowledgeSchemaOptions('knowledge_sources'),
);

defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ux_source_external',
  key: { workspaceId: 1, knowledgeSpaceId: 1, connectorId: 1, externalId: 1 },
  options: {
    unique: true,
    partialFilterExpression: { externalId: { $type: 'string' }, deletedAt: null },
  },
});
defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ix_source_list',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    directoryId: 1,
    deletedAt: 1,
    updatedAt: -1,
  },
});
defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ix_source_hash',
  key: { workspaceId: 1, contentHash: 1 },
});
defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ix_source_status',
  key: { workspaceId: 1, processingStatus: 1, updatedAt: -1 },
});
defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ix_source_search_permission',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    searchEnabled: 1,
    permissionState: 1,
    updatedAt: -1,
  },
});
defineKnowledgeIndex(KnowledgeSourceSchema, {
  name: 'ix_source_tags',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    'tagValues.tagId': 1,
    'tagValues.valueKey': 1,
    searchEnabled: 1,
  },
});

export interface SegmentIndexValue {
  indexId: string;
  type: string;
  modelId: string;
  dimension: 768 | 1024 | 1536 | 3072;
  vectorProfile: string;
  vectorId: string;
  text: string;
  version: number;
}

export interface KnowledgeSegmentDoc extends WorkspaceFields {
  sourceId: Types.ObjectId;
  searchEnabled: boolean;
  order: number;
  question: string;
  answer: string;
  content: string;
  fullTextTokens: string;
  metadata: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  indexes: SegmentIndexValue[];
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'error' | 'rebuilding' | 'rebuild_failed';
  indexErrorCode: string | null;
  imageBlobRefId: Types.ObjectId | null;
  imageDescription: string | null;
  synonymVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const SegmentIndexSchema = new Schema(
  {
    indexId: { type: String, required: true },
    type: { type: String, required: true },
    modelId: { type: String, required: true },
    dimension: { type: Number, enum: [768, 1024, 1536, 3072], required: true },
    vectorProfile: { type: String, required: true },
    vectorId: { type: String, required: true },
    text: { type: String, required: true },
    version: { type: Number, required: true },
  },
  { _id: false },
);

export const KnowledgeSegmentSchema = new Schema(
  {
    ...knowledgeCommonFields,
    sourceId: { type: Schema.Types.ObjectId, required: true },
    searchEnabled: { type: Boolean, required: true, default: true },
    order: { type: Number, required: true, min: 0 },
    question: { type: String, required: true, maxlength: 100000 },
    answer: { type: String, required: true, maxlength: 100000 },
    content: { type: String, required: true },
    fullTextTokens: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, required: true, default: {} },
    history: { type: [Schema.Types.Mixed], required: true, default: [] },
    indexes: { type: [SegmentIndexSchema], required: true, default: [] },
    indexStatus: {
      type: String,
      enum: ['pending', 'indexing', 'indexed', 'error', 'rebuilding', 'rebuild_failed'],
      required: true,
      default: 'pending',
    },
    indexErrorCode: { type: String, default: null },
    imageBlobRefId: { type: Schema.Types.ObjectId, default: null },
    imageDescription: { type: String, default: null },
    synonymVersion: { type: Number, required: true, min: 0, default: 0 },
  },
  knowledgeSchemaOptions('knowledge_segments'),
);

defineKnowledgeIndex(KnowledgeSegmentSchema, {
  name: 'ux_segment_order',
  key: { workspaceId: 1, knowledgeSpaceId: 1, sourceId: 1, order: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeSegmentSchema, {
  name: 'ix_segment_fulltext',
  key: { workspaceId: 1, knowledgeSpaceId: 1, fullTextTokens: 'text' },
  options: {
    default_language: 'none',
    weights: { fullTextTokens: 1 },
  },
});
defineKnowledgeIndex(KnowledgeSegmentSchema, {
  name: 'ix_segment_indexed',
  key: { workspaceId: 1, knowledgeSpaceId: 1, indexStatus: 1, updatedAt: -1 },
});
defineKnowledgeIndex(KnowledgeSegmentSchema, {
  name: 'ix_segment_vector_ids',
  key: { workspaceId: 1, 'indexes.vectorId': 1 },
});
