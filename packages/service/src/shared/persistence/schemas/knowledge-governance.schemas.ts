import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeSynonymConfigDoc extends WorkspaceFields {
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  activeFileVersion: number;
  enabled: boolean;
  schemaVersion: number;
  status: 'active' | 'disabled' | 'rebuilding' | 'failed';
  uploadTime: Date;
  uploadedByMemberId: string;
  lastError: Record<string, unknown> | null;
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
    authorizedAt: { type: Date, required: true },
  },
  knowledgeSchemaOptions('knowledge_model_bindings'),
);

defineKnowledgeIndex(KnowledgeModelBindingSchema, {
  name: 'ux_model_binding',
  key: { workspaceId: 1, knowledgeSpaceId: 1, modelType: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeModelBindingSchema, {
  name: 'ix_model_binding_model',
  key: { workspaceId: 1, modelId: 1, status: 1 },
});
