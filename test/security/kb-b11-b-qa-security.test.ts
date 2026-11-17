import { describe, expect, it } from 'vitest';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import type { S5ModelGatewayPort } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b11-b-security',
  memberId: 'member-b11-b-security',
  requestId: 'req-b11-b-security',
  traceId: 'trace-b11-b-security',
  scopes: ['knowledge:write'],
};

describe('L1-B11-B PARSE-004 security and redaction', () => {
  it('L1-B11-B-PARSE-004-Q01 never returns the custom prompt, provider body or token in an error', async () => {
    const gateway: S5ModelGatewayPort = {
      async invoke() {
        throw Object.assign(new Error('provider leaked B11B_SECRET_TOKEN and full prompt'), {
          status: 503,
          responseBody: 'private provider response',
        });
      },
    };
    const adapter = new S5QaPipelineAdapter({
      gateway,
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    const error = await adapter
      .generate({
        chunk: {
          index: 0,
          text: 'B11B_PRIVATE_BUSINESS_TEXT',
          contentHash: 'sha256:security',
        },
        settings: {
          trainingType: 'qa',
          chunkSettingMode: 'auto',
          qaPrompt: 'B11B_PRIVATE_INTERNAL_PROMPT',
        },
        context,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-b11-b-security',
        sourceId: 'source-b11-b-security',
      })
      .catch((thrown: unknown) => thrown);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('B11B_SECRET_TOKEN');
    expect(serialized).not.toContain('private provider response');
    expect(serialized).not.toContain('B11B_PRIVATE_BUSINESS_TEXT');
    expect(serialized).not.toContain('B11B_PRIVATE_INTERNAL_PROMPT');
  });

  it('L1-B11-B-PARSE-004-Q02 does not expose prompt text in successful result metadata', async () => {
    const adapter = new S5QaPipelineAdapter({
      gateway: {
        async invoke<T = unknown>() {
          return {
            data: { choices: [{ message: { content: 'Q1: q\nA1: a' } }] } as T,
            actualModelId: 'fake-llm',
            attempts: 1,
            fallbackUsed: false,
            degraded: false,
            usage: { inputTokens: 1, outputTokens: 1, quantity: 2 },
          };
        },
      },
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    const result = await adapter.generate({
      chunk: { index: 0, text: 'safe source', contentHash: 'sha256:security' },
      settings: {
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        qaPrompt: 'B11B_PRIVATE_INTERNAL_PROMPT',
      },
      context,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-b11-b-security',
      sourceId: 'source-b11-b-security',
    });
    expect(JSON.stringify(result)).not.toContain('B11B_PRIVATE_INTERNAL_PROMPT');
  });
});
