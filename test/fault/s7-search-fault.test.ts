import {
  createKnowledgeError,
  type KnowledgeErrorCode,
  type SearchRequest,
} from '../../packages/contracts/src/index';
import { createSearchEngine, type SearchEngineDeps } from '../../packages/search/src/index';
import { describe, expect, it } from 'vitest';

const context = { requestId: 'req-s7-fault', workspaceId: 'ws-s7-fault' };

function request(mode: SearchRequest['searchMode']): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: 'mem-s7-fault',
    knowledgeSpaceIds: ['space-fault'],
    textQueries: ['refund'],
    imageQueries: [],
    models: { embeddingModel: 'embedding' },
    searchMode: mode,
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

function failure(code: KnowledgeErrorCode) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.requestId,
    details: {},
  });
}

function deps(error: unknown): SearchEngineDeps {
  return {
    vectors: {
      embRecall: async () => {
        throw error;
      },
    },
    embedding: { embed: async () => [[1]] },
    fullText: {
      search: async () => {
        throw error;
      },
    },
  };
}

describe('TEST-SEARCH-001/002/004-BLOCK S7 dependency failures', () => {
  it.each([
    ['KNOWLEDGE_RATE_LIMITED', 'KNOWLEDGE_RATE_LIMITED'],
    ['KNOWLEDGE_MODEL_FAILED', 'KNOWLEDGE_MODEL_FAILED'],
    ['KNOWLEDGE_DEPENDENCY_UNAVAILABLE', 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE'],
    ['KNOWLEDGE_DEPENDENCY_TIMEOUT', 'KNOWLEDGE_DEPENDENCY_TIMEOUT'],
  ] as const)('maps all-channel %s without fake success', async (input, expected) => {
    await expect(
      createSearchEngine(deps(failure(input))).search(request('mixedRecall'), context),
    ).rejects.toMatchObject({
      problem: { error: { code: expected } },
    });
  });

  it('uses the D1 priority timeout > rate > unavailable > model', async () => {
    const failureDeps: SearchEngineDeps = {
      vectors: {
        embRecall: async () => {
          throw failure('KNOWLEDGE_MODEL_FAILED');
        },
      },
      fullText: {
        search: async () => {
          throw failure('KNOWLEDGE_DEPENDENCY_TIMEOUT');
        },
      },
      embedding: { embed: async () => [[1]] },
    };
    await expect(
      createSearchEngine(failureDeps).search(request('mixedRecall'), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });

  it('returns 207 for one successful channel and does not issue citations for the failed channel', async () => {
    const result = await createSearchEngine({
      vectors: {
        embRecall: async () => [
          { segmentId: 'a', sourceId: 'source-a', indexId: 'idx', score: 0.9 },
        ],
      },
      embedding: { embed: async () => [[1]] },
      fullText: {
        search: async () => {
          throw failure('KNOWLEDGE_DEPENDENCY_TIMEOUT');
        },
      },
      resolveTexts: async () => new Map([['space-fault:a', 'allowed text']]),
    }).search(request('mixedRecall'), context);
    expect(result.status).toBe(207);
    expect(result.citations).toHaveLength(1);
    expect(result.stats.degraded).toContainEqual({
      stage: 'fullText',
      reason: 'fulltext_recall_failed',
    });
  });
});
