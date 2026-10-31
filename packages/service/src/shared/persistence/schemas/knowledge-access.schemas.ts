import { Schema, type Types } from 'mongoose';
import { defineKnowledgeIndex } from '../knowledge-define-index';
import { knowledgeCommonFields, knowledgeSchemaOptions } from '../knowledge/common.schema';
import type { WorkspaceFields } from '../knowledge/tenant';

export interface KnowledgeResourcePermissionDoc extends WorkspaceFields {
  resourceType: 'space' | 'directory' | 'source';
  resourceId: Types.ObjectId;
  principalType: 'member' | 'group' | 'workspace';
  principalId: string;
  permission: 'read' | 'write' | 'manage' | 'owner';
  inheritMode: 'inherit' | 'override';
  snapshotVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeResourcePermissionSchema = new Schema(
  {
    ...knowledgeCommonFields,
    resourceType: {
      type: String,
      enum: ['space', 'directory', 'source'],
      required: true,
    },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    principalType: {
      type: String,
      enum: ['member', 'group', 'workspace'],
      required: true,
    },
    principalId: { type: String, required: true },
    permission: {
      type: String,
      enum: ['read', 'write', 'manage', 'owner'],
      required: true,
    },
    inheritMode: {
      type: String,
      enum: ['inherit', 'override'],
      required: true,
      default: 'inherit',
    },
    snapshotVersion: { type: Number, required: true, min: 1, default: 1 },
  },
  knowledgeSchemaOptions('knowledge_resource_permissions'),
);

defineKnowledgeIndex(KnowledgeResourcePermissionSchema, {
  name: 'ux_acl_principal',
  key: {
    workspaceId: 1,
    resourceType: 1,
    resourceId: 1,
    principalType: 1,
    principalId: 1,
  },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeResourcePermissionSchema, {
  name: 'ix_acl_lookup',
  key: { workspaceId: 1, principalType: 1, principalId: 1, resourceType: 1 },
});

export interface KnowledgeCollaboratorDoc extends WorkspaceFields {
  memberId: string;
  role: 'read' | 'write' | 'manage' | 'owner';
  status: 'active' | 'revoked';
  grantedAt: Date;
  grantedByMemberId: string;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeCollaboratorSchema = new Schema(
  {
    ...knowledgeCommonFields,
    memberId: { type: String, required: true },
    role: {
      type: String,
      enum: ['read', 'write', 'manage', 'owner'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'revoked'],
      required: true,
      default: 'active',
    },
    grantedAt: { type: Date, required: true },
    grantedByMemberId: { type: String, required: true },
    revokedAt: { type: Date, default: null },
  },
  knowledgeSchemaOptions('knowledge_collaborators'),
);

defineKnowledgeIndex(KnowledgeCollaboratorSchema, {
  name: 'ux_collaborator',
  key: { workspaceId: 1, knowledgeSpaceId: 1, memberId: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeCollaboratorSchema, {
  name: 'ix_collaborator_member',
  key: { workspaceId: 1, memberId: 1, status: 1 },
});

export interface KnowledgeReferenceBindingDoc extends WorkspaceFields {
  resourceType: 'space';
  resourceId: Types.ObjectId;
  referrerType: 'app' | 'workflow';
  referrerId: string;
  referrerVersion: string;
  referrerName: string;
  status: 'active' | 'stale' | 'removed';
  registryRevision: number;
  lastSeenAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeReferenceBindingSchema = new Schema(
  {
    ...knowledgeCommonFields,
    resourceType: { type: String, enum: ['space'], required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    referrerType: { type: String, enum: ['app', 'workflow'], required: true },
    referrerId: { type: String, required: true },
    referrerVersion: { type: String, required: true },
    referrerName: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'stale', 'removed'],
      required: true,
      default: 'active',
    },
    registryRevision: { type: Number, required: true, min: 0, default: 1 },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
  },
  knowledgeSchemaOptions('knowledge_reference_bindings'),
);

defineKnowledgeIndex(KnowledgeReferenceBindingSchema, {
  name: 'ux_reference_binding',
  key: {
    workspaceId: 1,
    resourceType: 1,
    resourceId: 1,
    referrerType: 1,
    referrerId: 1,
    referrerVersion: 1,
  },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeReferenceBindingSchema, {
  name: 'ix_reference_space_status',
  key: { workspaceId: 1, knowledgeSpaceId: 1, status: 1, lastSeenAt: -1 },
});
defineKnowledgeIndex(KnowledgeReferenceBindingSchema, {
  name: 'ix_reference_referrer',
  key: { workspaceId: 1, referrerType: 1, referrerId: 1, status: 1 },
});
defineKnowledgeIndex(KnowledgeReferenceBindingSchema, {
  name: 'ttl_reference_binding',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export interface KnowledgeApiKeyDoc extends WorkspaceFields {
  name: string;
  keyPrefix: string;
  secretHash: string;
  scopes: string[];
  spaceIds: Types.ObjectId[];
  status: 'active' | 'rotated' | 'revoked' | 'expired';
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  rotatedFromKeyId: Types.ObjectId | null;
  rotatedToKeyId: Types.ObjectId | null;
  rotatedAt: Date | null;
  retireAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const KnowledgeApiKeySchema = new Schema(
  {
    ...knowledgeCommonFields,
    name: { type: String, required: true, maxlength: 120 },
    keyPrefix: { type: String, required: true, minlength: 12, maxlength: 24 },
    secretHash: { type: String, required: true, select: false },
    scopes: {
      type: [String],
      required: true,
      default: [],
      enum: [
        'knowledge:read',
        'knowledge:search',
        'knowledge:write',
        'knowledge:manage',
        'knowledge:admin',
      ],
    },
    spaceIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
    status: {
      type: String,
      enum: ['active', 'rotated', 'revoked', 'expired'],
      required: true,
      default: 'active',
    },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    rotatedFromKeyId: { type: Schema.Types.ObjectId, default: null },
    rotatedToKeyId: { type: Schema.Types.ObjectId, default: null },
    rotatedAt: { type: Date, default: null },
    retireAt: { type: Date, default: null },
  },
  knowledgeSchemaOptions('knowledge_api_keys'),
);

defineKnowledgeIndex(KnowledgeApiKeySchema, {
  name: 'ux_api_key_prefix',
  key: { workspaceId: 1, keyPrefix: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeApiKeySchema, {
  name: 'ux_api_key_hash',
  key: { secretHash: 1 },
  options: { unique: true },
});
defineKnowledgeIndex(KnowledgeApiKeySchema, {
  name: 'ix_api_key_status',
  key: { workspaceId: 1, status: 1, expiresAt: 1, retireAt: 1 },
});
