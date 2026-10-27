import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const S5_MODEL_QUERY_SORTS = [
  'updatedAt',
  '-updatedAt',
  'modelType',
  '-modelType',
  'modelId',
  '-modelId',
] as const;

function invalid(context: TenantContext, field: string, reason: string): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { field, reason },
  });
}

export function queryValue(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parsePageLimit(
  query: Record<string, string | string[] | undefined>,
  context: TenantContext,
): number {
  const raw = queryValue(query, 'limit');
  if (raw === undefined) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return invalid(context, 'limit', 'integer_1_to_200_required');
  }
  return limit;
}

export function parseModelSort(
  query: Record<string, string | string[] | undefined>,
  context: TenantContext,
): (typeof S5_MODEL_QUERY_SORTS)[number] {
  const sort = queryValue(query, 'sort') ?? '-updatedAt';
  if (!(S5_MODEL_QUERY_SORTS as readonly string[]).includes(sort)) {
    return invalid(context, 'sort', 'allowlist_required');
  }
  return sort as (typeof S5_MODEL_QUERY_SORTS)[number];
}

export function parsePageOffset(
  query: Record<string, string | string[] | undefined>,
  context: TenantContext,
): number {
  const cursor = queryValue(query, 'cursor');
  if (cursor === undefined || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) {
      return invalid(context, 'cursor', 'invalid');
    }
    return Number(parsed.offset);
  } catch {
    return invalid(context, 'cursor', 'invalid');
  }
}

export function pageInfoOf(total: number, offset: number, limit: number) {
  const nextOffset = offset + limit;
  return {
    nextCursor:
      nextOffset < total
        ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
        : null,
    hasMore: nextOffset < total,
  };
}
