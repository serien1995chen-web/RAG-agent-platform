import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedCandidate, Candidate } from '@kb/search';
import { createKnowledgeError } from '@kb/contracts';
import { S8ImageSearchApplication } from '../../src/modules/knowledge/application/s8-image-search.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-s8-image-search',
  memberId: 'mem-s8-image-search',
  requestId: 'req-s8-image-search',
  traceId: 'trace-s8-image-search',
  scopes: ['knowledge:search'],
};
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f05678';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';
const imageId = '65f1e5b2a1c9d4b7e8f09999';

function authorized(): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId,
    knowledgeSpaceId: spaceId,
    score: 1,
    embeddingScore: 1,
    imageIdentity: `${segmentId}:${imageId}`,
    scores: [{ type: 'embedding', value: 1, index: 0 }],
    text: 'Refund flow diagram',
    segment: {
      id: segmentId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: 'Refund flow diagram',
      answer: '',
      content: 'Refund flow diagram',
      metadata: { captionStatus: 'indexed', vectorStatus: 'indexed' },
      indexes: [
        {
          indexId: 'image',
          type: 'image',
          modelId: 'mock-embedding-768',
          dimension: 768,
          vectorProfile: 'knowledge_segment_vectors_768',
          vectorId: '00000000-0000-4000-8000-000000000001',
          text: 'Refund flow diagram',
          version: 1,
        },
      ],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: imageId,
      imageDescription: 'Refund flow diagram',
      version: 2,
    },
    source: {
      id: sourceId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      name: 'Refund flow',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 0,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function imageObject() {
  const now = new Date().toISOString();
  return {
    blobId: imageId,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: spaceId,
    provider: 'minio' as const,
    bucket: 'private',
    objectKey: 'ws/hidden/object-key',
    providerUploadId: null,
    uploadMode: 'single' as const,
    uploadStatus: 'completed' as const,
    pendingObjectKey: null,
    finalObjectKey: 'ws/hidden/object-key',
    finalizedAt: now,
    pendingUrlExpiresAt: null,
    originalName: 'refund.png',
    purpose: 'image' as const,
    sourceId,
    mimeType: 'image/png',
    sizeBytes: 128,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active' as const,
    expiresAt: null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function application(
  options: {
    reauthorized?: boolean;
    objectSpaceId?: string;
    objectPurpose?: 'source' | 'image';
    filterMatch?: boolean;
    failImageVector?: boolean;
  } = {},
) {
  const issue = vi.fn(async (input: { candidates: readonly AuthorizedCandidate[] }) => {
    return new Map(
      input.candidates.map((candidate) => [
        `${candidate.knowledgeSpaceId}:${candidate.segmentId}`,
        {
          citationId: 'cit_00000000-0000-4000-8000-000000000001',
          segmentId: candidate.segmentId,
          sourceId: candidate.sourceId,
          title: candidate.source.name,
          sourceUrl: null,
          segmentRange: { start: 0, end: candidate.text.length },
          score: candidate.score,
          version: candidate.segment.version,
        },
      ]),
    );
  });
  return {
    issue,
    instance: new S8ImageSearchApplication({
      access: {
        assertSearchScope() {},
        async getAuthorizedSpace() {
          return {};
        },
      },
      objects: {
        findObjectRef: async () => ({
          ...imageObject(),
          knowledgeSpaceId: options.objectSpaceId ?? spaceId,
          purpose: options.objectPurpose ?? 'image',
        }),
      },
      models: {
        resolveVlm: async () => {
          throw new Error('not used');
        },
        resolveVisionEmbedding: async () => ({
          modelId: 'mock-embedding-768',
          displayName: 'Vision embedding',
          type: 'embedding',
          capabilities: ['vision', 'dimension:768'],
          dimension: 768,
          authorized: true,
        }),
        resolveLlm: async () => {
          throw new Error('not used');
        },
      },
      gateway: {
        invoke: async () => ({
          data: {
            data: [
              {
                index: 0,
                embedding: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
              },
            ],
          },
          actualModelId: 'mock-embedding-768',
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 1, outputTokens: 0, quantity: 1 },
        }),
      },
      tickets: {
        issueImage: () => ({
          url: 'https://files.example.invalid/content?ticket=safe',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      },
      search: {
        collectCandidates: async () => ({
          candidates: [],
          partial: false,
          degradedCodes: [],
          rerankApplied: false,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      },
      fullText: {
        search: async () => [
          {
            segmentId,
            sourceId,
            fullTextVersion: 1,
            score: 1,
          },
        ],
      },
      filters: {
        listFilterFacts: async () => ({
          facts: [
            {
              sourceId,
              knowledgeSpaceId: spaceId,
              directoryId: null,
              directoryPath: [],
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              tagValues: [
                {
                  tagId: '65f1e5b2a1c9d4b7e8f03000',
                  valueKey: options.filterMatch === false ? 'silver' : 'gold',
                  value: options.filterMatch === false ? 'silver' : 'gold',
                },
              ],
            },
          ],
          definitions: [
            {
              tagId: '65f1e5b2a1c9d4b7e8f03000',
              knowledgeSpaceId: spaceId,
              tagType: 'string' as const,
              status: 'active' as const,
            },
          ],
        }),
      },
      authorization: {
        async hydrate(candidates: readonly Candidate[]) {
          return { items: candidates.map(() => authorized()), rejected: 0 };
        },
        async reauthorizeCitation() {
          return options.reauthorized === false ? undefined : authorized();
        },
      },
      citations: { issueWithAudit: issue, findCurrent: async () => null },
      audits: { appendSearch: async () => undefined },
      vectors: {
        recall: async () => {
          if (options.failImageVector) {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
              requestId: context.requestId,
              traceId: context.traceId,
            });
          }
          return [
            {
              vectorId: '00000000-0000-4000-8000-000000000001',
              workspaceId: context.workspaceId,
              knowledgeSpaceId: spaceId,
              sourceId,
              segmentId,
              indexId: 'image',
              version: 1,
              score: 1,
            },
          ];
        },
      },
      searchIdFactory: () => 'search_s8_fixture',
    }),
  };
}

describe('TEST-SEARCH-006-BLOCK / TEST-MULTI-001-BLOCK image search', () => {
  it('fuses caption and image vector recall, reauthorizes and persists one citation set', async () => {
    const { instance, issue } = application();
    const result = await instance.search(
      {
        knowledgeSpaceId: spaceId,
        query: 'refund diagram',
        tokenBudget: 5_000,
        imageUploadIds: [imageId],
      },
      context,
    );
    expect(result.mode).toBe('image');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.segment.imageBlobRefId).toBe(imageId);
    expect(result.partial).toBe(false);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('object-key');
    expect(JSON.stringify(result)).not.toContain('bucket');
  });

  it('returns 207 with degraded image channels without raw provider errors', async () => {
    const { instance } = application({ failImageVector: true });
    const result = await instance.search(
      {
        knowledgeSpaceId: spaceId,
        query: 'refund diagram',
        tokenBudget: 5_000,
        imageUploadIds: [imageId],
      },
      { ...context, scopes: ['knowledge:search'] },
    );
    expect(result.degraded).toContain('image_vector_recall_failed');
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('provider');
  });

  it('applies non-source filters to both image recall channels', async () => {
    const { instance, issue } = application({ filterMatch: false });
    await expect(
      instance.search(
        {
          knowledgeSpaceId: spaceId,
          query: 'refund diagram',
          tokenBudget: 5_000,
          imageUploadIds: [imageId],
          filters: {
            logic: 'AND',
            conditions: [
              {
                tagId: '65f1e5b2a1c9d4b7e8f03000',
                tagType: 'string',
                operator: '$eq',
                value: 'gold',
              },
            ],
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it('drops candidates rejected by final ACL and never returns a preview citation', async () => {
    const { instance, issue } = application({ reauthorized: false });
    const result = await instance.search(
      {
        knowledgeSpaceId: spaceId,
        query: 'refund diagram',
        tokenBudget: 5_000,
        imageUploadIds: [imageId],
      },
      context,
    );
    expect(result.items).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.degraded).toContain('image_candidate_acl_rejected');
    expect(issue.mock.calls[0]?.[0].candidates).toEqual([]);
  });

  it('returns 404 for a cross-space query ObjectRef', async () => {
    const { instance } = application({
      objectSpaceId: '65f1e5b2a1c9d4b7e8f01235',
    });
    await expect(
      instance.search(
        {
          knowledgeSpaceId: spaceId,
          query: 'refund diagram',
          tokenBudget: 5_000,
          imageUploadIds: [imageId],
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('returns 404 for a query ObjectRef that is not purpose=image', async () => {
    const { instance } = application({ objectPurpose: 'source' });
    await expect(
      instance.search(
        {
          knowledgeSpaceId: spaceId,
          query: 'refund diagram',
          tokenBudget: 5_000,
          imageUploadIds: [imageId],
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });
});
