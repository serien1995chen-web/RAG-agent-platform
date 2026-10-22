import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeTagDoc extends WorkspaceFields {
  key: string;
  label: string;
  tagType: 'string' | 'number' | 'datetime' | 'array';
  options: string[] | null;
  required: boolean;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeTagSchema = new Schema(
  {
    ...knowledgeCommonFields,
    key: {
      type: String,
      required: true,
      match: /^[a-z][a-z0-9_]{1,63}$/,
    },
    label: { type: String, required: true, maxlength: 120 },
    tagType: {
      type: String,
      enum: ['string', 'number', 'datetime', 'array'],
      required: true,
    },
    options: { type: [String], default: null },
    required: { type: Boolean, required: true, default: false },
    status: {
      type: String,
      enum: ['active', 'disabled'],
      required: true,
      default: 'active',
    },
  },
  knowledgeSchemaOptions('knowledge_tags'),
);

defineKnowledgeIndex(KnowledgeTagSchema, {
  name: 'ux_tag_key',
  key: { workspaceId: 1, knowledgeSpaceId: 1, key: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeTagSchema, {
  name: 'ix_tag_list',
  key: { workspaceId: 1, knowledgeSpaceId: 1, status: 1, label: 1 },
});

export interface KnowledgeTagValueDoc extends WorkspaceFields {
  tagId: Types.ObjectId;
  sourceId: Types.ObjectId;
  value: string | number | string[];
  valueType: 'string' | 'number' | 'datetime' | 'array';
  valueKey: string;
  sourceVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeTagValueSchema = new Schema(
  {
    ...knowledgeCommonFields,
    tagId: { type: Schema.Types.ObjectId, required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    valueType: {
      type: String,
      enum: ['string', 'number', 'datetime', 'array'],
      required: true,
    },
    valueKey: { type: String, required: true, maxlength: 512 },
    sourceVersion: { type: Number, required: true, min: 1 },
  },
  knowledgeSchemaOptions('knowledge_tag_values'),
);

defineKnowledgeIndex(KnowledgeTagValueSchema, {
  name: 'ux_tag_value',
  key: { workspaceId: 1, tagId: 1, sourceId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeTagValueSchema, {
  name: 'ix_tag_value_lookup',
  key: { workspaceId: 1, tagId: 1, valueKey: 1 },
});
