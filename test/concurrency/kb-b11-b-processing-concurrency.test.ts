import { describe, expect, it } from 'vitest';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import type {
  S5GatewayResult,
  S5ModelGatewayPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b11-b-concurrency',
  memberId: 'member-b11-b-concurrency',
  requestId: 'req-b11-b-concurrency',
  traceId: 'trace-b11-b-concurrency',
  scopes: ['knowledge:write'],
};

describe('L1-B11-B PARSE-004 concurrent orchestration', () => {
  it('L1-B11-B-PARSE-004-C01 keeps concurrent source hashes, request usage and QA values isolated', async () => {
    const seenOperations: string[] = [];
    const gateway: S5ModelGatewayPort = {
      async invoke<T = unknown>(request): Promise<S5GatewayResult<T>> {
        seenOperations.push(request.operation ?? '');
        const suffix = request.operation?.slice(-1) ?? '0';
        return {
          data: {
            choices: [{ message: { content: `Q1: q-${suffix}\nA1: a-${suffix}` } }],
          } as T,
          actualModelId: request.modelId,
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
    const results = await Promise.all(
      ['0', '1'].map((suffix) =>
        adapter.generate({
          chunk: {
            index: Number(suffix),
            text: `source-${suffix}`,
            contentHash: `sha256:${suffix}`,
          },
          settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
          context: { ...context, requestId: `req-${suffix}`, traceId: `trace-${suffix}` },
          workspaceId: context.workspaceId,
          knowledgeSpaceId: 'space-b11-b-concurrency',
          sourceId: `source-${suffix}`,
        }),
      ),
    );
    expect(seenOperations.sort()).toEqual(['qa:sha256:0', 'qa:sha256:1']);
    expect(results.map((result) => result.items[0])).toEqual([
      { q: 'q-0', a: 'a-0', sourceChunkHash: 'sha256:0' },
      { q: 'q-1', a: 'a-1', sourceChunkHash: 'sha256:1' },
    ]);
  });
});
