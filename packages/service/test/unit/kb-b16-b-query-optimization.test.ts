import { describe, expect, it } from 'vitest';
import type { SearchApiRequest } from '@kb/contracts';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-kb-b16-b-query-optimization',
  memberId: 'mem-kb-b16-b-query-optimization',
  requestId: 'req-kb-b16-b-query-optimization',
  traceId: 'trace-kb-b16-b-query-optimization'.padEnd(32, '0'),
  scopes: ['knowledge:search', 'knowledge:read'],
};

const request: SearchApiRequest = {
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f09700',
  query: '它多久退款？',
  tokenBudget: 5_000,
  similarity: 0.2,
  searchMode: 'hybrid',
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
  queryOptimizationEnabled: true,
  queryOptimizationModelId: 'llm-b16-b',
  queryOptimizationPrompt: 'Acme Shop refunds take five business days.',
};

function application(content: string | Error) {
  return new S7SearchApplication({
    modelGateway: {
      async invoke() {
        if (content instanceof Error) throw content;
        return {
          data: {
            choices: [{ message: { content } }],
          },
          actualModelId: 'llm-b16-b',
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 10, outputTokens: 4, quantity: 14 },
        };
      },
    },
  } as never);
}

function expand(app: S7SearchApplication) {
  const internal = app as unknown as {
    queryExpansionFor(
      spaces: string[],
      tenant: TenantContext,
      body: SearchApiRequest,
      model?: string,
    ):
      | {
          expand(
            query: string,
            tenant: TenantContext,
          ): Promise<{
            originalQuery: string;
            expandedQuery: string;
            fallbackReason: string | null;
          }>;
        }
      | undefined;
  };
  return internal
    .queryExpansionFor(
      [request.knowledgeSpaceId],
      context,
      request,
      request.queryOptimizationModelId,
    )!
    .expand(request.query, context);
}

describe('L1-B16-B-SEARCH-003 query optimization application', () => {
  it('L1-B16-B-SEARCH-003-N03 rejects a model rewrite that introduces a new entity', async () => {
    const result = await expand(application('Zephyr-9 客户多久退款？'));

    expect(result.originalQuery).toBe(request.query);
    expect(result.expandedQuery).not.toContain('Zephyr-9');
  });

  it('L1-B16-B-SEARCH-003-F01 falls back to the original query and marks degradation', async () => {
    const result = await expand(application(new Error('provider timeout')));

    expect(result).toMatchObject({
      originalQuery: request.query,
      expandedQuery: request.query,
      fallbackReason: 'query_optimization_failed',
    });
  });
});
