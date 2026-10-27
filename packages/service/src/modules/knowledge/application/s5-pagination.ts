import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { S5_MODEL_TYPES, type S5ModelType } from './s5-model-ports';

export const S5_MODEL_QUERY_SORTS = ['modelType', '-modelType', 'modelId', '-modelId'] as const;

export type S5ModelQuerySort = (typeof S5_MODEL_QUERY_SORTS)[number];

interface PageCursor {
  v: 1;
  sort: S5ModelQuerySort;
  modelType: S5ModelType;
  modelId: string;
}

interface KeyedModel {
  modelType: S5ModelType;
  modelId: string;
}

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
): S5ModelQuerySort {
  const sort = queryValue(query, 'sort') ?? 'modelType';
  if (!(S5_MODEL_QUERY_SORTS as readonly string[]).includes(sort)) {
    return invalid(context, 'sort', 'allowlist_required');
  }
  return sort as S5ModelQuerySort;
}

export function parsePageCursor(
  query: Record<string, string | string[] | undefined>,
  sort: S5ModelQuerySort,
  context: TenantContext,
): PageCursor | null {
  const encoded = queryValue(query, 'cursor');
  if (encoded === undefined || encoded === '') return null;
  if (encoded.length > 2_048) return invalid(context, 'cursor', 'invalid');
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid(context, 'cursor', 'invalid');
  let parsed: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return invalid(context, 'cursor', 'invalid');
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    return invalid(context, 'cursor', 'invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid(context, 'cursor', 'invalid');
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (
    keys !== 'lastModelId,lastModelType,sort,v' ||
    value.v !== 1 ||
    value.sort !== sort ||
    typeof value.lastModelType !== 'string' ||
    !(S5_MODEL_TYPES as readonly string[]).includes(value.lastModelType) ||
    typeof value.lastModelId !== 'string' ||
    value.lastModelId.length === 0 ||
    value.lastModelId.length > 256
  ) {
    return invalid(context, 'cursor', 'invalid');
  }
  return {
    v: 1,
    sort,
    modelType: value.lastModelType as S5ModelType,
    modelId: value.lastModelId,
  };
}

export function assertPageCursorExists<T extends KeyedModel>(
  cursor: Pick<KeyedModel, 'modelType' | 'modelId'> | null,
  items: readonly T[],
  context: TenantContext,
): void {
  if (
    cursor &&
    !items.some((item) => item.modelType === cursor.modelType && item.modelId === cursor.modelId)
  ) {
    invalid(context, 'cursor', 'key_not_found');
  }
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareBySort(
  left: Pick<KeyedModel, 'modelType' | 'modelId'>,
  right: Pick<KeyedModel, 'modelType' | 'modelId'>,
  sort: S5ModelQuerySort,
): number {
  if (sort === 'modelId' || sort === '-modelId') {
    const compared = compareText(left.modelId, right.modelId);
    return sort === '-modelId' ? -compared : compared;
  }
  const compared =
    S5_MODEL_TYPES.indexOf(left.modelType) - S5_MODEL_TYPES.indexOf(right.modelType) ||
    compareText(left.modelId, right.modelId);
  return sort === '-modelType' ? -compared : compared;
}

function cursorOf(last: KeyedModel, sort: S5ModelQuerySort): string {
  const payload: PageCursor = {
    v: 1,
    sort,
    modelType: last.modelType,
    modelId: last.modelId,
  };
  return Buffer.from(
    JSON.stringify({
      v: payload.v,
      sort: payload.sort,
      lastModelType: payload.modelType,
      lastModelId: payload.modelId,
    }),
    'utf8',
  ).toString('base64url');
}

export function paginateByKey<T extends KeyedModel>(
  items: readonly T[],
  sort: S5ModelQuerySort,
  cursor: Pick<KeyedModel, 'modelType' | 'modelId'> | null,
  limit: number,
): {
  items: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
} {
  const sorted = [...items].sort((left, right) => compareBySort(left, right, sort));
  const remaining = cursor
    ? sorted.filter((item) => compareBySort(item, cursor, sort) > 0)
    : sorted;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  const last = page.at(-1);
  return {
    items: page,
    pageInfo: {
      nextCursor: hasMore && last ? cursorOf(last, sort) : null,
      hasMore,
    },
  };
}
