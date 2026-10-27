import { createHash } from 'node:crypto';
import { DEFAULT_RRF_K } from './rrf';
import type { Candidate } from './types';
import { normalizedDedupeText } from './filter';

export function minMaxNormalize(scores: readonly number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => (max === 0 ? 0 : 1));
  return scores.map((score) => (score - min) / (max - min));
}

function mergeScore(target: Map<string, Candidate>, candidate: Candidate, score: number): void {
  const current = target.get(candidate.docId);
  if (!current) {
    target.set(candidate.docId, { ...candidate, score });
    return;
  }
  target.set(candidate.docId, {
    ...current,
    score: Math.max(current.score, score),
    scores: [...current.scores, ...candidate.scores],
  });
}

export function fuseCandidates(
  left: readonly Candidate[],
  right: readonly Candidate[],
  w: number,
): Candidate[] {
  const leftScores = minMaxNormalize(left.map((item) => item.score));
  const rightScores = minMaxNormalize(right.map((item) => item.score));
  const fused = new Map<string, Candidate>();

  left.forEach((candidate, index) => {
    mergeScore(fused, candidate, w * (leftScores[index] ?? 0));
  });
  right.forEach((candidate, index) => {
    const current = fused.get(candidate.docId);
    const contribution = (1 - w) * (rightScores[index] ?? 0);
    if (!current) {
      fused.set(candidate.docId, { ...candidate, score: contribution });
      return;
    }
    fused.set(candidate.docId, {
      ...current,
      score: current.score + contribution,
      scores: [...current.scores, ...candidate.scores],
    });
  });

  return [...fused.values()].sort(compareCandidates);
}

export function mergeChannelCandidates<T extends Candidate>(items: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const candidate of items) {
    const current = merged.get(candidate.docId);
    if (!current) {
      merged.set(candidate.docId, { ...candidate, scores: [...candidate.scores] });
      continue;
    }
    const embeddingScore = Math.max(
      current.embeddingScore ?? Number.NEGATIVE_INFINITY,
      candidate.embeddingScore ?? Number.NEGATIVE_INFINITY,
    );
    const fullTextScore = Math.max(
      current.fullTextScore ?? Number.NEGATIVE_INFINITY,
      candidate.fullTextScore ?? Number.NEGATIVE_INFINITY,
    );
    merged.set(candidate.docId, {
      ...current,
      ...(Number.isFinite(embeddingScore) ? { embeddingScore } : {}),
      ...(Number.isFinite(fullTextScore) ? { fullTextScore } : {}),
      score: Math.max(current.score, candidate.score),
      scores: [...current.scores, ...candidate.scores],
      text: current.text || candidate.text,
    });
  }
  return [...merged.values()];
}

export function mergeReranked(
  original: readonly Candidate[],
  reranked: ReadonlyArray<{ id: string; score: number }>,
  r: number,
): { items: Candidate[]; ignored: number } {
  const bestRerank = new Map<string, number>();
  for (const item of reranked) {
    bestRerank.set(
      item.id,
      Math.max(bestRerank.get(item.id) ?? Number.NEGATIVE_INFINITY, item.score),
    );
  }
  const originalIds = new Set(original.map((item) => item.docId));
  const ignored = [...bestRerank.keys()].filter((id) => !originalIds.has(id)).length;
  const items = original.flatMap((candidate) => {
    const rerankScore = bestRerank.get(candidate.docId);
    if (rerankScore === undefined) {
      return r < 1 ? [{ ...candidate, score: (1 - r) * candidate.score }] : [];
    }
    return [{ ...candidate, score: (1 - r) * candidate.score + r * rerankScore }];
  });
  return { items: items.sort(compareCandidates), ignored };
}

