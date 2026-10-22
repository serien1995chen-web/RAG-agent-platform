import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const MAX_DIRECTORY_DEPTH = 4;

export function assertResourceName(
  name: unknown,
  field: string,
  maxLength: number,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): string {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > maxLength) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field, maxLength },
    });
  }
  return name.trim();
}

export function assertDirectoryDepth(
  depth: number,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DIRECTORY_DEPTH) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'depth', maximum: MAX_DIRECTORY_DEPTH },
    });
  }
}

export function assertSameKnowledgeSpace(
  expected: string | null,
  actual: string | null,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (!expected || !actual || expected !== actual) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'knowledgeSpaceId', reason: 'cross_space_reference' },
    });
  }
}
