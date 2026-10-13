import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../src/types';
import {
  applyTokenBudget,
  dedupeCandidates,
  fuseCandidates,
  mergeReranked,
  minMaxNormalize,
  truncateByLimit,
} from '../../src/fusion';

function candidate(docId: string, score: number): Candidate {
  return {
    docId,
    itemId: docId,
    collectionId: 'collection-a',
    score,
    scores: [{ type: 'embedding', value: score, index: 0 }],
    text: `question ${docId}answer`,
  };
}

describe('search fusion', () => {
  it('handles min-max normalization including all-equal input', () => {
    expect(minMaxNormalize([1, 2, 3])).toEqual([0, 0.5, 1]);
    expect(minMaxNormalize([2, 2, 2])).toEqual([1, 1, 1]);
    expect(minMaxNormalize([])).toEqual([]);
  });

  it('honours w zero and w one boundaries', () => {
    const left = [candidate('a', 1)];
    const right = [candidate('a', 1)];
    expect(fuseCandidates(left, right, 0)[0]?.score).toBe(1);
    expect(fuseCandidates(left, right, 1)[0]?.score).toBe(1);
  });

  it('contributes zero for a missing side', () => {
    const fused = fuseCandidates([candidate('a', 1)], [candidate('b', 1)], 0.5);
    expect(fused).toHaveLength(2);
    expect(fused.every((item) => item.score >= 0)).toBe(true);
  });

  it('keeps a non-reranked subset at (1-r) and drops it at r=1', () => {
    const original = [candidate('a', 2), candidate('b', 1)];
    const half = mergeReranked(original, [{ id: 'a', score: 4 }], 0.5);
    expect(half.items.find((item) => item.docId === 'b')?.score).toBe(0.5);
    const full = mergeReranked(original, [{ id: 'a', score: 4 }], 1);
    expect(full.items.map((item) => item.docId)).toEqual(['a']);
  });

  it('ignores unknown rerank ids and counts them', () => {
    const result = mergeReranked([candidate('a', 1)], [{ id: 'missing', score: 9 }], 0.5);
    expect(result.ignored).toBe(1);
  });

  it('uses the highest score for duplicate rerank ids', () => {
    const result = mergeReranked(
      [candidate('a', 0)],
      [
        { id: 'a', score: 1 },
        { id: 'a', score: 3 },
      ],
      1,
    );
    expect(result.items[0]?.score).toBe(3);
  });

  it('deduplicates by hash and keeps the earlier item', () => {
    const first = candidate('a', 1);
    const second = candidate('b', 2);
    const deduped = dedupeCandidates([first, second], (item) =>
      item.docId === 'b' ? 'same' : 'other',
    );
    expect(deduped).toEqual([first, second]);
    const duplicate = dedupeCandidates([first, { ...second, docId: 'a' }], () => 'same');
    expect(duplicate).toEqual([first]);
  });

  it('keeps the first item when the token budget is already exceeded', () => {
    const items = [candidate('a', 1), candidate('b', 0.5)];
    expect(applyTokenBudget(items, 0, () => 100)).toEqual([items[0]]);
    expect(applyTokenBudget(items, 100, () => 100)).toHaveLength(1);
    expect(applyTokenBudget(items, 200, () => 100)).toHaveLength(2);
  });

  it('bills token budget from candidate text instead of serialized JSON', () => {
    const seen: string[] = [];
    const items = [{ ...candidate('a', 1), text: 'question-answer' }];
    applyTokenBudget(items, 100, (text) => {
      seen.push(text);
      return 1;
    });
    expect(seen).toEqual(['question-answer']);
    expect(seen[0]).not.toContain('docId');
  });

  it('truncates within the 1-50 limit', () => {
    const items = Array.from({ length: 60 }, (_, index) => candidate(String(index), index));
    expect(truncateByLimit(items, 0)).toHaveLength(1);
    expect(truncateByLimit(items, 60)).toHaveLength(50);
  });
});