export function mergeRerankRankedLists(
  candidates: readonly Candidate[],
  reranked: ReadonlyArray<{ id: string; score: number }>,
  rerankWeight: number,
  k: number = DEFAULT_RRF_K,
): { items: Candidate[]; ignored: number; appliedIds: Set<string> } {
  const originalIds = new Set(candidates.map((candidate) => candidate.docId));
  const rerankById = new Map<string, { rank: number; score: number }>();
  let ignored = 0;
  reranked.forEach((entry, index) => {
    if (!originalIds.has(entry.id)) {
      ignored += 1;
      return;
    }
    if (!Number.isFinite(entry.score)) return;
    const previous = rerankById.get(entry.id);
    if (!previous || entry.score > previous.score) {
      rerankById.set(entry.id, { rank: index + 1, score: entry.score });
    }
  });

  const items = candidates.map((candidate, index) => {
    const originalContribution = (1 - rerankWeight) / (k + index + 1);
    const rerank = rerankById.get(candidate.docId);
    const rerankContribution = rerank ? rerankWeight / (k + rerank.rank) : 0;
    return {
      ...candidate,
      ...(rerank ? { rerankScore: rerank.score } : {}),
      score: originalContribution + rerankContribution,
    };
  });
  return {
    items: stableSortCandidates(items),
    ignored,
    appliedIds: new Set(rerankById.keys()),
  };
}

export function dedupeCandidates<T extends Candidate>(
  items: readonly T[],
  hashText: (item: Candidate) => string,
): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = normalizedDedupeText(hashText(item));
    const hash = createHash('sha256').update(key, 'utf8').digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    output.push(item);
  }
  return output;
}

export function filterBySimilarity<T extends Candidate>(
  items: readonly T[],
  threshold: number,
  scoreOf: (item: Candidate) => number | undefined = (item) => item.score,
): T[] {
  if (threshold <= 0) return [...items];
  return items.filter((item) => {
    const score = scoreOf(item);
    return score === undefined || score >= threshold;
  });
}

function visibleText(item: Candidate): string {
  return (
    item.text ||
    [item.segment?.question, item.segment?.answer, item.segment?.content]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
  );
}

export function trimCandidateText(
  item: Candidate,
  maxTokens: number,
  countTokens: (text: string) => number,
): Candidate | undefined {
  const text = visibleText(item);
  if (maxTokens < 1) return undefined;
  if (countTokens(text) <= maxTokens) {
    return { ...item, text, citationRange: { start: 0, end: [...text].length } };
  }
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(characters.slice(0, middle).join('')) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return undefined;
  const trimmed = characters.slice(0, low).join('');
  return {
    ...item,
    text: trimmed,
    citationRange: { start: 0, end: low },
    ...(item.segment
      ? {
          segment: {
            ...item.segment,
            question: '',
            answer: '',
            content: trimmed,
          },
        }
      : {}),
  };
}

export function applyTokenBudget<T extends Candidate>(
  items: readonly T[],
  maxTokens: number,
  countTokens: (text: string) => number,
): T[] {
  const output: T[] = [];
  let used = 0;
  for (const item of items) {
    const remaining = maxTokens - used;
    if (remaining < 1) break;
    const text = visibleText(item);
    const tokens = countTokens(text);
    if (used + tokens <= maxTokens) {
      output.push({
        ...item,
        text,
        citationRange: { start: 0, end: [...text].length },
      } as T);
      used += tokens;
      continue;
    }
    const trimmed = trimCandidateText(item, remaining, countTokens);
    if (!trimmed) continue;
    output.push(trimmed as T);
    used += countTokens(trimmed.text);
  }
  return output;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareCandidates(left: Candidate, right: Candidate): number {
  if (right.score !== left.score) return right.score - left.score;
  const segmentOrder = compareText(left.segmentId ?? left.docId, right.segmentId ?? right.docId);
  if (segmentOrder !== 0) return segmentOrder;
  return compareText(left.knowledgeSpaceId, right.knowledgeSpaceId);
}

export function stableSortCandidates<T extends Candidate>(items: readonly T[]): T[] {
  return [...items].sort(compareCandidates);
}

export function truncateByLimit<T extends Candidate>(items: readonly T[], limit: number): T[] {
  const effective = Math.max(1, Math.min(50, limit));
  return items.slice(0, effective);
}
