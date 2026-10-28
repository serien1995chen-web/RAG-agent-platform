import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '@kb/contracts';
import { S8CaptionApplication } from '../../src/modules/knowledge/application/s8-caption.application';
import type {
  S6JobRecord,
  S6SourceRecord,
} from '../../src/modules/knowledge/application/s06-processing-ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { S5ModelTransportError } from '../../src/modules/knowledge/application/s5-model-gateway.port';

const context: TenantContext = {
  workspaceId: 'ws-s8-caption',
  memberId: 'mem-s8-caption',
  requestId: 'req-s8-caption',
  traceId: 'trace-s8-caption',
  scopes: ['knowledge:write'],
};

const source: S6SourceRecord = {
  id: '65f1e5b2a1c9d4b7e8f05678',
  workspaceId: context.workspaceId,
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  kind: 'image',
  sourceVersion: 2,
  blobRefId: '65f1e5b2a1c9d4b7e8f09999',
  name: 'refund-flow.png',
  mimeType: 'image/png',
  parseProvider: 'liteparse',
  searchEnabled: true,
  processingStatus: 'indexing',
  version: 2,
};

const job = {
  _id: '65f1e5b2a1c9d4b7e8f01111',
  resourceId: source.id,
  inputSnapshot: {
    sourceId: source.id,
    sourceVersion: source.sourceVersion,
    imageBlobRefId: source.blobRefId,
  },
} as unknown as S6JobRecord;

function application(input?: {
  failEmbedding?: boolean;
  failVlmResolution?: boolean;
  failEmbeddingResolution?: boolean;
}) {
  const commit = vi.fn(async (value: { indexes: unknown[] }) => ({
    id: '65f1e5b2a1c9d4b7e8f02222',
    workspaceId: context.workspaceId,
    knowledgeSpaceId: source.knowledgeSpaceId,
    sourceId: source.id,
    sourceVersion: source.sourceVersion,
    searchEnabled: true,
    order: 0,
    question: 'A refund flow diagram',
    answer: '',
    content: 'A refund flow diagram',
    fullTextTokens: 'refund flow',
    fullTextVersion: 1,
    metadata: {},
    history: [],
    indexes: value.indexes,
    indexStatus: 'indexed' as const,
    indexErrorCode: null,
    imageBlobRefId: source.blobRefId,
    imageDescription: 'A refund flow diagram',
    version: 4,
  }));
  const updateStatus = vi.fn(async () => undefined);
  const instance = new S8CaptionApplication({
    store: {
      getSource: async () => source,
      updateSourceStatus: updateStatus,
    },
    objects: {
      findObjectRef: async () => ({
        blobId: source.blobRefId!,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: source.knowledgeSpaceId,
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
        originalName: source.name,
        purpose: 'image',
        sourceId: source.id,
        mimeType: source.mimeType,
        sizeBytes: 128,
        etag: 'etag',
        sha256: 'sha256',
        state: 'active',
        expiresAt: null,
        version: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      }),
    },
    models: {
      resolveVlm: async () => {
        if (input?.failVlmResolution) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
          });
        }
        return {
          modelId: 'mock-vlm',
          displayName: 'VLM',
          type: 'vlm',
          capabilities: ['vision'],
          dimension: null,
          authorized: true,
        };
      },
      resolveVisionEmbedding: async () => {
        if (input?.failEmbeddingResolution) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            requestId: context.requestId,
            traceId: context.traceId,
          });
        }
        return {
          modelId: 'mock-embedding-1536',
          displayName: 'Vision embedding',
          type: 'embedding',
          capabilities: ['vision', 'dimension:1536'],
          dimension: 1536,
          authorized: true,
        };
      },
      resolveLlm: async () => {
        throw new Error('not used');
      },
    },
    gateway: {
      invoke: async (invocation) => {
        if (invocation.kind === 'vlm') {
          return {
            data: {
              choices: [
                {
                  message: { content: JSON.stringify({ caption: 'A refund flow diagram' }) },
                },
              ],
            },
            actualModelId: invocation.modelId,
            attempts: 1,
            fallbackUsed: false,
            degraded: false,
            usage: { inputTokens: 3, outputTokens: 2, quantity: 5 },
          };
        }
        if (input?.failEmbedding) {
          throw new S5ModelTransportError('provider', 502);
        }
        const count = invocation.input?.length ?? 0;
        return {
          data: {
            data: Array.from({ length: count }, (_, itemIndex) => ({
              index: itemIndex,
              embedding: Array.from({ length: 1536 }, (_, index) => (index === itemIndex ? 1 : 0)),
            })),
          },
          actualModelId: invocation.modelId,
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 2, outputTokens: 0, quantity: 2 },
        };
      },
    },
    tickets: {
      issueImage: () => ({
        url: 'https://files.example.invalid/content?ticket=safe',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    },
    vectors: {
      insert: async (records) => ({
        inserted: records.length,
        vectorIds: records.map((_, index) => `00000000-0000-4000-8000-00000000000${index}`),
      }),
      deleteBySegment: async () => ({ deleted: 0 }),
      listProfiles: () => [
        {
          tableName: 'knowledge_segment_vectors_1536',
          storageType: 'vector' as const,
          dimension: 1536,
        },
      ],
      cleanupUnreferenced: async () => ({ deleted: 0, byProfile: {} }),
    },
    fulltext: {
      project: async () => ({
        fullTextVersion: 1,
        segmentVersion: 3,
        tokenizerVersion: 'v1',
        tokensHash: 'hash',
      }),
    },
    indexes: {
      ensureImageSegment: async () => ({
        id: '65f1e5b2a1c9d4b7e8f02222',
        workspaceId: context.workspaceId,
        knowledgeSpaceId: source.knowledgeSpaceId,
        sourceId: source.id,
        sourceVersion: source.sourceVersion,
        searchEnabled: true,
        order: 0,
        question: '',
        answer: '',
        content: '',
        fullTextTokens: '',
        fullTextVersion: 0,
        metadata: { captionStatus: 'pending', vectorStatus: 'pending' },
        history: [],
        indexes: [],
        indexStatus: 'pending',
        indexErrorCode: null,
        imageBlobRefId: source.blobRefId,
        imageDescription: null,
        version: 2,
      }),
      commit,
      markFinalFailure: vi.fn(async () => undefined),
    },
  });
  return { instance, commit, updateStatus };
}

