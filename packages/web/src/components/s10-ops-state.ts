import { KnowledgeRequestError } from '../client/knowledge-client';

export type S10UiState =
  | 'loading'
  | 'empty'
  | 'partial'
  | 'forbidden'
  | 'conflict'
  | 'quota'
  | 'dependency'
  | 'error'
  | 'success';

export function s10UiState(input: {
  loading?: boolean;
  error?: unknown;
  itemCount?: number;
  partial?: boolean;
}): S10UiState {
  if (input.loading) return 'loading';
  if (input.partial) return 'partial';
  if (input.error instanceof KnowledgeRequestError) {
    const code = input.error.problem.error.code;
    if (code === 'KNOWLEDGE_FORBIDDEN') return 'forbidden';
    if (code === 'KNOWLEDGE_CONFLICT') return 'conflict';
    if (code === 'KNOWLEDGE_QUOTA_EXCEEDED') return 'quota';
    if (code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' || code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') {
      return 'dependency';
    }
    return 'error';
  }
  if (input.error) return 'error';
  if ((input.itemCount ?? 0) === 0) return 'empty';
  return 'success';
}

export function createSecretDraft(secret: string | null): { secret: string | null } {
  return { secret };
}
