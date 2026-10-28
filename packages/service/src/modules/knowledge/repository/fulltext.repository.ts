import type { Connection, Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeSegmentDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { projectFullText, type FullTextProjectionInput } from '../adapter/s06-jieba.tokenizer';

export class KnowledgeFullTextRepository {
  private readonly segments: Model<KnowledgeSegmentDoc>;

  constructor(connection: Connection) {
    this.segments = registerKnowledgeModels(connection).KnowledgeSegment;
  }

  prepare(input: FullTextProjectionInput) {
    return projectFullText(input);
  }

  async project(
    input: FullTextProjectionInput & { expectedVersion: number },
    context: TenantContext,
  ) {
    const projection = this.prepare(input);
    const updated = await this.segments.findOneAndUpdate(
      {
        _id: objectIdOf(input.segmentId, context, 'segmentId'),
        workspaceId: requireWorkspaceId(context),
        version: input.expectedVersion,
        sourceVersion: input.sourceVersion,
        deletedAt: null,
      },
      {
        $set: {
          fullTextTokens: projection.fullTextTokens,
          fullTextVersion: projection.fullTextVersion,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT', { segmentId: input.segmentId });
    return {
      ...projection,
      segmentVersion: updated.version,
      evidence: {
        tokenizerVersion: projection.tokenizerVersion,
        tokensHash: projection.tokensHash,
        fullTextVersion: projection.fullTextVersion,
        indexVersion: input.indexVersion,
      },
    };
  }
}
