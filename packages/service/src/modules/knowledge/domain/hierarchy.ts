import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const MAX_DIRECTORY_DEPTH = 4;
export const MAX_CATALOG_DEPTH = MAX_DIRECTORY_DEPTH;

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

export function assertCatalogMoveDepth(
  depth: number,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_CATALOG_DEPTH) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        reason: 'maximum_depth_exceeded',
        maximum: MAX_CATALOG_DEPTH,
        depth,
      },
    });
  }
}

export function assertCatalogNoCycle(
  resourceId: string,
  targetParentId: string | null,
  targetParentPath: readonly string[],
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (
    targetParentId === resourceId ||
    (targetParentId !== null && targetParentPath.includes(resourceId))
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { reason: 'catalog_cycle', resourceId, targetParentId },
    });
  }
}

export function assertBatchVersions(
  ids: readonly string[],
  versions: unknown,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): Record<string, number> {
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'versions', reason: 'object_required' },
    });
  }
  const source = versions as Record<string, unknown>;
  const expected = new Set(ids);
  const actual = Object.keys(source);
  if (
    actual.length !== ids.length ||
    actual.some((id) => !expected.has(id)) ||
    ids.some((id) => !Object.hasOwn(source, id))
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'versions', reason: 'exact_item_versions_required' },
    });
  }
  const values: Record<string, number> = {};
  for (const id of ids) {
    const value = Number(source[id]);
    if (!Number.isInteger(value) || value < 1) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: `versions.${id}`, reason: 'positive_integer_required' },
      });
    }
    values[id] = value;
  }
  return values;
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
