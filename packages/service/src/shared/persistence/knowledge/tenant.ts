import { Types, type Model } from 'mongoose';
import { createKnowledgeError } from '@kb/contracts';

export interface TenantContext {
  workspaceId: string;
  memberId: string;
  requestId: string;
  traceId: string;
  apiKeyId?: string;
  scopes: readonly string[];
  isWorkspaceOwner?: boolean;
}

export interface WorkspaceFields {
  workspaceId: string;
  knowledgeSpaceId: Types.ObjectId | null;
  version: number;
  deletedAt: Date | null;
  createdByMemberId: string;
  updatedByMemberId: string;
}

export function tenantError(
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
  code:
    | 'KNOWLEDGE_VALIDATION_FAILED'
    | 'KNOWLEDGE_NOT_FOUND'
    | 'KNOWLEDGE_CONFLICT' = 'KNOWLEDGE_VALIDATION_FAILED',
  details: Record<string, unknown> = {},
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

export function requireWorkspaceId(context: TenantContext): string {
  const workspaceId = context.workspaceId?.trim();
  if (!workspaceId) {
    throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'workspaceId',
      reason: 'required',
    });
  }
  return workspaceId;
}

export function workspaceFilter(
  context: TenantContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { workspaceId: string; deletedAt: null } {
  return {
    ...extra,
    workspaceId: requireWorkspaceId(context),
    deletedAt: null,
  };
}

export function workspaceScopedModel<TDoc extends WorkspaceFields>(
  model: Model<TDoc>,
  context: TenantContext,
) {
  const workspaceId = requireWorkspaceId(context);
  return {
    model,
    workspaceId,
    filter(extra: Record<string, unknown> = {}): Record<string, unknown> {
      return workspaceFilter(context, extra);
    },
    assertOwned(doc: TDoc | null | undefined): TDoc {
      if (!doc || doc.workspaceId !== workspaceId || doc.deletedAt !== null) {
        throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      }
      return doc;
    },
  };
}

export function objectIdOf(
  value: string,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
  field: string,
): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
      field,
      reason: 'invalid_object_id',
    });
  }
  return new Types.ObjectId(value);
}
