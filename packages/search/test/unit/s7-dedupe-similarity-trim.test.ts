import { describe, expect, it } from 'vitest';
import {
  applyTokenBudget,
  dedupeCandidates,
  filterBySimilarity,
  type Candidate,
} from '../../src/index';

function candidate(input: Partial<Candidate> & { docId: string; score: number }): Candidate {
  return {
    segmentId: input.docId,
    sourceId: 'source-a',
    knowledgeSpaceId: 'space-a',
    scores: [],
    text: input.docId,
    ...input,
  };
}

describe('TEST-SEARCH-005-BLOCK dedupe, similarity and token trim', () => {
  it('deduplicates after NFKC and non-alphanumeric removal', () => {
    const items = [
      candidate({ docId: 'a', score: 1, text: 'ＡＢＣ， refund!' }),
      candidate({ docId: 'b', score: 0.9, text: 'ABC refund' }),
    ];
    expect(dedupeCandidates(items, (item) => item.text).map((item) => item.docId)).toEqual(['a']);
  });

  it('filters by the supplied score domain rather than RRF', () => {
    const items = [
      candidate({
        docId: 'a',
        score: 0.01,
        embeddingScore: 0.8,
        rerankScore: undefined,
      }),
      candidate({
        docId: 'b',
        score: 0.9,
        embeddingScore: 0.1,
        rerankScore: undefined,
      }),
    ];
    expect(
      filterBySimilarity(items, 0.2, (item) => item.embeddingScore).map((item) => item.docId),
    ).toEqual(['a']);
  });

  it('trims the first candidate to the longest fitting prefix', () => {
    const items = [candidate({ docId: 'a', score: 1, text: 'abcdefghij' })];
    const result = applyTokenBudget(items, 4, (text) => [...text].length);
    expect(result[0]?.text).toBe('abcd');
    expect(result[0]?.citationRange).toEqual({ start: 0, end: 4 });
  });

  it('drops a candidate when no prefix fits', () => {
    expect(applyTokenBudget([candidate({ docId: 'a', score: 1 })], 0, () => 10)).toEqual([]);
  });
});
