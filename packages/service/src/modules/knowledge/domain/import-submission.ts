import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const MAX_IMPORT_FILES = 1000;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_URL_BYTES = 50 * 1024 * 1024;
export const MAX_TEMPLATE_ROWS = 100_000;
export const MAX_TEMPLATE_COLUMNS = 1000;
export const MAX_TEMPLATE_CELLS = 1_000_000;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Of(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requestHashOf(value: unknown): string {
  return sha256Of(stableJson(value));
}

export function assertNonEmptyText(
  value: string,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'text', reason: 'required' },
    });
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'text', limitBytes: MAX_TEXT_BYTES },
    });
  }
  return value;
}

export function assertUniqueIds(
  values: readonly string[],
  field: string,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
  max = MAX_IMPORT_FILES,
): string[] {
  const unique = [...new Set(values)];
  if (values.length < 1 || values.length > max || unique.length !== values.length) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field, min: 1, max, unique: true },
    });
  }
  return unique;
}
