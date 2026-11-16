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
  workspaceId: 'ws-b11-b-orchestration',
  memberId: 'member-b11-b-orchestration',
  requestId: 'req-b11-b-orchestration',
  traceId: 'trace-b11-b-orchestration',
  scopes: ['knowledge:write'],
};

function gatewayFor(content: string, requests: S5ModelGatewayRequest[] = []): S5ModelGatewayPort {
  return {
    async invoke<T = unknown>(request: S5ModelGatewayRequest): Promise<S5GatewayResult<T>> {
      requests.push(request);
      return {
        data: {
          choices: [{ message: { content } }],
        } as T,
        actualModelId: request.modelId,
        attempts: 1,
        fallbackUsed: false,
        degraded: false,
        usage: { inputTokens: 13, outputTokens: 5, quantity: 18 },
      };
    },
  };
}

function input(settings: ChunkingSettings = { trainingType: 'qa', chunkSettingMode: 'auto' }) {
  return {
    chunk: {
      index: 0,
      text: '退款申请会在五个工作日内处理。Refund requests take five business days.',
      contentHash: 'sha256:source-chunk-b11-b',
    },
    settings,
    context,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
    sourceId: '65f1e5b2a1c9d4b7e8f10002',
  };
}

describe('L1-B11-B-PARSE-004 service orchestration', () => {
  it('L1-B11-B-PARSE-004-P01 forwards model binding and returns validated source-bound items', async () => {
    const requests: S5ModelGatewayRequest[] = [];
    const adapter = new S5QaPipelineAdapter({
      gateway: gatewayFor('Q1: 退款需要多久？\nA1: 五个工作日。', requests),
      resolveModels: async () => ({
        llmModelId: 'fake-llm',
        embeddingModelId: 'fake-embedding',
      }),
    });
    await expect(adapter.generate(input())).resolves.toMatchObject({
      fallback: 'none',
      promptVersion: 'qa.default@1',
      usage: { inputTokens: 13, outputTokens: 5 },
      items: [
        {
          q: '退款需要多久？',
          a: '五个工作日。',
          sourceChunkHash: 'sha256:source-chunk-b11-b',
        },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workspaceId: context.workspaceId,
      modelId: 'fake-llm',
      operation: 'qa:sha256:source-chunk-b11-b',
    });
  });

  it('L1-B11-B-PARSE-004-F01 uses one request and raw chunk fallback for invalid output', async () => {
    const requests: S5ModelGatewayRequest[] = [];
    const adapter = new S5QaPipelineAdapter({
      gateway: gatewayFor('not a QA payload', requests),
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    const result = await adapter.generate(input());
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      fallback: 'chunk_split',
      usage: { inputTokens: 13, outputTokens: 5 },
      items: [
        {
          q: input().chunk.text,
          a: '',
          sourceChunkHash: 'sha256:source-chunk-b11-b',
        },
      ],
    });
  });

  it('L1-B11-B-PARSE-004-P04 forwards a custom QA prompt and version evidence', async () => {
    const requests: S5ModelGatewayRequest[] = [];
    const adapter = new S5QaPipelineAdapter({
      gateway: gatewayFor('Q1: q\nA1: a', requests),
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    const result = await adapter.generate(
      input({
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        qaPrompt: 'B11B_CUSTOM_GROUNDED_PROMPT',
      }),
    );
    expect(JSON.stringify(requests[0]?.messages)).toContain('B11B_CUSTOM_GROUNDED_PROMPT');
    expect(result.promptVersion).not.toBe('qa.default@1');
    expect(result.promptVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('L1-B11-B-PARSE-004-A01 rejects a workspace/context mismatch before model invocation', async () => {
    const requests: S5ModelGatewayRequest[] = [];
    const adapter = new S5QaPipelineAdapter({
      gateway: gatewayFor('Q1: q\nA1: a', requests),
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    await expect(
      adapter.generate({
        ...input(),
        workspaceId: 'ws-other-b11-b',
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(requests).toHaveLength(0);
  });

  it('L1-B11-B-PARSE-004-N01 rejects QA without an LLM binding', async () => {
    const adapter = new S5QaPipelineAdapter({
      gateway: gatewayFor('Q1: q\nA1: a'),
      resolveModels: async () => ({ llmModelId: '' }),
    });
    await expect(adapter.generate(input())).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'modelBindings.llm', reason: 'required_for_qa' },
        },
      },
    });
  });
});
