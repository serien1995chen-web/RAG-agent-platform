import { createKnowledgeError } from '@kb/contracts';
import { Types, type Model } from 'mongoose';
import type { TenantContext, WorkspaceFields } from './tenant';

export interface CasUpdateInput {
  id: string;
  expectedVersion: number;
  update: Record<string, unknown>;
  unset?: Record<string, 1>;
}

export async function workspaceCasUpdate<TDoc extends WorkspaceFields>(
  model: Model<TDoc>,
  input: CasUpdateInput,
  context: TenantContext,
): Promise<TDoc> {
  if (!Types.ObjectId.isValid(input.id)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'id', reason: 'invalid_object_id' },
    });
  }
  const updated = await model.findOneAndUpdate(
    {
      _id: new Types.ObjectId(input.id),
      workspaceId: context.workspaceId,
      version: input.expectedVersion,
      deletedAt: null,
    },
    {
      $set: {
        ...input.update,
        updatedByMemberId: context.memberId,
      },
      ...(input.unset ? { $unset: input.unset } : {}),
      $inc: { version: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { resourceId: input.id, expectedVersion: input.expectedVersion },
    });
  }
  return updated;
}
