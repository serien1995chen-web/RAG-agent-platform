import { describe, expect, it } from 'vitest';
import type { CitationApi } from '@kb/contracts';
import type { AuthorizedCandidate } from '@kb/search';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';

const workspaceId = 'ws-kb-b16-b-image-response';
const spaceId = '65f1e5b2a1c9d4b7e8f09800';
const sourceId = '65f1e5b2a1c9d4b7e8f09801';
const segmentId = '65f1e5b2a1c9d4b7e8f09802';
const imageBlobRefId = '65f1e5b2a1c9d4b7e8f09803';

function candidate(): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId,
    knowledgeSpaceId: spaceId,
    score: 0.9,
    scores: [{ type: 'embedding', value: 0.9, index: 0 }],
    text: 'Refund chart',
    segment: {
      id: segmentId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: '',
      answer: '',
      content: '![Refund chart](dataset/team-sensitive/refund-chart.png)',
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId,
      version: 1,
    },
    source: {
      id: sourceId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      name: 'Refund policy',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function citation(): CitationApi {
  return {
    citationId: 'cit_00000000-0000-4000-8000-000000000018',
    segmentId,
    sourceId,
    title: 'Refund policy',
    sourceUrl: null,
    segmentRange: { start: 0, end: 17 },
    score: 0.9,
    version: 1,
  };
}

describe('L1-B16-B-SEARCH-005-A02 public search response image safety', () => {
  it('does not expose a raw object key in final Search Test content', () => {
    const app = new S7SearchApplication({} as never);
    const response = (
      app as unknown as {
        response(input: {
          searchId: string;
          mode: 'hybrid';
          candidates: AuthorizedCandidate[];
          citations: Map<string, CitationApi>;
          partial: boolean;
          durationMs: number;
          degradedCodes: string[];
          rerankApplied: boolean;
        }): unknown;
      }
    ).response({
      searchId: 'search_kb_b16_b_image',
      mode: 'hybrid',
      candidates: [candidate()],
      citations: new Map([[`${spaceId}:${segmentId}`, citation()]]),
      partial: false,
      durationMs: 12,
      degradedCodes: [],
      rerankApplied: false,
    });

    expect(JSON.stringify(response)).not.toContain('dataset/team-sensitive');
    expect(JSON.stringify(response)).not.toContain('kb-test');
    expect(JSON.stringify(response)).not.toContain('minio');
  });
});
