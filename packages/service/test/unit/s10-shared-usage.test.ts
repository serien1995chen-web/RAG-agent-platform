import { describe, expect, it, vi } from 'vitest';
import { KnowledgeSharedUsageAdapter } from '../../src/modules/knowledge/adapter/s10-shared-usage.adapter';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_usage_delivery',
  memberId: 'member_usage_delivery',
  requestId: 'request_usage_delivery',
  traceId: 'trace_usage_delivery',
  scopes: ['knowledge:admin'],
};

function adapter(fetchImpl: typeof fetch) {
  return new KnowledgeSharedUsageAdapter(
    {
      ingestUrl: 'https://usage.example.test/events',
      token: 'usage-service-token',
      profileVersion: 'free-v1',
      timeoutMs: 20,
      fetch: fetchImpl,
    },
    {
      async summary() {
        throw new Error('not used');
      },
    },
  );
}

describe('S10 shared usage delivery', () => {
  it('posts the immutable usage event with the workspace identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await adapter(fetchImpl as typeof fetch).deliverUsage(
      { eventId: 'event-1', payload: { pointsMicros: 1200, pricingVersion: 'fixture-v1' } },
      context,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://usage.example.test/events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-workspace-id': context.workspaceId,
          'x-request-id': context.requestId,
        }),
        body: JSON.stringify({
          eventId: 'event-1',
          fact: { pointsMicros: 1200, pricingVersion: 'fixture-v1' },
        }),
      }),
    );
  });

  it('returns dependency errors instead of silently accepting delivery failure', async () => {
    await expect(
      adapter((async () => new Response(null, { status: 503 })) as typeof fetch).deliverUsage(
        { eventId: 'event-2', payload: { pointsMicros: 1 } },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          details: { dependency: 'shared_usage', reason: 'ingest_status' },
        },
      },
    });
  });

  it('maps an aborted ingest request to a dependency timeout', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await expect(
      adapter(fetchImpl as typeof fetch).deliverUsage(
        { eventId: 'event-3', payload: { pointsMicros: 1 } },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          details: { dependency: 'shared_usage', reason: 'ingest' },
        },
      },
    });
  });
});
