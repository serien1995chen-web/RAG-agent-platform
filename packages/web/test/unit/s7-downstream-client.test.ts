import { describe, expect, it, vi } from 'vitest';
import {
  S7DownstreamKnowledgeClient,
  S7DownstreamKnowledgeError,
} from '../../src/client/s7-downstream-knowledge-client';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function success(
  status = 200,
  data: unknown = {
    searchId: 'search_test',
    mode: 'hybrid',
    items: [],
    partial: status === 207,
    durationMs: 1,
    degraded: status === 207 ? ['fulltext_recall_failed'] : [],
    rerankApplied: false,
  },
) {
  return {
    success: true,
    data,
    traceId: 'trace_test',
    requestId: 'request_test',
  };
}

describe('S7 downstream HTTP client contract', () => {
  it('uses only /v1/knowledge paths and required auth/workspace headers', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200, success()),
    );
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid/',
      workspaceId: 'ws-a',
      credential: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
      requestIdFactory: () => 'request-1234567890',
    });
    const result = await client.searchHybrid({
      knowledgeSpaceId: spaceId,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(result.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://knowledge.example.invalid/v1/knowledge/search/hybrid');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'x-workspace-id': 'ws-a',
      'x-request-id': 'request-1234567890',
    });
  });

  it('keeps 207 partial success and 200 empty as different typed results', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws-a',
      credential: 'secret-token',
      fetchImpl: async () => response(207, success(207)),
    });
    const partial = await client.searchMultiSpace({
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [spaceId],
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(partial.status).toBe(207);
    expect(partial.data.partial).toBe(true);
    expect(partial.data.items).toEqual([]);
  });

  it('throws a structured Problem for 401/403/429/504 without exposing credentials', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws-a',
      credential: 'never-log-this-token',
      fetchImpl: async () =>
        response(403, {
          success: false,
          error: {
            code: 'KNOWLEDGE_FORBIDDEN',
            message: 'forbidden',
            retryable: false,
            details: {},
          },
          traceId: 'trace-403',
          requestId: 'request-403',
        }),
    });
    await expect(
      client.searchSemantic({
        knowledgeSpaceId: spaceId,
        query: 'refund',
        tokenBudget: 5_000,
        searchMode: 'semantic',
      }),
    ).rejects.toMatchObject({
      status: 403,
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    try {
      await client.getCitation('bad');
    } catch (error) {
      expect(error).toBeInstanceOf(S7DownstreamKnowledgeError);
      expect(String(error)).not.toContain('never-log-this-token');
    }
  });
});
