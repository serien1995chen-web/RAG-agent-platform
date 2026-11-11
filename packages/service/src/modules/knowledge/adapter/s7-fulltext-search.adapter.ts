import { createKnowledgeError } from '@kb/contracts';
import type { SearchEngineDeps } from '@kb/search';
import type { S7FullTextSearchPort } from '../application/s7-search.ports';

export class S7FullTextSearchAdapter {
  constructor(private readonly repository: S7FullTextSearchPort) {}

  search: NonNullable<SearchEngineDeps['fullText']>['search'] = async (input, context) => {
    const tenantContext = context as {
      requestId: string;
      workspaceId: string;
      memberId?: string;
      traceId?: string;
    };
    const memberId = tenantContext.memberId?.trim();
    if (!memberId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: tenantContext.requestId,
        traceId: tenantContext.traceId ?? tenantContext.requestId,
        details: { field: 'memberId', reason: 'required' },
      });
    }
    return this.repository.search(input, {
      requestId: tenantContext.requestId,
      workspaceId: tenantContext.workspaceId,
      memberId,
    });
  };
}
