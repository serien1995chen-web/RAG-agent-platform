import type { SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  createSearchEngine,
  type AuthorizedCandidate,
  type SearchEngineDeps,
} from '../../src/index';

const context = {
  requestId: 'req-s7-hydration',
  workspaceId: 'ws-s7',
  memberId: 'mem-s7',
  traceId: 'trace-s7',
  scopes: ['knowledge:search'],
};

function request(): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: context.memberId,
    knowledgeSpaceIds: ['65f1e5b2a1c9d4b7e8f01234'],
    textQueries: ['refund'],
    imageQueries: [],
    models: { embeddingModel: 'embedding-1536' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

function authorized(input: {
  segmentId: string;
  sourceId: string;
  text: string;
  score: number;
}): AuthorizedCandidate {
  return {
    docId: `65f1e5b2a1c9d4b7e8f01234:${input.segmentId}`,
    segmentId: input.segmentId,
    sourceId: input.sourceId,
    knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
    score: input.score,
    embeddingScore: input.score,
    scores: [{ type: 'embedding', value: input.score, index: 0 }],
    text: input.text,
    segment: {
      id: input.segmentId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      sourceId: input.sourceId,
      order: 0,
      searchEnabled: true,
      question: input.text,
      answer: '',
      content: input.text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: input.sourceId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      name: 'Allowed source',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

describe('TEST-SEARCH-001-BLOCK S7 hydration before fusion', () => {
  it('drops deleted, unauthorized and stale candidates before RRF', async () => {
    const deps: SearchEngineDeps = {
      vectors: {
        embRecall: async () => [
          {
            segmentId: '65f1e5b2a1c9d4b7e8f00001',
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            indexId: 'idx-1',
            version: 1,
            score: 0.9,
          },
          {
            segmentId: '65f1e5b2a1c9d4b7e8f00002',
            sourceId: '65f1e5b2a1c9d4b7e8f10002',
            indexId: 'idx-2',
            version: 1,
            score: 0.8,
          },
          {
            segmentId: '65f1e5b2a1c9d4b7e8f00003',
            sourceId: '65f1e5b2a1c9d4b7e8f10003',
            indexId: 'idx-3',
            version: 1,
            score: 0.7,
          },
        ],
      },
      embedding: { embed: async ({ texts }) => texts.map(() => [1, 0]) },
      hydrator: {
        hydrate: async (candidates) => ({
          items: candidates.flatMap((candidate) => {
            if (candidate.segmentId?.endsWith('00001')) {
              return [
                authorized({
                  segmentId: candidate.segmentId,
                  sourceId: candidate.sourceId!,
                  text: 'allowed refund policy',
                  score: candidate.score,
                }),
              ];
            }
            return [];
          }),
          rejected: candidates.length - 1,
        }),
      },
    };
    const result = await createSearchEngine(deps).search(request(), context);
    expect(result.citations.map((citation) => citation.segmentId)).toEqual([
      '65f1e5b2a1c9d4b7e8f00001',
    ]);
    expect(result.authorizedCandidates).toHaveLength(1);
  });

  it('returns a successful empty result when final authorization rejects every hit', async () => {
    const result = await createSearchEngine({
      vectors: {
        embRecall: async () => [
          {
            segmentId: '65f1e5b2a1c9d4b7e8f00001',
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            indexId: 'idx-1',
            score: 0.9,
          },
        ],
      },
      embedding: { embed: async () => [[1]] },
      hydrator: { hydrate: async () => ({ items: [], rejected: 1 }) },
    }).search(request(), context);
    expect(result.status).toBe(200);
    expect(result.citations).toEqual([]);
  });
});
