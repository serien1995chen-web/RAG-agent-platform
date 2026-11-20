import { describe, expect, it } from 'vitest';
import {
  S5AiproxyHttpAdapter,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-kb-b16-a-security',
  memberId: 'mem-kb-b16-a-security',
  requestId: 'req-kb-b16-a-security',
  traceId: 'trace-kb-b16-a-security',
  scopes: ['knowledge:search'],
};

describe('B16 codexA search security', () => {
  it('L1-B16-A-SEARCH-001-Q01 never includes the provider token in auth failures', async () => {
    const secret = 'sk-kb-b16-a-never-print';
    const transport: S5HttpTransportPort = {
      request: async () => ({
        status: 401,
        headers: {},
        data: { error: { message: `echo ${secret}` } },
      }),
    };
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://tokendance.example.invalid/gateway/v1',
      token: secret,
      transport,
      providerOnly: ['alibaba'],
      rerankProtocol: 'alibaba-native',
    });
    try {
      await adapter.invoke(
        {
          kind: 'embedding',
          modelId: 'qwen3.7-text-embedding',
          input: [{ type: 'text', text: 'security probe' }],
          dimension: 1024,
        },
        context,
      );
      throw new Error('expected auth rejection');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it('L1-B16-A-SEARCH-001-Q02 never exposes raw unauthorized content through the engine', async () => {
    const { createSearchEngine } = await import('../../packages/search/src/index');
    const result = await createSearchEngine({
      embedding: { embed: async () => [[1]] },
      vectors: {
        embRecall: async () => [
          { segmentId: 'private-segment', sourceId: 'private-source', indexId: 'idx', score: 1 },
        ],
      },
      hydrator: {
        hydrate: async () => ({
          items: [],
          rejected: 1,
        }),
      },
    }).search(
      {
        requestId: context.requestId,
        workspaceId: context.workspaceId,
        memberId: context.memberId,
        knowledgeSpaceIds: ['space-private'],
        textQueries: ['private query'],
        imageQueries: [],
        models: { embeddingModel: 'qwen3.7-text-embedding' },
        searchMode: 'embedding',
        limit: 10,
        maxTokens: 5_000,
        similarity: 0,
      },
      context,
    );
    expect(result.authorizedCandidates).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-source');
  });

  it('L1-B16-A-SEARCH-002-Q01 accepts strict filters without raw query operators or secrets', async () => {
    const { SearchApiRequestSchema } = await import('../../packages/contracts/src/index');
    const parsed = SearchApiRequestSchema.safeParse({
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      query: 'refund',
      tokenBudget: 5000,
      filters: {
        logic: 'AND',
        conditions: [],
        sourceIds: ['65f1e5b2a1c9d4b7e8f10001'],
      },
      __proto__: { token: 'forbidden' },
    });
    expect(parsed.success).toBe(true);
    const unsafe = SearchApiRequestSchema.safeParse({
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      query: 'refund',
      tokenBudget: 5000,
      mongoQuery: { $where: 'return true' },
    });
    expect(unsafe.success).toBe(false);
  });
});
