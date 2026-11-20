import { describe, expect, it } from 'vitest';
import { createSearchEngine, type SearchEngineDeps } from '../../packages/search/src/index';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-kb-b16-a-real',
  memberId: 'mem-kb-b16-a-real',
  requestId: 'req-kb-b16-a-real',
  traceId: 'trace-kb-b16-a-real',
  scopes: ['knowledge:search'],
};

function provider() {
  const env = process.env;
  const config = loadS5AiproxyConfig(env);
  return new S5AiproxyHttpAdapter({
    baseUrl: config.baseUrl!,
    token: env.AIPROXY_API_TOKEN!,
    transport: new AxiosS5HttpTransport(),
    ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
    rerankProtocol: config.rerankProtocol,
  });
}

function cosine(left: readonly number[], right: readonly number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

describe('B16 codexA TokenDance real provider', () => {
  it('L1-B16-A-SEARCH-001-P01 returns a finite 1024 dimension embedding with usage', async () => {
    const result = await provider().invoke<{
      data: Array<{ embedding: number[] }>;
      usage: { prompt_tokens: number; total_tokens: number };
    }>(
      {
        kind: 'embedding',
        modelId: process.env.S11_AIPROXY_EMBEDDING_MODEL!,
        input: [{ type: 'text', text: 'B16 TokenDance embedding validation' }],
        dimension: 1024,
      },
      context,
    );
    expect(result.status).toBe(200);
    expect(result.data.data).toHaveLength(1);
    expect(result.data.data[0]!.embedding).toHaveLength(1024);
    expect(result.data.data[0]!.embedding.every(Number.isFinite)).toBe(true);
    expect(result.data.usage.total_tokens).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('L1-B16-A-SEARCH-004-P01 reranks via the native response and maps provider indexes', async () => {
    const result = await provider().invoke<{
      results: Array<{ index: number; relevance_score: number }>;
      usage: { total_tokens: number };
    }>(
      {
        kind: 'rerank',
        modelId: process.env.S11_AIPROXY_RERANK_MODEL!,
        query: 'refund processing time',
        candidates: [
          'The weather is sunny today.',
          'Refunds are processed within five business days.',
          '退款将在五个工作日内到账。',
        ],
      },
      context,
    );
    expect(result.status).toBe(200);
    expect(result.data.results).toHaveLength(3);
    expect(result.data.results[0]).toMatchObject({
      index: expect.any(Number),
      relevance_score: expect.any(Number),
    });
    expect(result.data.results.every((entry) => Number.isFinite(entry.relevance_score))).toBe(true);
    expect(result.data.usage.total_tokens).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('L1-B16-A-SEARCH-004-P02 runs real embedding and rerank through the search engine', async () => {
    const adapter = provider();
    const documents = [
      'The weather is sunny today.',
      'Refunds are processed within five business days.',
      '退款将在五个工作日内到账。',
    ];
    let queryVector: number[] | undefined;
    const vectors = await Promise.all(
      documents.map(async (text) => {
        const response = await adapter.invoke<{ data: Array<{ embedding: number[] }> }>(
          {
            kind: 'embedding',
            modelId: process.env.S11_AIPROXY_EMBEDDING_MODEL!,
            input: [{ type: 'text', text }],
            dimension: 1024,
          },
          context,
        );
        return response.data.data[0]!.embedding;
      }),
    );
    const deps: SearchEngineDeps = {
      modelUsage: { inputTokens: 0, outputTokens: 0 },
      embedding: {
        embed: async ({ texts }) => {
          const output: number[][] = [];
          for (const text of texts) {
            const response = await adapter.invoke<{
              data: Array<{ embedding: number[] }>;
            }>(
              {
                kind: 'embedding',
                modelId: process.env.S11_AIPROXY_EMBEDDING_MODEL!,
                input: [{ type: 'text', text }],
                dimension: 1024,
              },
              context,
            );
            output.push(response.data.data[0]!.embedding);
          }
          queryVector = output[0];
          return output;
        },
      },
      vectors: {
        embRecall: async () =>
          vectors.map((vector, index) => ({
            segmentId: `real-${index + 1}`,
            sourceId: `source-${index + 1}`,
            indexId: `index-${index + 1}`,
            score: cosine(queryVector!, vector),
          })),
      },
      resolveTexts: async (items) =>
        new Map(
          items.map((item) => [
            item.docId,
            documents[Number(item.segmentId?.split('-')[1] ?? 1) - 1]!,
          ]),
        ),
      rerank: {
        rerank: async ({ query, items }) => {
          const response = await adapter.invoke<{
            results: Array<{ index: number; relevance_score: number }>;
          }>(
            {
              kind: 'rerank',
              modelId: process.env.S11_AIPROXY_RERANK_MODEL!,
              query,
              candidates: items.map((item) => item.text),
            },
            context,
          );
          return response.data.results
            .filter((entry) => items[entry.index])
            .map((entry) => ({
              id: items[entry.index]!.id,
              score: entry.relevance_score,
            }))
            .sort((left, right) => right.score - left.score);
        },
      },
    };
    const result = await createSearchEngine(deps).search(
      {
        requestId: context.requestId,
        workspaceId: context.workspaceId,
        memberId: context.memberId,
        knowledgeSpaceIds: ['space-kb-b16-a-real'],
        textQueries: ['How long does a refund take?'],
        imageQueries: [],
        models: {
          embeddingModel: process.env.S11_AIPROXY_EMBEDDING_MODEL!,
          rerankModel: process.env.S11_AIPROXY_RERANK_MODEL!,
        },
        searchMode: 'embedding',
        limit: 10,
        maxTokens: 5_000,
        similarity: 0,
        weights: { embedding: 0.5, rerank: 1 },
      },
      context,
    );
    expect(result.stats.rerankApplied).toBe(true);
    expect(result.citations).toHaveLength(3);
    expect(result.citations[0]?.scores.some((entry) => entry.type === 'reRank')).toBe(true);
  }, 120_000);
});
