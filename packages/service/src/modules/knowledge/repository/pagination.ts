import { createKnowledgeError } from '@kb/contracts';
import { Types } from 'mongoose';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export interface PageRequest {
  cursor?: string;
  limit?: number | string;
  sort?: string;
}

export interface PageResult<T> {
  items: T[];
  pageInfo: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface SortSpec {
  field: 'createdAt' | 'updatedAt' | 'name' | 'order';
  direction: 1 | -1;
}

export function parseSort(
  raw: string | undefined,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): SortSpec {
  const input = raw?.trim() || '-updatedAt';
  const direction = input.startsWith('-') ? -1 : 1;
  const field = input.replace(/^-/, '');
  if (!['createdAt', 'updatedAt', 'name', 'order'].includes(field)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'sort', allowed: ['createdAt', 'updatedAt', 'name', 'order'] },
    });
  }
  return { field: field as SortSpec['field'], direction };
}

export function parseLimit(
  raw: unknown,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): number {
  if (raw === undefined) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'limit', minimum: 1, maximum: 200 },
    });
  }
  return value;
}

interface CursorValue {
  field: string;
  value: string | number;
  id: string;
}

export function decodeCursor(
  raw: string | undefined,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): CursorValue | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'cursor', reason: 'invalid' },
    });
  }
  const cursor = parsed as Partial<CursorValue>;
  if (
    typeof cursor.field !== 'string' ||
    typeof cursor.id !== 'string' ||
    !Types.ObjectId.isValid(cursor.id) ||
    (typeof cursor.value !== 'string' && typeof cursor.value !== 'number')
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'cursor', reason: 'invalid' },
    });
  }
  return cursor as CursorValue;
}

export function cursorFilter(sort: SortSpec, cursor: CursorValue | null): Record<string, unknown> {
  if (!cursor) return {};
  const comparator = sort.direction === -1 ? '$lt' : '$gt';
  return {
    $or: [
      { [sort.field]: { [comparator]: cursor.value } },
      {
        [sort.field]: cursor.value,
        _id: { [comparator]: new Types.ObjectId(cursor.id) },
      },
    ],
  };
}

export function encodeCursor(
  sort: SortSpec,
  document: Record<string, unknown> & { _id: unknown },
): string {
  const raw = document[sort.field];
  const value = raw instanceof Date ? raw.toISOString() : (raw as string | number);
  return Buffer.from(
    JSON.stringify({ field: sort.field, value, id: String(document._id) }),
    'utf8',
  ).toString('base64url');
}
