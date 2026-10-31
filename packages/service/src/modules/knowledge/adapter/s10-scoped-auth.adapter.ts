import { createKnowledgeError } from '@kb/contracts';
import type { ScopedAuthPort } from '../application/ingestion.ports';
import type { KnowledgeAccessRepository } from '../repository/access.repository';

export class KnowledgeScopedAuthAdapter implements ScopedAuthPort {
  constructor(private readonly access: KnowledgeAccessRepository) {}

  async authorize(input: Parameters<ScopedAuthPort['authorize']>[0]): Promise<void> {
    if (!input.subject.workspaceIds.includes(input.workspaceId)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: 'scoped-auth',
        traceId: 'scoped-auth',
        details: { reason: 'workspace_mismatch' },
      });
    }
    if (
      !input.subject.scopes.includes(input.requiredScope) &&
      !input.subject.scopes.includes('knowledge:admin')
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: 'scoped-auth',
        traceId: 'scoped-auth',
        details: { requiredScope: input.requiredScope },
      });
    }
    const context = input.context;
    if (
      context.apiKeySpaceIds?.length &&
      !context.apiKeySpaceIds.includes(input.knowledgeSpaceId)
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'api_key_space_scope' },
      });
    }
    await this.access.assertPermission('space', input.knowledgeSpaceId, 'write', context);
  }
}
