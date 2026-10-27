import { createKnowledgeError } from '@kb/contracts';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './knowledge.application';
import type { S7CitationApplication } from './s7-citation.application';
import type { S7SearchApplication } from './s7-search.application';

export class S7SearchOperationApplication {
  constructor(
    private readonly search: S7SearchApplication,
    private readonly citation: S7CitationApplication,
  ) {}

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-CITATION-GET') {
      const citationId = input.params.citationId ?? '';
      if (!citationId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { field: 'citationId', reason: 'required' },
        });
      }
      return {
        status: 200,
        data: await this.citation.get(citationId, input.context),
      };
    }
    if (
      input.operationId === 'API-SEARCH-SEMANTIC' ||
      input.operationId === 'API-SEARCH-FULLTEXT' ||
      input.operationId === 'API-SEARCH-HYBRID' ||
      input.operationId === 'API-SEARCH-MULTI'
    ) {
      return this.search.dispatch(input);
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, application: 's7-search-operation' },
    });
  }
}
