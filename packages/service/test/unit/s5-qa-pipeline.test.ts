import { describe, expect, it } from 'vitest';
import type { ChunkingSettings } from '@kb/chunk';
import { S5QaPipelineAdapter } from '../../src/modules/knowledge/application/s5-qa-pipeline';
import type {
  S5GatewayResult,
  S5ModelGatewayPort,
  S5ModelGatewayRequest,
} from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_qa_pipeline',
  memberId: 'mem_qa_pipeline',
  requestId: 'req-qa-pipeline',
  traceId: 'trace-qa-pipeline',
  scopes: ['knowledge:write'],
};

const settings: ChunkingSettings = {
  trainingType: 'qa',
  chunkSettingMode: 'auto',
};

function gateway(content: string, calls: S5ModelGatewayRequest[] = []): S5ModelGatewayPort {
  return {
    async invoke<T = unknown>(request: S5ModelGatewayRequest): Promise<S5GatewayResult<T>> {
      calls.push(request);
      return {
        data: {
          choices: [{ message: { content } }],
        } as T,
        actualModelId: request.modelId,
        attempts: 1,
        fallbackUsed: false,
        degraded: false,
        usage: { inputTokens: 5, outputTokens: 7, quantity: 12 },
      };
    },
  };
}

function request(content = 'Q1: 问题\nA1: 答案') {
  const calls: S5ModelGatewayRequest[] = [];
  const adapter = new S5QaPipelineAdapter({
    gateway: gateway(content, calls),
    resolveModels: async () => ({
      llmModelId: 'mock-llm-general',
      embeddingModelId: 'mock-embedding-768',
    }),
  });
  return {
    calls,
    result: adapter.generate({
      chunk: {
        index: 0,
        text: '知识库问答原文',
        contentHash: 'sha256:chunk',
      },
      settings,
      context,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
    }),
  };
}

describe('TEST-PARSE-004-BLOCK QA model pipeline', () => {
  it('resolves the Space LLM binding and returns validated deduped QA items', async () => {
    const { result, calls } = request('Q1: 重复问题\nA1: 重复答案\nQ2: 重复问题\nA2: 重复答案');
    await expect(result).resolves.toMatchObject({
      fallback: 'none',
      promptVersion: 'qa.default@1',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    const value = await result;
    expect(value.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'llm',
      modelId: 'mock-llm-general',
      workspaceId: context.workspaceId,
      resourceType: 'space',
    });
  });

  it('returns chunk_split fallback for invalid model output without fake QA', async () => {
    const { result } = request('not a QA payload');
    await expect(result).resolves.toMatchObject({
      items: [],
      fallback: 'chunk_split',
    });
  });
});
