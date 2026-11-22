import { describe, expect, it } from 'vitest';
import {
  S7DownstreamKnowledgeClient,
  S7DownstreamKnowledgeError,
  S7DownstreamNetworkError,
} from '../../packages/web/src/client/s7-downstream-knowledge-client';

const request = {
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  query: 'refund',
  tokenBudget: 5_000,
  searchMode: 'semantic' as const,
};

describe('B18-B downstream fault classification', () => {
  it('classifies an aborted dependency request as timeout without fabricating an empty result', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws_b18b_fault',
      credential: 'kn_live_fixture_not_a_real_secret',
      timeoutMs: 20,
      requestIdFactory: () => 'b18b-timeout',
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    });
    await expect(client.searchSemantic(request)).rejects.toMatchObject({
      name: 'S7DownstreamNetworkError',
      kind: 'timeout',
    });
  });

  it('preserves retryable 429 and 504 Problems', async () => {
    for (const status of [429, 504]) {
      const client = new S7DownstreamKnowledgeClient({
        baseUrl: 'https://knowledge.example.invalid',
        workspaceId: 'ws_b18b_fault',
        credential: 'kn_live_fixture_not_a_real_secret',
        requestIdFactory: () => `b18b-problem-${status}`,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: {
                code: status === 429 ? 'KNOWLEDGE_RATE_LIMITED' : 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
                message: status === 429 ? 'rate limited' : 'dependency timeout',
                retryable: true,
                details: {},
              },
              traceId: `trace-${status}`,
              requestId: `b18b-problem-${status}`,
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      });
      try {
        await client.searchSemantic(request);
        throw new Error('expected structured problem');
      } catch (error) {
        expect(error).toBeInstanceOf(S7DownstreamKnowledgeError);
        expect((error as S7DownstreamKnowledgeError).status).toBe(status);
        expect((error as S7DownstreamKnowledgeError).problem.error.retryable).toBe(true);
      }
    }
  });

  it('rejects malformed success envelopes instead of returning empty success', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws_b18b_fault',
      credential: 'kn_live_fixture_not_a_real_secret',
      requestIdFactory: () => 'b18b-malformed',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: null,
            traceId: 'trace',
            requestId: 'request',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(client.searchSemantic(request)).rejects.toBeInstanceOf(S7DownstreamNetworkError);
  });

  it('does not cache a prior successful request for a failed retry', async () => {
    let call = 0;
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws_b18b_fault',
      credential: 'kn_live_fixture_not_a_real_secret',
      requestIdFactory: () => `b18b-retry-${++call}`,
      fetchImpl: async () => {
        if (call === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                searchId: 'search_first',
                mode: 'semantic',
                items: [],
                partial: false,
                durationMs: 1,
                degraded: [],
                rerankApplied: false,
              },
              traceId: 'trace-first',
              requestId: 'b18b-retry-1',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
              message: 'timeout',
              retryable: true,
              details: {},
            },
            traceId: 'trace-second',
            requestId: 'b18b-retry-2',
          }),
          { status: 504, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await expect(client.searchSemantic(request)).resolves.toMatchObject({ status: 200 });
    await expect(client.searchSemantic(request)).rejects.toMatchObject({ status: 504 });
  });
});
