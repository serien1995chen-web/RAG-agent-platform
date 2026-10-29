import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '@kb/contracts';
import { createSearchEngine } from '../../src/engine';
import type { AuthorizedCandidate, SearchEngineDeps } from '../../src/types';

const request: SearchRequest = {
  requestId: 'req-s9-extension',
  workspaceId: 'ws-s9-extension',
  memberId: 'mem-s9-extension',
  knowledgeSpaceIds: ['space-a', 'space-b'],
  textQueries: ['refund'],
  imageQueries: [],
  models: { embeddingModel: 'embedding-768' },
  searchMode: 'mixedRecall',
  limit: 10,
  maxTokens: 5000,
  similarity: 0,
};

function candidate(): AuthorizedCandidate {
  return {
    docId: 'space-a:segment-a',
    segmentId: 'segment-a',
    sourceId: 'source-a',
    knowledgeSpaceId: 'space-a',
    score: 1,
    scores: [{ type: 'embedding', value: 1, index: 0 }],
    text: 'refund policy',
    segment: {
      id: 'segment-a',
      workspaceId: 'ws-s9-extension',
      knowledgeSpaceId: 'space-a',
      sourceId: 'source-a',
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: 'refund policy',
      answer: 'refund policy',
      content: 'refund policy',
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: 'source-a',
      workspaceId: 'ws-s9-extension',
      knowledgeSpaceId: 'space-a',
      name: 'Refund policy',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 0,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

describe('S9 query extension engine hook', () => {
  it('TEST-SEARCH-003-BLOCK sends identical expanded text to both recall channels', async () => {
    const embeddingTexts: string[] = [];
    const fullText: string[] = [];
    const deps: SearchEngineDeps = {
      queryExpansion: {
        async expand(query) {
          return {
            originalQuery: query,
            expandedQuery: `${query} Refund`,
            hits: [
              {
                knowledgeSpaceId: 'space-a',
                fileVersion: 3,
                logicalMappingId: '000000000000000000000001',
                standardizedTerm: 'Refund',
                normalizedStandardizedTerm: 'refund',
                matchedTerm: 'refund',
                start: 0,
                end: 6,
              },
            ],
            normalizedStandardTerms: ['refund'],
            appliedMappingIds: ['000000000000000000000001'],
            fallbackReason: null,
          };
        },
      },
      vectors: {
        async embRecall() {
          return [
            {
              segmentId: 'segment-a',
              sourceId: 'source-a',
              indexId: 'default',
              version: 1,
              score: 1,
            },
          ];
        },
      },
      embedding: {
        async embed(input) {
          embeddingTexts.push(...input.texts);
          return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
        },
      },
      fullText: {
        async search(input) {
          fullText.push(input.text);
          return [
            {
              segmentId: 'segment-a',
              sourceId: 'source-a',
              fullTextVersion: 1,
              score: 1,
            },
          ];
        },
      },
      hydrator: {
        async hydrate() {
          return { items: [candidate()], rejected: 0 };
        },
      },
    };
    const result = await createSearchEngine(deps).search(request, {
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      memberId: request.memberId,
    });
    expect(embeddingTexts).toEqual(['refund Refund']);
    expect(fullText).toEqual(['refund Refund']);
    expect(result.queryExpansions).toHaveLength(1);
    expect(result.queryExpansions[0]?.appliedMappingIds).toEqual(['000000000000000000000001']);
  });

  it('TEST-SEARCH-003-BLOCK falls back to the original query when expansion fails', async () => {
    const embeddingTexts: string[] = [];
    const fullText: string[] = [];
    const base = candidate();
    const result = await createSearchEngine({
      queryExpansion: {
        async expand() {
          throw new Error('version cache stale');
        },
      },
      vectors: {
        async embRecall() {
          return [];
        },
      },
      embedding: {
        async embed(input) {
          embeddingTexts.push(...input.texts);
          return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
        },
      },
      fullText: {
        async search(input) {
          fullText.push(input.text);
          return [];
        },
      },
      hydrator: {
        async hydrate() {
          return { items: [base], rejected: 0 };
        },
      },
    }).search(
      { ...request, searchMode: 'fullTextRecall' },
      {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
      },
    );
    expect(result.queryExpansions).toEqual([]);
    expect(fullText).toEqual(['refund']);
  });
});