describe('TEST-X-IMAGE-CAPTION executor', () => {
  it('writes ordered caption and image vectors with one source version and one CAS', async () => {
    const { instance, commit, updateStatus } = application();
    const result = await instance.execute(job, context);
    expect(result.result).toMatchObject({
      captionStatus: 'indexed',
      vectorStatus: 'indexed',
      sourceVersion: 2,
      captionPromptVersion: 's8.image-caption.v1',
      visionEmbeddingModelId: 'mock-embedding-1536',
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(
      commit.mock.calls[0]?.[0].indexes.map((index: { indexId: string }) => index.indexId),
    ).toEqual(['image_caption', 'image']);
    expect(updateStatus).toHaveBeenCalledWith(source.id, 'ready', context, 2);
  });

  it('keeps caption indexed when embedding fails and marks the job result partial', async () => {
    const { instance, updateStatus } = application({ failEmbedding: true });
    const result = await instance.execute(job, context);
    expect(result.result).toMatchObject({
      captionStatus: 'indexed',
      vectorStatus: 'error',
      embeddingFailureCode: 'KNOWLEDGE_MODEL_FAILED',
    });
    expect(updateStatus).toHaveBeenCalledWith(source.id, 'partial', context, 2);
  });

  it('keeps the vector path available when the VLM binding is missing', async () => {
    const { instance, commit, updateStatus } = application({ failVlmResolution: true });
    const result = await instance.execute(job, context);
    expect(result.result).toMatchObject({
      captionStatus: 'error',
      vectorStatus: 'indexed',
      visionEmbeddingModelId: 'mock-embedding-1536',
    });
    expect(
      commit.mock.calls[0]?.[0].indexes.map((index: { indexId: string }) => index.indexId),
    ).toEqual(['image']);
    expect(updateStatus).toHaveBeenCalledWith(source.id, 'partial', context, 2);
  });

  it('fails with 422 when both media model paths are unavailable', async () => {
    const { instance, commit } = application({
      failVlmResolution: true,
      failEmbeddingResolution: true,
    });
    await expect(instance.execute(job, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(commit).not.toHaveBeenCalled();
  });
});
