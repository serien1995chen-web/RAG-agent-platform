import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeSynonymConfigDoc extends WorkspaceFields {
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  activeFileVersion: number;
  publishedFileVersion: number | null;
  lastFileVersion: number;
  pendingFileVersion: number | null;
  pendingJobId: string | null;
  pendingReason: 'synonym_change' | 'model_change' | 'source_rebuild' | 'manual' | null;
  pendingStartedAt: Date | null;
  pendingSourceIds: string[];
  enabled: boolean;
  schemaVersion: number;
  status: 'active' | 'disabled' | 'rebuilding' | 'failed';
  uploadTime: Date;
  uploadedByMemberId: string;
  lastError: Record<string, unknown> | null;
  activeQueryModelId: string | null;
  activeQueryDimension: 768 | 1024 | 1536 | 3072 | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeSynonymConfigSchema = new Schema(
  {
    ...knowledgeCommonFields,
    fileName: { type: String, required: true, maxlength: 255 },
    sizeBytes: { type: Number, required: true, min: 0, max: 10 * 1024 * 1024 },
    checksumSha256: { type: String, required: true },
    activeFileVersion: { type: Number, required: true, min: 1 },
    publishedFileVersion: { type: Number, default: null, min: 1 },
    lastFileVersion: { type: Number, required: true, min: 1, default: 1 },
    pendingFileVersion: { type: Number, default: null, min: 1 },
    pendingJobId: { type: String, default: null },
    pendingReason: {
      type: String,
      enum: ['synonym_change', 'model_change', 'source_rebuild', 'manual'],
      default: null,
    },
    pendingStartedAt: { type: Date, default: null },
    pendingSourceIds: { type: [String], required: true, default: [] },
    enabled: { type: Boolean, required: true, default: true },
    schemaVersion: { type: Number, required: true, min: 2, default: 2 },
    status: {
      type: String,
      enum: ['active', 'disabled', 'rebuilding', 'failed'],
      required: true,
      default: 'active',
    },
    uploadTime: { type: Date, required: true },
    uploadedByMemberId: { type: String, required: true },
    lastError: { type: Schema.Types.Mixed, default: null },
    activeQueryModelId: { type: String, default: null },
    activeQueryDimension: {
      type: Number,
      enum: [768, 1024, 1536, 3072, null],
      default: null,
    },
  },
  knowledgeSchemaOptions('knowledge_synonym_configs'),
);

defineKnowledgeIndex(KnowledgeSynonymConfigSchema, {
  name: 'ux_synonym_config',
  key: { workspaceId: 1, knowledgeSpaceId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeSynonymConfigSchema, {
  name: 'ix_synonym_status',
  key: { workspaceId: 1, status: 1, updatedAt: -1 },
});

export interface KnowledgeSynonymMappingDoc extends WorkspaceFields {
  synonymConfigId: Types.ObjectId;
  fileVersion: number;
  logicalMappingId: Types.ObjectId;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonymTerms: string[];
  normalizedSynonymTerms: string[];
  allTerms: string;
  fingerprint: string;
  sourceRows: number[];
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeSynonymMappingSchema = new Schema(
  {
    ...knowledgeCommonFields,
    synonymConfigId: { type: Schema.Types.ObjectId, required: true },
    fileVersion: { type: Number, required: true, min: 1 },
    logicalMappingId: { type: Schema.Types.ObjectId, required: true },
    standardizedTerm: { type: String, required: true, maxlength: 128 },
    normalizedStandardizedTerm: { type: String, required: true },
    synonymTerms: { type: [String], required: true },
    normalizedSynonymTerms: { type: [String], required: true },
    allTerms: { type: String, required: true },
    fingerprint: { type: String, required: true },
    sourceRows: { type: [Number], required: true, default: [] },
  },
  knowledgeSchemaOptions('knowledge_synonym_mappings'),
);

defineKnowledgeIndex(KnowledgeSynonymMappingSchema, {
  name: 'ux_synonym_mapping_term',
  key: {
    workspaceId: 1,
    knowledgeSpaceId: 1,
    fileVersion: 1,
    normalizedStandardizedTerm: 1,
  },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeSynonymMappingSchema, {
  name: 'ux_synonym_mapping_logical',
  key: { workspaceId: 1, knowledgeSpaceId: 1, fileVersion: 1, logicalMappingId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeSynonymMappingSchema, {
  name: 'ix_synonym_mapping_all',
  key: { workspaceId: 1, knowledgeSpaceId: 1, fileVersion: 1, allTerms: 1 },
});

export interface KnowledgeModelBindingDoc extends WorkspaceFields {
  modelType: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
  modelId: string;
  displayName: string;
  requiredCapabilities: string[];
  status: 'active' | 'disabled';
  activeQueryModelId: string | null;
  activeQueryDimension: 768 | 1024 | 1536 | 3072 | null;
  authorizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeModelBindingSchema = new Schema(
  {
    ...knowledgeCommonFields,
    modelType: {
      type: String,
      enum: ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'],
      required: true,
    },
    modelId: { type: String, required: true },
    displayName: { type: String, required: true },
    requiredCapabilities: { type: [String], required: true, default: [] },
    status: {
      type: String,
      enum: ['active', 'disabled'],
      required: true,
      default: 'active',
    },
    activeQueryModelId: { type: String, default: null },
    activeQueryDimension: {
      type: Number,
      enum: [768, 1024, 1536, 3072, null],
      default: null,
    },
    authorizedAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_model_bindings'),
);

export interface KnowledgeModelSettingsDoc extends WorkspaceFields {
  version: number;
  models: Array<{
    modelId: string;
    displayName: string;
    provider: string;
    type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
    capabilities: string[];
    tags: string[];
    enabled: boolean;
    dimension: 768 | 1024 | 1536 | 3072 | null;
    limits?: Record<string, number>;
  }>;
  defaults: {
    embedding: string | null;
    textLLM: string | null;
    imageLLM: string | null;
  };
  updatedByMemberId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeModelSettingsSchema = new Schema(
  {
    ...knowledgeCommonFields,
    version: { type: Number, required: true, default: 0 },
    models: {
      type: [
        {
          modelId: { type: String, required: true },
          displayName: { type: String, required: true },
          provider: { type: String, required: true },
          type: {
            type: String,
            enum: ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'],
            required: true,
          },
          capabilities: { type: [String], required: true, default: [] },
          tags: { type: [String], required: true, default: [] },
          enabled: { type: Boolean, required: true, default: true },
          dimension: {
            type: Number,
            enum: [768, 1024, 1536, 3072, null],
            default: null,
          },
          limits: { type: Schema.Types.Mixed, default: undefined },
        },
      ],
      required: true,
      default: [],
    },
    defaults: {
      embedding: { type: String, default: null },
      textLLM: { type: String, default: null },
      imageLLM: { type: String, default: null },
    },
    updatedByMemberId: { type: String, required: true },
  },
  knowledgeSchemaOptions('knowledge_model_settings'),
);

defineKnowledgeIndex(KnowledgeModelSettingsSchema, {
  name: 'ux_model_settings_workspace',
  key: { workspaceId: 1 },
  options: { unique: true },
});

defineKnowledgeIndex(KnowledgeModelBindingSchema, {
  name: 'ux_model_binding',
  key: { workspaceId: 1, knowledgeSpaceId: 1, modelType: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeModelBindingSchema, {
  name: 'ix_model_binding_model',
  key: { workspaceId: 1, modelId: 1, status: 1 },
});
