import { describe, expect, it } from 'vitest';
import {
  mergeMultiSpaceCitations,
  type AuthorizedCandidate,
  type ChannelFailure,
} from '../../src/index';

function authorized(spaceId: string, segmentId: string, text: string): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId: 'source-a',
    knowledgeSpaceId: spaceId,
    score: 1,
    scores: [],
    text,
    segment: {
      id: segmentId,
      workspaceId: 'ws-a',
      knowledgeSpaceId: spaceId,
      sourceId: 'source-a',
      order: 0,
      searchEnabled: true,
      question: text,
      answer: '',
      content: text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: 'source-a',
      workspaceId: 'ws-a',
      knowledgeSpaceId: spaceId,
      name: 'Source',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

describe('TEST-SEARCH-007-BLOCK multi-space merge', () => {
  it('uses equal-weight RRF and preserves citation provenance', () => {
    const merged = mergeMultiSpaceCitations([
      {
        knowledgeSpaceId: 'space-a',
        candidates: [authorized('space-a', 'segment-a', 'alpha')],
      },
      {
        knowledgeSpaceId: 'space-b',
        candidates: [authorized('space-b', 'segment-b', 'beta')],
      },
    ]);
    expect(merged.candidates.map((item) => item.knowledgeSpaceId).sort()).toEqual([
      'space-a',
      'space-b',
    ]);
    expect(merged.candidates.every((item) => item.score === 1 / 61)).toBe(true);
    expect(merged.partial).toBe(false);
  });

  it('returns partial state when one authorized space fails', () => {
    const failure: ChannelFailure = {
      channel: 'embedding',
      kind: 'unavailable',
      degradedCode: 'vector_recall_failed',
      status: 503,
    };
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: 'space-a', candidates: [] },
      { knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234', failure },
    ]);
    expect(merged.partial).toBe(true);
    expect(merged.degraded).toContainEqual({
      stage: 'space',
      reason: 'space_65f1e5b2a1c9d4b7e8f01234_failed',
    });
  });
});
