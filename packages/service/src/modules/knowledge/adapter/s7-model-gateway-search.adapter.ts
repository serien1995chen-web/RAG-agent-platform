import { createKnowledgeError } from '@kb/contracts';
import type {
  S5ModelGatewayPort,
  S5ModelGatewayRequest,
  S5ModelInvocation,
} from '../application/s5-model-gateway.port';
import type { S7BoundModel } from '../application/s7-search.ports';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

interface EmbeddingEnvelope {
  data: Array<{ index?: number; embedding: number[] }>;
}

interface RerankEnvelope {
  results: Array<{
    index: number;
    relevance_score?: number;
    score?: number;
  }>;
}

function outputInvalid(context: TenantContext, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason },
  });
}

export class S7ModelGatewaySearchAdapter {
  constructor(
    private readonly input: {
      gateway: S5ModelGatewayPort;
      knowledgeSpaceId: string;
      embedding: S7BoundModel;
      rerank?: S7BoundModel;
    },
  ) {}

  private invocation(invocation: S5ModelInvocation, context: TenantContext): S5ModelGatewayRequest {
    return {
      ...invocation,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: this.input.knowledgeSpaceId,
      requestId: context.requestId,
      traceId: context.traceId,
      context,
      resourceType: 'space',
      resourceId: this.input.knowledgeSpaceId,
      operation: `search:${invocation.kind}`,
    };
  }

  async embed(
    input: {
      models: { embeddingModel: string };
      texts: string[];
      options: { timeoutMs: number };
    },
    context: TenantContext,
  ): Promise<number[][]> {
    const result = await this.input.gateway.invoke<EmbeddingEnvelope>(
      this.invocation(
        {
          kind: 'embedding',
          modelId: this.input.embedding.modelId,
          texts: input.texts,
          dimension: this.input.embedding.dimension,
        },
        context,
      ),
    );
    if (
      !Array.isArray(result.data?.data) ||
      result.data.data.length !== input.texts.length ||
      result.data.data.some(
        (item) =>
          !Array.isArray(item.embedding) ||
          item.embedding.length !== this.input.embedding.dimension ||
          item.embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw outputInvalid(context, 'invalid_embedding_output');
    }
    return result.data.data.map((item) => item.embedding);
  }

  async rerank(
    input: {
      model: string;
      query: string;
      items: Array<{ id: string; text: string; score: number }>;
      options: { timeoutMs: number };
    },
    context: TenantContext,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.input.rerank) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { field: 'rerankModel', reason: 'binding_missing' },
      });
    }
    const result = await this.input.gateway.invoke<RerankEnvelope>(
      this.invocation(
        {
          kind: 'rerank',
          modelId: this.input.rerank.modelId,
          query: input.query,
          candidates: input.items.map((item) => item.text),
        },
        context,
      ),
    );
    if (!Array.isArray(result.data?.results)) {
      throw outputInvalid(context, 'invalid_rerank_output');
    }
    const ranked = result.data.results
      .map((entry) => {
        const source = input.items[entry.index];
        const score = entry.relevance_score ?? entry.score;
        if (!Number.isInteger(entry.index) || !source || score === undefined) return undefined;
        if (!Number.isFinite(score)) return undefined;
        return { id: source.id, score };
      })
      .filter((entry): entry is { id: string; score: number } => entry !== undefined)
      .sort((left, right) => right.score - left.score);
    if (ranked.length !== result.data.results.length) {
      throw outputInvalid(context, 'invalid_rerank_candidate_reference');
    }
    return ranked;
  }
}
