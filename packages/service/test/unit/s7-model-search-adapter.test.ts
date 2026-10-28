import { describe, expect, it } from 'vitest';
import type {
  S5ModelGatewayPort,
  S5ModelGatewayRequest,
} from '../../src/modules/knowledge/application/s5-model-gateway.port';
import { S7ModelGatewaySearchAdapter } from '../../src/modules/knowledge/adapter/s7-model-gateway-search.adapter';
import { S7SearchPipelineFactory } from '../../src/modules/knowledge/adapter/s7-search-pipeline.factory';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s7_model',
  memberId: 'mem_s7_model',
  requestId: 'req_s7_model',
  traceId: 'trace_s7_model',
  scopes: ['knowledge:search'],
};

function gateway(handler: (request: S5ModelGatewayRequest) => unknown) {
  const calls: S5ModelGatewayRequest[] = [];
  const port: S5ModelGatewayPort = {
    async invoke<T>(request: S5ModelGatewayRequest) {
      calls.push(request);
      return {
        data: handler(request) as T,
        actualModelId: request.modelId,
        attempts: 1,
        fallbackUsed: false,
        degraded: false,
        usage: { inputTokens: 4, outputTokens: 0, quantity: 4 },
      };
    },
  };
  return { port, calls };
}

describe('TEST-MODEL-003-BLOCK S7 model gateway consumption', () => {
  it('embeds with the bound dimension through S5 gateway', async () => {
    const fake = gateway(() => ({
      data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.25) }],
      usage: { prompt_tokens: 2 },
    }));
    const adapter = new S7ModelGatewaySearchAdapter({
      gateway: fake.port,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      embedding: { modelId: 'mock-embedding-768', dimension: 768 },
    });
    const vectors = await adapter.embed(
      {
        models: { embeddingModel: 'mock-embedding-768' },
        texts: ['refund'],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(768);
    expect(fake.calls[0]).toMatchObject({
      kind: 'embedding',
      modelId: 'mock-embedding-768',
      dimension: 768,
      operation: 'search:embedding',
    });
  });

  it('keeps provider ranked order and rejects unknown candidate references', async () => {
    const fake = gateway(() => ({
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
      ],
      usage: { prompt_tokens: 2 },
    }));
    const adapter = new S7ModelGatewaySearchAdapter({
      gateway: fake.port,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      embedding: { modelId: 'mock-embedding-768', dimension: 768 },
      rerank: { modelId: 'mock-rerank', dimension: 768 },
    });
    const ranked = await adapter.rerank(
      {
        model: 'mock-rerank',
        query: 'refund',
        items: [
          { id: 'a', text: 'alpha', score: 1 },
          { id: 'b', text: 'beta', score: 0.5 },
        ],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(ranked).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.4 },
    ]);
  });

  it('returns a stable invalid-output error for invalid vectors', async () => {
    const adapter = new S7ModelGatewaySearchAdapter({
      gateway: gateway(() => ({ data: [{ embedding: [1] }] })).port,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      embedding: { modelId: 'mock-embedding-768', dimension: 768 },
    });
    await expect(
      adapter.embed(
        {
          models: { embeddingModel: 'mock-embedding-768' },
          texts: ['refund'],
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
  });

  it('propagates actual gateway usage through the search pipeline dependency', async () => {
    const fake = gateway((request) =>
      request.kind === 'embedding'
        ? { data: [{ index: 0, embedding: Array.from({ length: 768 }, () => 0.25) }] }
        : { results: [{ index: 0, relevance_score: 1 }] },
    );
    const factory = new S7SearchPipelineFactory({
      vectors: {} as never,
      modelGateway: fake.port,
      fullText: {} as never,
      authorization: {} as never,
    });
    const deps = factory.create({
      space: {
        spaceId: '65f1e5b2a1c9d4b7e8f01234',
        workspaceId: context.workspaceId,
        sourcePermissionEnabled: true,
      },
      models: {
        embedding: { modelId: 'mock-embedding-768', dimension: 768 },
        rerank: { modelId: 'mock-rerank', dimension: 768 },
      },
      usingRerank: true,
      context,
    });
    await deps.embedding.embed(
      {
        models: { embeddingModel: 'mock-embedding-768' },
        texts: ['refund'],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    await deps.rerank!.rerank(
      {
        model: 'mock-rerank',
        query: 'refund',
        items: [{ id: 'a', text: 'alpha', score: 0.5 }],
        options: { timeoutMs: 1_000 },
      },
      context,
    );
    expect(deps.modelUsage).toEqual({ inputTokens: 8, outputTokens: 0 });
  });
});
