import { createHash } from 'node:crypto';
import type { Candidate } from './types';

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

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export function mergeReranked(
  original: readonly Candidate[],
  reranked: readonly { id: string; score: number }[],
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

  return { items: items.sort((a, b) => b.score - a.score), ignored };
}

export function dedupeCandidates(
  items: readonly Candidate[],
  hashText: (item: Candidate) => string,
): Candidate[] {
  const seen = new Set<string>();
  const output: Candidate[] = [];
  for (const item of items) {
    const hash = createHash('sha256')
      .update(hashText(item).normalize('NFKC'), 'utf8')
      .digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    output.push(item);
  }
  return output;
}

export function filterBySimilarity(items: readonly Candidate[], threshold: number): Candidate[] {
  return items.filter((item) => item.score >= threshold);
}

export function applyTokenBudget(
  items: readonly Candidate[],
  maxTokens: number,
  countTokens: (text: string) => number,
): Candidate[] {
  if (items.length === 0) return [];
  const output: Candidate[] = [];
  let used = 0;
  for (const item of items) {
    const tokens = countTokens(item.text ?? '');
    if (output.length > 0 && used + tokens > maxTokens) break;
    output.push(item);
    used += tokens;
  }
  return output;
}

export function truncateByLimit(items: readonly Candidate[], limit: number): Candidate[] {
  const effective = Math.max(1, Math.min(50, limit));
  return items.slice(0, effective);
}
