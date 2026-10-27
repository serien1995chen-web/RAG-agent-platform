import { describe, expect, it, vi } from 'vitest';
import { S7DownstreamKnowledgeClient } from '../../packages/web/src/client/s7-downstream-knowledge-client';
import {
  AgentSemanticConsumer,
  ChatHybridConsumer,
  WorkflowMultiConsumer,
} from './s7-consumer-fixtures';

const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function searchPayload(_status = 200, partial = false) {
  return {
    success: true,
    data: {
      searchId: 'search_consumer',
      mode: partial ? 'multi_space' : 'hybrid',
      items: [],
      partial,
      durationMs: 1,
      degraded: partial ? ['space_65f1e5b2a1c9d4b7e8f01235_failed'] : [],
      rerankApplied: false,
    },
    traceId: 'trace_consumer',
    requestId: 'request_consumer',
  };
}

describe('TEST-DOWN-001...003-BLOCK S7 HTTP consumer fixtures', () => {
  it('keeps Chat rerank/empty, Agent Problem and Workflow 207 semantics distinct', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/search/hybrid')) return response(200, searchPayload());
      if (path.endsWith('/search/multi-space')) {
        return response(207, searchPayload(207, true));
      }
      return response(400, {
        success: false,
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          message: 'validation',
          retryable: false,
          details: {},
        },
        traceId: 'trace-consumer',
        requestId: 'request-consumer',
      });
    });
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws-consumer',
      credential: 'consumer-token',
      fetchImpl: fetchImpl as typeof fetch,
      requestIdFactory: () => 'request-consumer-123',
    });
    const chat = new ChatHybridConsumer(client);
    const agent = new AgentSemanticConsumer(client);
    const workflow = new WorkflowMultiConsumer(client);

    const chatResult = await chat.answerInput({
      knowledgeSpaceId: spaceA,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(chatResult.status).toBe(200);
    expect(chatResult.data.items).toEqual([]);

    const workflowResult = await workflow.knowledgeNode({
      knowledgeSpaceId: spaceA,
      knowledgeSpaceIds: [spaceA, spaceB],
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(workflowResult.status).toBe(207);
    expect(workflowResult.data.partial).toBe(true);

    await expect(
      agent.tool({
        knowledgeSpaceId: spaceA,
        query: 'refund',
        tokenBudget: 5_000,
        searchMode: 'semantic',
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });
});
