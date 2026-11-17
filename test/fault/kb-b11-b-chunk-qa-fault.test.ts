import { describe, expect, it } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src/index';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import type { S5ModelGatewayPort } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-b11-b-fault',
  memberId: 'member-b11-b-fault',
  requestId: 'req-b11-b-fault',
  traceId: 'trace-b11-b-fault',
  scopes: ['knowledge:write'],
};

function adapter(error: unknown, calls: { count: number }) {
  const gateway: S5ModelGatewayPort = {
    async invoke() {
      calls.count += 1;
      throw error;
    },
  };
  return new S5QaPipelineAdapter({
    gateway,
    resolveModels: async () => ({ llmModelId: 'fake-llm' }),
  });
}

const input = {
  chunk: { index: 0, text: 'fault fixture', contentHash: 'sha256:fault' },
  settings: { trainingType: 'qa' as const, chunkSettingMode: 'auto' as const },
  context,
  workspaceId: context.workspaceId,
  knowledgeSpaceId: 'space-b11-b-fault',
  sourceId: 'source-b11-b-fault',
};

describe('L1-B11-B PARSE-004 fault classification', () => {
  it('L1-B11-B-PARSE-004-F01 preserves 401/403 as non-retryable model failures', async () => {
    const error = createKnowledgeError({
      code: 'KNOWLEDGE_MODEL_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      retryable: false,
      details: { upstreamStatus: 401 },
    });
    const calls = { count: 0 };
    await expect(adapter(error, calls).generate(input)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
    });
    expect(calls.count).toBe(1);
  });

  it('L1-B11-B-PARSE-004-F02 preserves rate-limit and timeout classification', async () => {
    const rate = createKnowledgeError({
      code: 'KNOWLEDGE_RATE_LIMITED',
      requestId: context.requestId,
      traceId: context.traceId,
      retryable: true,
      details: { upstreamStatus: 429 },
    });
    await expect(adapter(rate, { count: 0 }).generate(input)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_RATE_LIMITED', retryable: true } },
    });
    const timeout = createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      requestId: context.requestId,
      traceId: context.traceId,
      retryable: true,
      details: { reason: 'model_timeout' },
    });
    await expect(adapter(timeout, { count: 0 }).generate(input)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT', retryable: true } },
    });
  });
});
