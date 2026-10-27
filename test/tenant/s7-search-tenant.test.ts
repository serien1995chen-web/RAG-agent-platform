import { createKnowledgeError, type SearchRequest } from '../../packages/contracts/src/index';
import { createSearchEngine } from '../../packages/search/src/index';
import { describe, expect, it } from 'vitest';
import { S7SearchApplication } from '../../packages/service/src/modules/knowledge/application/s7-search.application';
import type { S7SearchApplicationDependencies } from '../../packages/service/src/modules/knowledge/application/s7-search.ports';

const context = {
  requestId: 'req-s7-tenant',
  workspaceId: 'ws-tenant-a',
  memberId: 'mem-tenant-a',
  traceId: 'trace-tenant-a',
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
    models: { embeddingModel: 'embedding' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

describe('TEST-X-SEARCH-REAUTH tenant isolation', () => {
  it('drops a recalled hit after ACL revocation and never leaks source existence', async () => {
    const result = await createSearchEngine({
      vectors: {
        embRecall: async () => [
          {
            segmentId: '65f1e5b2a1c9d4b7e8f20001',
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            indexId: 'idx',
            score: 0.99,
          },
        ],
      },
      embedding: { embed: async () => [[1]] },
      hydrator: {
        hydrate: async () => ({ items: [], rejected: 1 }),
      },
    }).search(request(), context);
    expect(result.status).toBe(200);
    expect(result.citations).toEqual([]);
    expect(result.stats.degraded).toEqual([]);
  });

  it('maps a cross-tenant space lookup to the same not-found shape', async () => {
    const error = createKnowledgeError({
      code: 'KNOWLEDGE_NOT_FOUND',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {},
    });
    const dependencies = {
      access: {
        assertSearchScope() {},
        async getAuthorizedSpace() {
          throw error;
        },
      },
      models: {
        async resolveModels() {
          throw new Error('must not resolve models');
        },
      },
      filters: {
        async listFilterFacts() {
          throw new Error('must not read filters');
        },
      },
      fullText: {
        async search() {
          return [];
        },
      },
      authorization: {
        async hydrate() {
          return { items: [], rejected: 0 };
        },
        async reauthorizeCitation() {
          return undefined;
        },
      },
      pipeline: {
        create() {
          throw new Error('must not create pipeline');
        },
      },
      citations: {
        async issueWithAudit() {
          return new Map();
        },
        async findCurrent() {
          return null;
        },
      },
      audits: {
        async appendSearch() {},
      },
    } as unknown as S7SearchApplicationDependencies;
    await expect(
      new S7SearchApplication(dependencies).searchSemantic(
        {
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
          query: 'refund',
          tokenBudget: 5_000,
          searchMode: 'semantic',
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: { code: 'KNOWLEDGE_NOT_FOUND', details: {} },
        requestId: context.requestId,
      },
    });
  });
});
