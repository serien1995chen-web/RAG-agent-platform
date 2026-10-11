/**
 * @kb/qa 去重与单块上限（设计文档 9.9.1 规则 2、3）。
 * 同一 Collection 内按去重键保留首条；单块超过 maxQaPerChunk 丢弃超出并计数告警。
 */
import { buildQaDedupKey } from "./dedup-key";
import type { QaResultItem } from "./types";

export interface DedupOutcome {
  items: QaResultItem[];
  duplicates: number;
  overLimit: number;
}

export function dedupeQaItems(items: readonly QaResultItem[], maxQaPerChunk: number): DedupOutcome {
  const seen = new Set<string>();
  const keptPerChunk = new Map<string, number>();
  const result: QaResultItem[] = [];
  let duplicates = 0;
  let overLimit = 0;
  for (const item of items) {
    const key = buildQaDedupKey(item.q, item.a);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    const used = keptPerChunk.get(item.sourceChunkHash) ?? 0;
    if (used >= maxQaPerChunk) {
      overLimit += 1;
      continue;
    }
    seen.add(key);
    keptPerChunk.set(item.sourceChunkHash, used + 1);
    result.push(item);
  }
  return { items: result, duplicates, overLimit };
}

/** 块数上限：超过 maxChunkCount 时截断并计数。 */
export function limitChunkCount<T>(items: readonly T[], maxChunkCount: number): { items: T[]; truncated: number } {
  if (items.length <= maxChunkCount) return { items: [...items], truncated: 0 };
  return { items: items.slice(0, maxChunkCount), truncated: items.length - maxChunkCount };
}
