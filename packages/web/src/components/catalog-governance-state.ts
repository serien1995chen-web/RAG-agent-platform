import { KnowledgeRequestError } from '../client/knowledge-client';

export type CatalogGovernanceState =
  | 'reference_blocked'
  | 'partial'
  | 'conflict'
  | 'forbidden'
  | 'validation'
  | 'error'
  | 'network';

export function catalogGovernanceState(error: unknown): CatalogGovernanceState {
  if (!(error instanceof KnowledgeRequestError)) return 'network';
  switch (error.problem.error.code) {
    case 'KNOWLEDGE_REFERENCE_CONFLICT':
      return 'reference_blocked';
    case 'KNOWLEDGE_PARTIAL_SUCCESS':
      return 'partial';
    case 'KNOWLEDGE_CONFLICT':
      return 'conflict';
    case 'KNOWLEDGE_FORBIDDEN':
      return 'forbidden';
    case 'KNOWLEDGE_VALIDATION_FAILED':
      return 'validation';
    default:
      return 'error';
  }
}

export function shouldResetMoveIdempotencyKey(error: unknown): boolean {
  return error instanceof KnowledgeRequestError && error.status >= 400 && error.status < 500;
}

export function batchResultRole(result: { failed: number }): 'alert' | 'status' {
  return result.failed > 0 ? 'alert' : 'status';
}

export function exportStatusTone(
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed',
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'idle') return 'neutral';
  return 'warning';
}

export function hasBlockingReference(items: readonly { status: string }[]): boolean {
  return items.some((item) => item.status === 'active');
}
