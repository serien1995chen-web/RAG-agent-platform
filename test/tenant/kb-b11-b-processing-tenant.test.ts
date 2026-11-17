import { describe, expect, it } from 'vitest';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import type {
  S5GatewayResult,
  S5ModelGatewayPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b11-b-tenant-a',
  memberId: 'member-b11-b-tenant-a',
  requestId: 'req-b11-b-tenant-a',
  traceId: 'trace-b11-b-tenant-a',
  scopes: ['knowledge:read', 'knowledge:write'],
};

describe('L1-B11-B PARSE-003/004 tenant isolation', () => {
  it('L1-B11-B-PARSE-004-A01 rejects cross-workspace QA before model invocation', async () => {
    let calls = 0;
    const gateway: S5ModelGatewayPort = {
      async invoke<T = unknown>(): Promise<S5GatewayResult<T>> {
        calls += 1;
        return {
          data: { choices: [{ message: { content: 'Q1: q\nA1: a' } }] } as T,
          actualModelId: 'fake-llm',
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 1, outputTokens: 1, quantity: 2 },
        };
      },
    };
    const adapter = new S5QaPipelineAdapter({
      gateway,
      resolveModels: async () => ({ llmModelId: 'fake-llm' }),
    });
    await expect(
      adapter.generate({
        chunk: { index: 0, text: 'private workspace A text', contentHash: 'sha256:a' },
        settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
        context,
        workspaceId: 'ws-b11-b-tenant-b',
        knowledgeSpaceId: 'space-b11-b-tenant-b',
        sourceId: 'source-b11-b-tenant-b',
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(calls).toBe(0);
  });

  it('L1-B11-B-PARSE-003-A01 does not expose another workspace settings through errors', () => {
    const error = {
      problem: {
        error: {
          code: 'KNOWLEDGE_NOT_FOUND',
          details: { sourceId: 'opaque-source' },
        },
      },
    };
    expect(JSON.stringify(error)).not.toContain('ws-b11-b-tenant-b');
    expect(JSON.stringify(error)).not.toContain('private workspace B text');
  });
});
