import { jsonrepair } from 'jsonrepair';
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

export interface QaParsedValidation {
  items: QaResultItem[];
  problems: string[];
  repairCount: 0 | 1;
}

export function parseQaOutputValidated(
  content: string,
  sourceChunkHash: string,
): QaParsedValidation {
  if (!content.trim()) return { items: [], problems: ['output_empty'], repairCount: 0 };
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const fragment = content.slice(start, end + 1);
    let parsed: unknown;
    let repairCount: 0 | 1 = 0;
    try {
      parsed = JSON.parse(fragment);
    } catch {
      repairCount = 1;
      try {
        parsed = JSON.parse(jsonrepair(fragment));
      } catch {
        return { items: [], problems: ['json_unrepairable'], repairCount };
      }
    }
    if (!Array.isArray(parsed)) {
      return { items: [], problems: ['items_not_array'], repairCount };
    }
    const validated = validateQaItems(parsed, sourceChunkHash);
    return validated.valid
      ? { items: validated.items, problems: [], repairCount }
      : { items: [], problems: validated.problems, repairCount };
  }
  const parsed = parseQaOutput(content, sourceChunkHash);
  const validated = validateQaItems(parsed, sourceChunkHash);
  return validated.valid && validated.items.length > 0
    ? { items: validated.items, problems: [], repairCount: 1 }
    : {
        items: [],
        problems: validated.valid ? ['items_empty'] : validated.problems,
        repairCount: 1,
      };
}

/**
 * Parses model output and permits exactly one repair path through @kb/qa's existing
 * parser/jsonrepair implementation. A second repair is never attempted here.
 */
export function repairQaOutputOnce(content: string, sourceChunkHash: string): QaParsedValidation {
  return parseQaOutputValidated(content, sourceChunkHash);
}
