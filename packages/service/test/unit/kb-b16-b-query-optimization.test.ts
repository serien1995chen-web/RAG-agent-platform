import { describe, expect, it } from 'vitest';
import type { SearchApiRequest } from '@kb/contracts';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { preservesQueryOptimizationFacts } from '../../src/modules/knowledge/application/s7-query-facts';

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
  it('L1-B16-B-SEARCH-003-N05 preserves required facts and permits background facts', () => {
    expect(
      preservesQueryOptimizationFacts({
        query: 'Acme-9 退款政策',
        background: 'Acme Shop supports refunds.',
        rewritten: 'Acme-9 客户退款政策',
      }),
    ).toBe(true);
    expect(
      preservesQueryOptimizationFacts({
        query: 'Acme-9 退款政策',
        rewritten: '退款政策',
      }),
    ).toBe(false);
    expect(
      preservesQueryOptimizationFacts({
        query: '退款政策',
        background: 'Acme-9 supports refunds.',
        rewritten: 'Acme-9 退款政策',
      }),
    ).toBe(true);
  });

  it('L1-B16-B-SEARCH-003-N03 rejects a model rewrite that introduces a new entity', async () => {
    const result = await expand(application('Zephyr-9 客户多久退款？'));

    expect(result.originalQuery).toBe(request.query);
    expect(result.expandedQuery).not.toContain('Zephyr-9');
    expect(result.fallbackReason).toBe('query_optimization_failed');
  });

  it('L1-B16-B-SEARCH-003-N04 rejects new numbers and dates while preserving valid rewrites', async () => {
    const rewrite = await expand(application('客户退款需要多长时间？'));
    expect(rewrite).toMatchObject({
      expandedQuery: '客户退款需要多长时间？',
      fallbackReason: null,
    });

    const number = await expand(application('客户退款需要 7 天？'));
    expect(number).toMatchObject({
      expandedQuery: request.query,
      fallbackReason: 'query_optimization_failed',
    });

    const date = await expand(application('客户 2027-01-01 退款需要多久？'));
    expect(date).toMatchObject({
      expandedQuery: request.query,
      fallbackReason: 'query_optimization_failed',
    });

    const quoted = await expand(application('“极光集团”客户多久退款？'));
    expect(quoted).toMatchObject({
      expandedQuery: request.query,
      fallbackReason: 'query_optimization_failed',
    });
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
