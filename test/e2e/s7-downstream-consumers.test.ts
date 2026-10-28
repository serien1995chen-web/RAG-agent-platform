import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentSemanticConsumer,
  ChatHybridConsumer,
  WorkflowMultiConsumer,
} from './s7-consumer-fixtures';
import { S7DownstreamKnowledgeClient } from '../../packages/web/src/client/s7-downstream-knowledge-client';

const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';
const citationId = 'cit_00000000-0000-4000-8000-000000000001';

let server: Server;
let baseUrl = '';

function searchPayload(input: {
  mode: 'semantic' | 'hybrid' | 'multi_space';
  partial: boolean;
  degraded?: string[];
}) {
  return {
    success: true,
    data: {
      searchId: `search_${input.mode}`,
      mode: input.mode,
      items: [],
      partial: input.partial,
      durationMs: 1,
      degraded: input.degraded ?? [],
      rerankApplied: false,
    },
    traceId: 'trace_consumer',
    requestId: 'request_consumer',
  };
}

function problem(input: { code: string; requestId: string; retryable: boolean }) {
  return {
    success: false,
    error: {
      code: input.code,
      message: input.code,
      retryable: input.retryable,
      details: {},
    },
    traceId: `trace_${input.requestId}`,
    requestId: input.requestId,
  };
}

function client(requestId: string) {
  return new S7DownstreamKnowledgeClient({
    baseUrl,
    workspaceId: 'ws-consumer',
    credential: 'consumer-token',
    requestIdFactory: () => requestId,
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    const requestId = String(request.headers['x-request-id'] ?? 'request_consumer');
    const url = new URL(request.url ?? '/', baseUrl);
    const send = (status: number, payload: unknown) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    };
    if (url.pathname.endsWith('/search/multi-space')) {
      send(
        207,
        searchPayload({
          mode: 'multi_space',
          partial: true,
          degraded: [`space_${spaceB}_failed`],
        }),
      );
      return;
    }
    if (url.pathname.endsWith('/search/hybrid')) {
      send(
        200,
        searchPayload({
          mode: 'hybrid',
          partial: false,
          degraded: requestId === 'req-chat-degraded' ? ['rerank_failed'] : [],
        }),
      );
      return;
    }
    if (url.pathname.endsWith('/search/semantic')) {
      const statusByRequest: Record<number, string> = {
        400: 'KNOWLEDGE_VALIDATION_FAILED',
        401: 'KNOWLEDGE_AUTH_REQUIRED',
        403: 'KNOWLEDGE_FORBIDDEN',
        404: 'KNOWLEDGE_NOT_FOUND',
        429: 'KNOWLEDGE_RATE_LIMITED',
        504: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      };
      const requestedStatus = Number(requestId.split('-').at(-1));
      if (statusByRequest[requestedStatus]) {
        send(
          requestedStatus,
          problem({
            code: statusByRequest[requestedStatus]!,
            requestId,
            retryable: requestedStatus === 429 || requestedStatus === 504,
          }),
        );
        return;
      }
      send(200, searchPayload({ mode: 'semantic', partial: false }));
      return;
    }
    if (url.pathname.includes('/citations/')) {
      if (url.pathname.endsWith(citationId)) {
        send(200, {
          success: true,
          data: {
            citationId,
            segmentId: '65f1e5b2a1c9d4b7e8f20001',
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            title: 'Refund policy',
            sourceUrl: 'https://example.invalid/refund',
            segmentRange: { start: 0, end: 29 },
            score: 0.9,
            version: 1,
          },
          traceId: `trace_${requestId}`,
          requestId,
        });
        return;
      }
      send(
        404,
        problem({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId,
          retryable: false,
        }),
      );
      return;
    }
    send(404, problem({ code: 'KNOWLEDGE_NOT_FOUND', requestId, retryable: false }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('TEST-DOWN-001...003-BLOCK S7 real HTTP consumer matrix', () => {
  it('separates Chat empty/degraded, Agent semantic and Workflow 207 over HTTP', async () => {
    const empty = await new ChatHybridConsumer(client('req-chat-empty')).answerInput({
      knowledgeSpaceId: spaceA,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(empty.status).toBe(200);
    expect(empty.data).toMatchObject({ partial: false, degraded: [], items: [] });

    const degraded = await new ChatHybridConsumer(client('req-chat-degraded')).answerInput({
      knowledgeSpaceId: spaceA,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(degraded.data.degraded).toContain('rerank_failed');

    const semantic = await new AgentSemanticConsumer(client('req-agent-200')).tool({
      knowledgeSpaceId: spaceA,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'semantic',
    });
    expect(semantic.status).toBe(200);
    expect(semantic.data.mode).toBe('semantic');

    const workflow = await new WorkflowMultiConsumer(client('req-workflow-207')).knowledgeNode({
      knowledgeSpaceId: spaceA,
      knowledgeSpaceIds: [spaceA, spaceB],
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
    });
    expect(workflow.status).toBe(207);
    expect(workflow.data.partial).toBe(true);
  });

  it.each([
    [400, 'KNOWLEDGE_VALIDATION_FAILED'],
    [401, 'KNOWLEDGE_AUTH_REQUIRED'],
    [403, 'KNOWLEDGE_FORBIDDEN'],
    [404, 'KNOWLEDGE_NOT_FOUND'],
    [429, 'KNOWLEDGE_RATE_LIMITED'],
    [504, 'KNOWLEDGE_DEPENDENCY_TIMEOUT'],
  ] as const)('preserves real HTTP %s as a structured Problem', async (status, code) => {
    const consumer = new AgentSemanticConsumer(client(`req-agent-${status}`));
    await expect(
      consumer.tool({
        knowledgeSpaceId: spaceA,
        query: 'refund',
        tokenBudget: 5_000,
        searchMode: 'semantic',
      }),
    ).rejects.toMatchObject({
      status,
      problem: { error: { code } },
    });
  });

  it('distinguishes citation 200 and 404 over HTTP', async () => {
    const success = await new AgentSemanticConsumer(client('req-citation-200')).citation(
      citationId,
    );
    expect(success.status).toBe(200);
    expect(success.data.citationId).toBe(citationId);

    await expect(
      new AgentSemanticConsumer(client('req-citation-404')).citation(
        'cit_00000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toMatchObject({
      status: 404,
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });
});
