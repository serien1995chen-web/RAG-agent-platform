import type { SearchApiResponse } from '@kb/contracts';
import { S7DownstreamKnowledgeError } from '../client/s7-downstream-knowledge-client';

export type S7SearchUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: SearchApiResponse }
  | { kind: 'empty'; result: SearchApiResponse }
  | { kind: 'partial'; result: SearchApiResponse }
  | { kind: 'degraded'; result: SearchApiResponse }
  | {
      kind: 'error' | 'permission' | 'timeout' | 'rate_limited';
      code: string;
      traceId?: string;
      retryable: boolean;
    };

export function classifyS7SearchState(input: {
  loading?: boolean;
  result?: SearchApiResponse;
  error?: unknown;
}): S7SearchUiState {
  if (input.loading) return { kind: 'loading' };
  if (input.error) {
    if (input.error instanceof S7DownstreamKnowledgeError) {
      const status = input.error.status;
      return {
        kind:
          status === 401 || status === 403 || status === 404
            ? 'permission'
            : status === 429
              ? 'rate_limited'
              : status === 504
                ? 'timeout'
                : 'error',
        code: input.error.problem.error.code,
        traceId: input.error.problem.traceId,
        retryable: input.error.problem.error.retryable,
      };
    }
    return {
      kind: 'error',
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      retryable: true,
    };
  }
  if (!input.result) return { kind: 'idle' };
  if (input.result.partial) return { kind: 'partial', result: input.result };
  if (input.result.items.length === 0) return { kind: 'empty', result: input.result };
  if ((input.result.degraded?.length ?? 0) > 0) {
    return { kind: 'degraded', result: input.result };
  }
  return { kind: 'ready', result: input.result };
}

export function similarityControlEnabled(mode: string, usingRerank: boolean): boolean {
  return mode === 'semantic' || usingRerank;
}

export function safeDegradedCode(code: string): string | null {
  if (
    code === 'vector_recall_failed' ||
    code === 'fulltext_recall_failed' ||
    code === 'rerank_failed' ||
    code === 'rerank_not_configured'
  ) {
    return code;
  }
  return /^space_[a-f0-9]{24}_failed$/.test(code) ? code : null;
}
