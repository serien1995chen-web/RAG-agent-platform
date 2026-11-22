import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '@kb/contracts';
import {
  finalizeSearchCandidates,
  mergeMultiSpaceCitations,
  type AuthorizedCandidate,
} from '../../src/index';

const workspaceId = 'ws_b18_a';
const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';

function candidate(input: {
  spaceId: string;
  segmentId: string;
  sourceId?: string;
  question?: string;
  answer?: string;
  score?: number;
}): AuthorizedCandidate {
  const question = input.question ?? `Question ${input.segmentId}`;
  const answer = input.answer ?? `Answer ${input.segmentId}`;
  const content = `${question}\n${answer}`;
  const sourceId = input.sourceId ?? `source-${input.segmentId}`;
  return {
    docId: `${input.spaceId}:${input.segmentId}`,
    segmentId: input.segmentId,
    sourceId,
    knowledgeSpaceId: input.spaceId,
    score: input.score ?? 1,
    embeddingScore: input.score ?? 1,
    scores: [{ type: 'embedding', value: input.score ?? 1, index: 0 }],
    text: content,
    citationRange: { start: 0, end: [...content].length },
    segment: {
      id: input.segmentId,
      workspaceId,
      knowledgeSpaceId: input.spaceId,
      sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question,
      answer,
      content,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 3,
    },
    source: {
      id: sourceId,
      workspaceId,
      knowledgeSpaceId: input.spaceId,
      name: `Source ${sourceId}`,
      originalUrl: `https://example.invalid/${sourceId}`,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function request(): SearchRequest {
  return {
    requestId: 'req-b18-a',
    workspaceId,
    memberId: 'member-b18-a',
    knowledgeSpaceIds: [spaceA, spaceB],
    textQueries: ['policy'],
    imageQueries: [],
    models: { embeddingModel: 'b18-a-embedding' },
    searchMode: 'embedding',
    limit: 20,
    maxTokens: 20_000,
    similarity: 0,
  };
}

describe('B18-A SEARCH-007 multi-space RRF', () => {
  it('L1-B18-SEARCH-007-P01 computes weighted RRF contributions and preserves original Space provenance', () => {
    const supportFirst = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20001',
      score: 0.9,
    });
    const supportSecond = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20002',
      score: 0.8,
    });
    const operationsFirst = candidate({
      spaceId: spaceB,
      segmentId: '65f1e5b2a1c9d4b7e8f20003',
      score: 0.7,
    });

    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [supportFirst, supportSecond] },
      { knowledgeSpaceId: spaceB, candidates: [operationsFirst] },
    ]);

    expect(merged.partial).toBe(false);
    expect(merged.failedSpaces).toEqual([]);
    expect(merged.candidates).toHaveLength(3);
    expect(
      Object.fromEntries(merged.candidates.map((item) => [item.segmentId, item.score] as const)),
    ).toEqual({
      [supportFirst.segmentId]: 1 / 61,
      [supportSecond.segmentId]: 1 / 62,
      [operationsFirst.segmentId]: 1 / 61,
    });
    expect(merged.candidates.map((item) => item.knowledgeSpaceId).sort()).toEqual([
      spaceA,
      spaceA,
      spaceB,
    ]);
    expect(supportFirst.score).toBe(0.9);
  });

  it('L1-B18-SEARCH-007-P02 removes duplicate business results and keeps deterministic provenance', () => {
    const first = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20011',
      sourceId: '65f1e5b2a1c9d4b7e8f10001',
      question: 'Shared policy',
      answer: 'Same answer.',
    });
    const duplicate = candidate({
      spaceId: spaceB,
      segmentId: '65f1e5b2a1c9d4b7e8f20012',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
      question: 'Shared policy',
      answer: 'Same answer.',
    });
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [first] },
      { knowledgeSpaceId: spaceB, candidates: [duplicate] },
    ]);

    const finalized = finalizeSearchCandidates(request(), merged.candidates, false).items;
    expect(finalized).toHaveLength(1);
    expect([first.knowledgeSpaceId, duplicate.knowledgeSpaceId]).toContain(
      finalized[0]!.knowledgeSpaceId,
    );
    expect(finalized[0]!.segmentId).toBe(first.segmentId);
  });

  it('L1-B18-SEARCH-007-P02 counts the same Segment only once within a Space', () => {
    const same = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20021',
    });
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [same, { ...same }] },
    ]);

    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]!.score).toBe(1 / 61);
  });

  it('L1-B18-SEARCH-007-P02 preserves FastGPT insertion order for an equal RRF score', () => {
    const firstInserted = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f2ffff',
    });
    const secondInserted = candidate({
      spaceId: spaceB,
      segmentId: '65f1e5b2a1c9d4b7e8f20000',
    });

    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [firstInserted] },
      { knowledgeSpaceId: spaceB, candidates: [secondInserted] },
    ]);

    expect(merged.candidates.map((item) => item.segmentId)).toEqual([
      firstInserted.segmentId,
      secondInserted.segmentId,
    ]);
  });

  it('L1-B18-SEARCH-007-N02 keeps healthy Space results during partial failure', () => {
    const healthy = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20031',
    });
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [healthy] },
      {
        knowledgeSpaceId: spaceB,
        failure: {
          channel: 'fullText',
          kind: 'timeout',
          degradedCode: 'fulltext_recall_failed',
          status: 504,
        },
      },
    ]);

    expect(merged.partial).toBe(true);
    expect(merged.failedSpaces).toEqual([spaceB]);
    expect(merged.candidates.map((item) => item.knowledgeSpaceId)).toEqual([spaceA]);
    expect(merged.degraded).toEqual([
      { stage: 'space', reason: `space_${spaceB}_failed` },
      { stage: 'fullText', reason: 'fulltext_recall_failed' },
    ]);
  });

  it('L1-B18-SEARCH-007-C01 does not mutate caller candidates or share state across merges', () => {
    const input = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20041',
      score: 0.42,
    });
    const originalScores = JSON.stringify(input.scores);
    const first = mergeMultiSpaceCitations([{ knowledgeSpaceId: spaceA, candidates: [input] }]);
    const second = mergeMultiSpaceCitations([{ knowledgeSpaceId: spaceA, candidates: [input] }]);

    expect(first.candidates).toEqual(second.candidates);
    expect(input.score).toBe(0.42);
    expect(JSON.stringify(input.scores)).toBe(originalScores);
  });

  it('L1-B18-SEARCH-007-Q01 records stable failure and contribution evidence', () => {
    const first = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20051',
    });
    const second = candidate({
      spaceId: spaceA,
      segmentId: '65f1e5b2a1c9d4b7e8f20052',
    });
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [first, second] },
      {
        knowledgeSpaceId: spaceB,
        failure: {
          channel: 'embedding',
          kind: 'unavailable',
          degradedCode: 'vector_recall_failed',
          status: 503,
        },
      },
    ]);

    expect(merged.candidates[0]).toMatchObject({
      knowledgeSpaceId: spaceA,
      segmentId: first.segmentId,
      score: 1 / 61,
    });
    expect(merged.candidates[1]).toMatchObject({
      knowledgeSpaceId: spaceA,
      segmentId: second.segmentId,
      score: 1 / 62,
    });
    expect(merged.degraded).toContainEqual({
      stage: 'space',
      reason: `space_${spaceB}_failed`,
    });
    expect(merged.degraded).toContainEqual({
      stage: 'vector',
      reason: 'vector_recall_failed',
    });
  });
});
