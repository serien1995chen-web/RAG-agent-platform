import { createKnowledgeError } from '@kb/contracts';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';
import type { S8ImageSearchApplication } from './s8-image-search.application';

export const S8_OPERATION_IDS = Object.freeze(['API-SEARCH-IMAGE', 'API-SEARCH-DEEP'] as const);

const S8_OPERATION_SET = new Set<string>(S8_OPERATION_IDS);

export function isS8Operation(operationId: string): boolean {
  return S8_OPERATION_SET.has(operationId);
}

export class S8SearchOperationApplication {
  constructor(
    private readonly image: S8ImageSearchApplication,
    private readonly deep?: {
      dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult>;
    },
  ) {}

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-SEARCH-IMAGE') {
      return this.image.dispatch(input);
    }
    if (input.operationId === 'API-SEARCH-DEEP' && this.deep) {
      return this.deep.dispatch(input);
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, application: 's8-search-operation' },
    });
  }
}
