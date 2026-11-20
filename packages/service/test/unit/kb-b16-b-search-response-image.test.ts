import { describe, expect, it, vi } from 'vitest';
import type { CitationApi, SearchRequest } from '@kb/contracts';
import { finalizeSearchCandidates, type AuthorizedCandidate } from '@kb/search';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import {
  issueSearchImagePreviews,
  searchCandidateKey,
} from '../../src/modules/knowledge/application/s7-search-public-response';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const workspaceId = 'ws-kb-b16-b-image-response';
const spaceId = '65f1e5b2a1c9d4b7e8f09800';
const sourceId = '65f1e5b2a1c9d4b7e8f09801';
const segmentId = '65f1e5b2a1c9d4b7e8f09802';
const imageBlobRefId = '65f1e5b2a1c9d4b7e8f09803';
const context: TenantContext = {
  workspaceId,
  memberId: 'mem-kb-b16-b-image-response',
  requestId: 'req-kb-b16-b-image-response',
  traceId: 'trace-kb-b16-b-image-response'.padEnd(32, '0'),
  scopes: ['knowledge:search', 'knowledge:read'],
};

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
      metadata: {
        section: 'refunds',
        objectKey: 'ws/team-sensitive/refund-chart.png',
        nested: { finalObjectKey: 'kb-test/team-sensitive/chart.png', public: 'keep' },
      },
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
    sourceUrl: 'https://files.internal.example/dataset/team-sensitive/refund-chart.png',
    segmentRange: { start: 0, end: 17 },
    score: 0.9,
    version: 1,
  };
}

describe('L1-B16-B-SEARCH-005-A02 public search response image safety', () => {
  it('does not expose a raw object key in final Search Test content', () => {
    const app = new S7SearchApplication({} as never);
    const imagePreview = {
      url: 'https://knowledge.example.invalid/v1/knowledge/files/blob/content?ticket=redacted',
      expiresAt: '2026-11-20T16:00:00.000Z',
    };
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
          imagePreviews: Map<string, typeof imagePreview>;
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
      imagePreviews: new Map([[`${spaceId}:${segmentId}`, imagePreview]]),
    });

    expect(JSON.stringify(response)).not.toContain('dataset/team-sensitive');
    expect(JSON.stringify(response)).not.toContain('team-sensitive/refund-chart');
    expect(JSON.stringify(response)).not.toContain('finalObjectKey');
    expect(JSON.stringify(response)).not.toContain('kb-test');
    expect(JSON.stringify(response)).not.toContain('minio');
    expect(response).toMatchObject({
      items: [
        {
          imagePreview,
          citation: { sourceUrl: null },
          segment: {
            metadata: { section: 'refunds', nested: { public: 'keep' } },
          },
        },
      ],
    });
  });

  it('issues a 300 second preview once per final image candidate and degrades safely', async () => {
    const issueImage = vi.fn(async () => ({
      url: 'https://knowledge.example.invalid/v1/knowledge/files/blob/content?ticket=redacted',
      expiresAt: '2026-11-20T16:00:00.000Z',
      ticket: 'must-not-leak',
    }));
    const first = candidate();
    const issued = await issueSearchImagePreviews({
      candidates: [
        first,
        { ...first, segmentId: 'text-only', segment: { ...first.segment, imageBlobRefId: null } },
      ],
      previews: { issueImage },
      context,
    });
    expect(issueImage).toHaveBeenCalledTimes(1);
    expect(issueImage).toHaveBeenCalledWith(
      expect.objectContaining({
        blobId: imageBlobRefId,
        sourceId,
        knowledgeSpaceId: spaceId,
        ttlSeconds: 300,
      }),
    );
    expect(issued.items.has(searchCandidateKey(first))).toBe(true);
    expect(issued.items.get(searchCandidateKey(first))).toEqual({
      url: 'https://knowledge.example.invalid/v1/knowledge/files/blob/content?ticket=redacted',
      expiresAt: '2026-11-20T16:00:00.000Z',
    });
    expect(issued.degradedCodes).toEqual([]);

    const second = {
      ...candidate(),
      segmentId: '65f1e5b2a1c9d4b7e8f09804',
      segment: {
        ...candidate().segment,
        id: '65f1e5b2a1c9d4b7e8f09804',
        question: 'Shipping chart',
        answer: 'Shipping takes three days.',
        content: '![Shipping chart](dataset/team-sensitive/shipping-chart.png)',
      },
    };
    const request: SearchRequest = {
      requestId: context.requestId,
      workspaceId,
      memberId: context.memberId,
      knowledgeSpaceIds: [spaceId],
      textQueries: ['refund'],
      imageQueries: [],
      models: { embeddingModel: 'embedding-1024' },
      searchMode: 'embedding',
      limit: 1,
      maxTokens: 5_000,
      similarity: 0,
    };
    const finalized = finalizeSearchCandidates(request, [first, second], false);
    const finalIssued = await issueSearchImagePreviews({
      candidates: finalized.items,
      previews: { issueImage },
      context,
    });
    expect(finalized.items).toHaveLength(1);
    expect(finalIssued.items.size).toBe(1);
    expect(issueImage).toHaveBeenCalledTimes(2);

    const failed = await issueSearchImagePreviews({
      candidates: [first],
      previews: {
        issueImage: async () => {
          throw new Error('ticket dependency unavailable');
        },
      },
      context,
    });
    expect(failed.items.size).toBe(0);
    expect(failed.degradedCodes).toEqual(['image_preview_unavailable']);
  });
});
