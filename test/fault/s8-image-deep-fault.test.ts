import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src/index';
import { S8ImageSearchApplication } from '../../packages/service/src/modules/knowledge/application/s8-image-search.application';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-s8-fault',
  memberId: 'mem-s8-fault',
  requestId: 'req-s8-fault',
  traceId: 'trace-s8-fault',
  scopes: ['knowledge:search'],
};
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const imageId = '65f1e5b2a1c9d4b7e8f09999';

function error(
  code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' | 'KNOWLEDGE_RATE_LIMITED' | 'KNOWLEDGE_MODEL_FAILED',
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    retryable: true,
  });
}

function application() {
  const citations = vi.fn();
  const instance = new S8ImageSearchApplication({
    access: {
      assertSearchScope() {},
      async getAuthorizedSpace() {
        return {};
      },
    },
    objects: {
      findObjectRef: async () => ({
        blobId: imageId,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: spaceId,
        provider: 'minio',
        bucket: 'private',
        objectKey: 'hidden',
        providerUploadId: null,
        uploadMode: 'single',
        uploadStatus: 'completed',
        pendingObjectKey: null,
        finalObjectKey: 'hidden',
        finalizedAt: null,
        pendingUrlExpiresAt: null,
        originalName: 'query.png',
        purpose: 'image',
        sourceId: null,
        mimeType: 'image/png',
        sizeBytes: 128,
        etag: 'etag',
        sha256: 'sha256',
        state: 'active',
        expiresAt: null,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }),
    },
    models: {
      resolve: async () => {
        throw new Error('unused');
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
        throw new Error('unused');
      },
    },
    gateway: {
      invoke: async () => {
        throw error('KNOWLEDGE_DEPENDENCY_TIMEOUT');
      },
    },
    tickets: {
      issueImage: () => ({
        url: 'https://files.example.invalid/content?ticket=safe',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    },
    search: {
      collectCandidates: async () => {
        throw error('KNOWLEDGE_RATE_LIMITED');
      },
    },
    fullText: {
      search: async () => {
        throw error('KNOWLEDGE_RATE_LIMITED');
      },
    },
    authorization: {
      hydrate: async () => ({ items: [], rejected: 0 }),
      reauthorizeCitation: async () => undefined,
    },
    citations: { issueWithAudit: citations, findCurrent: async () => null },
    audits: { appendSearch: async () => undefined },
    vectors: { recall: async () => [] },
  });
  return { instance, citations };
}

describe('S8 dependency failures', () => {
  it('preserves the highest-priority timeout when every image/text channel fails', async () => {
    const { instance, citations } = application();
    await expect(
      instance.search(
        {
          knowledgeSpaceId: spaceId,
          query: 'refund',
          tokenBudget: 5_000,
          imageUploadIds: [imageId],
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
    expect(citations).not.toHaveBeenCalled();
  });
});
