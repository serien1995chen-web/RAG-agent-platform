import type { KnowledgeProblem } from '@kb/contracts';
import type {
  S09SynonymConfigData,
  S09SynonymJobData,
  S09SynonymMappingData,
} from '../client/s09-synonym-client';

export type S09SynonymUiState =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | {
      kind: 'invalid_file';
      code: string;
      traceId?: string;
      diagnostics: Array<{
        rowNumber: number | null;
        columnNumber: number | null;
        messageKey: string;
      }>;
      totalDiagnostics: number;
      truncated: boolean;
      retryable: false;
    }
  | {
      kind: 'rebuilding';
      config: S09SynonymConfigData;
      job?: S09SynonymJobData;
    }
  | {
      kind: 'failed';
      config: S09SynonymConfigData;
      code: string;
      traceId?: string;
      retryable: boolean;
    }
  | {
      kind: 'disabled';
      config: S09SynonymConfigData;
    }
  | {
      kind: 'ready';
      config: S09SynonymConfigData;
      mappings: S09SynonymMappingData[];
      nextCursor: string | null;
      hasMore: boolean;
      job?: S09SynonymJobData;
    }
  | {
      kind: 'conflict' | 'rate_limited' | 'error' | 'permission' | 'payload_too_large';
      code: string;
      traceId?: string;
      messageKey: string;
      retryable: boolean;
      config?: S09SynonymConfigData;
    };

export interface S09SynonymFileDraft {
  name: string;
  sizeBytes: number;
}

export function validateSynonymFileDraft(
  file: S09SynonymFileDraft | null,
): { valid: true } | { valid: false; field: 'file'; reason: string } {
  if (!file) return { valid: false, field: 'file', reason: 'required' };
  if (!/\.(?:csv|xls|xlsx)$/i.test(file.name)) {
    return { valid: false, field: 'file', reason: 'extension' };
  }
  if (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 1) {
    return { valid: false, field: 'file', reason: 'empty' };
  }
  if (file.sizeBytes > 10 * 1024 * 1024) {
    return { valid: false, field: 'file', reason: 'size' };
  }
  return { valid: true };
}

function detailsOf(problem: KnowledgeProblem): Record<string, unknown> {
  return problem.error.details ?? {};
}

export function messageKeyOf(problem: KnowledgeProblem): string {
  const details = detailsOf(problem);
  return typeof details.messageKey === 'string' ? details.messageKey : problem.error.code;
}

export function synonymUiState(input: {
  loading?: boolean;
  config?: S09SynonymConfigData | null;
  mappings?: S09SynonymMappingData[];
  nextCursor?: string | null;
  hasMore?: boolean;
  job?: S09SynonymJobData;
  problem?: KnowledgeProblem | null;
}): S09SynonymUiState {
  if (input.loading) return { kind: 'loading' };
  if (input.problem) {
    const details = detailsOf(input.problem);
    if (input.problem.error.code === 'KNOWLEDGE_SYNONYM_INVALID') {
      const rawDiagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
      return {
        kind: 'invalid_file',
        code: input.problem.error.code,
        traceId: input.problem.traceId,
        diagnostics: rawDiagnostics
          .filter(
            (item): item is Record<string, unknown> =>
              typeof item === 'object' && item !== null && !Array.isArray(item),
          )
          .slice(0, 100)
          .map((item) => ({
            rowNumber: Number.isInteger(item.rowNumber) ? Number(item.rowNumber) : null,
            columnNumber: Number.isInteger(item.columnNumber) ? Number(item.columnNumber) : null,
            messageKey:
              typeof item.messageKey === 'string' ? item.messageKey : input.problem!.error.code,
          })),
        totalDiagnostics: Number(details.totalDiagnostics ?? rawDiagnostics.length),
        truncated: details.truncated === true,
        retryable: false,
      };
    }
    const kind =
      input.problem.error.code === 'KNOWLEDGE_CONFLICT'
        ? 'conflict'
        : input.problem.error.code === 'KNOWLEDGE_RATE_LIMITED'
          ? 'rate_limited'
          : input.problem.error.code === 'KNOWLEDGE_FORBIDDEN' ||
              input.problem.error.code === 'KNOWLEDGE_NOT_FOUND'
            ? 'permission'
            : input.problem.error.code === 'KNOWLEDGE_PAYLOAD_TOO_LARGE'
              ? 'payload_too_large'
              : 'error';
    return {
      kind,
      code: input.problem.error.code,
      traceId: input.problem.traceId,
      messageKey: messageKeyOf(input.problem),
      retryable: input.problem.error.retryable,
      ...(input.config ? { config: input.config } : {}),
    };
  }
  if (!input.config) return { kind: 'empty' };
  if (input.config.status === 'disabled' || !input.config.enabled) {
    return { kind: 'disabled', config: input.config };
  }
  if (input.config.status === 'rebuilding' || input.job?.status === 'running') {
    return {
      kind: 'rebuilding',
      config: input.config,
      ...(input.job ? { job: input.job } : {}),
    };
  }
  if (input.config.status === 'failed') {
    return {
      kind: 'failed',
      config: input.config,
      code: input.config.lastError?.code ?? 'KNOWLEDGE_SYNONYM_REBUILD_FAILED',
      retryable: true,
    };
  }
  return {
    kind: 'ready',
    config: input.config,
    mappings: input.mappings ?? [],
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore ?? false,
    ...(input.job ? { job: input.job } : {}),
  };
}
