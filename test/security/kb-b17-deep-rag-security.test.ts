import { describe, expect, it } from 'vitest';
import {
  DeepSearchApiRequestSchema,
  DeepSearchApiResponseSchema,
} from '../../packages/contracts/src';
import {
  S5AiproxyHttpAdapter,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b17_security',
  memberId: 'mem_b17_security',
  requestId: 'req_b17_security',
  traceId: 'b17-security-trace-0000000000000',
  scopes: ['knowledge:search'],
};

describe('L1-B17-SEARCH-008 security boundaries', () => {
  it('L1-B17-SEARCH-008-Q03 rejects secret and internal object fields in Deep input/output contracts', () => {
    const request = {
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      knowledgeSpaceIds: ['65f1e5b2a1c9d4b7e8f01234'],
      query: 'refund policy',
      tokenBudget: 12_000,
      roundTokenBudget: 5_000,
    };
    expect(
      DeepSearchApiRequestSchema.safeParse({
        ...request,
        authorization: 'Bearer forbidden',
      }).success,
    ).toBe(false);
    expect(
      DeepSearchApiRequestSchema.safeParse({
        ...request,
        objectKey: 'knowledge-private/secret',
      }).success,
    ).toBe(false);
    expect(
      DeepSearchApiResponseSchema.safeParse({
        searchId: 'search_b17_security',
        mode: 'multi_space',
        items: [
          {
            segment: { objectKey: 'knowledge-private/secret' },
            score: 1,
            citation: {},
          },
        ],
        partial: false,
        durationMs: 1,
        rounds: [],
        stopReason: 'sufficient',
        usage: { inputTokens: 1, outputTokens: 1 },
      }).success,
    ).toBe(false);
  });

  it('L1-B17-SEARCH-008-Q03 redacts the provider credential from transport failures', async () => {
    const secret = 'sk-b17-provider-never-print';
    const transport: S5HttpTransportPort = {
      async request() {
        return {
          status: 401,
          headers: {},
          data: { error: { message: `echo ${secret}` } },
        };
      },
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
          kind: 'llm',
          modelId: 'qwen3.7-plus',
          messages: [{ role: 'user', content: 'planner' }],
          maxOutputTokens: 8,
        },
        context,
      );
      throw new Error('expected provider auth failure');
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(secret);
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
