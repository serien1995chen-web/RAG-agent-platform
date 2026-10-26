import { parseQaOutput } from './parser';
import type { QaResultItem } from './parser';

export type QaValidationResult =
  | { valid: true; items: QaResultItem[] }
  | { valid: false; problems: string[] };

export function validateQaItems(
  items: readonly unknown[],
  sourceChunkHash: string,
): QaValidationResult {
  if (!Array.isArray(items)) return { valid: false, problems: ['items_not_array'] };
  const problems: string[] = [];
  const normalized: QaResultItem[] = [];
  items.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`items.${index}:not_object`);
      return;
    }
    const item = raw as Record<string, unknown>;
    const q = typeof item.q === 'string' ? item.q.trim() : '';
    const a = typeof item.a === 'string' ? item.a.trim() : '';
    if (q.length === 0) problems.push(`items.${index}.q:empty`);
    if (a.length === 0) problems.push(`items.${index}.a:empty`);
    if ([...q].length > 20_000) problems.push(`items.${index}.q:too_long`);
    if ([...a].length > 100_000) problems.push(`items.${index}.a:too_long`);
    if (typeof item.sourceChunkHash === 'string' && item.sourceChunkHash !== sourceChunkHash) {
      problems.push(`items.${index}.sourceChunkHash:mismatch`);
    }
    if (q.length > 0 && a.length > 0) {
      normalized.push({ q, a, sourceChunkHash });
    }
  });
  return problems.length > 0 ? { valid: false, problems } : { valid: true, items: normalized };
}

function strictJsonArray(content: string): unknown[] | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parses model output and permits exactly one repair path through @kb/qa's existing
 * parser/jsonrepair implementation. A second repair is never attempted here.
 */
export function repairQaOutputOnce(
  content: string,
  sourceChunkHash: string,
): { items: QaResultItem[]; repairCount: 0 | 1 } {
  const strict = strictJsonArray(content);
  if (strict !== null) {
    const validated = validateQaItems(strict, sourceChunkHash);
    return { items: validated.valid ? validated.items : [], repairCount: 0 };
  }
  const parsed = parseQaOutput(content, sourceChunkHash);
  return { items: parsed, repairCount: parsed.length > 0 ? 1 : 1 };
}
