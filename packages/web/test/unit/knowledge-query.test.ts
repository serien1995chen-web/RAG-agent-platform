import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeQueryClient } from '../../src/query/knowledge-query-client';
import { knowledgeQueryKeys } from '../../src/query/query-keys';

describe('knowledge query infrastructure', () => {
  it('builds stable keys from resource, parameters and cache version', () => {
    expect(knowledgeQueryKeys.jobs.list({ limit: 200, sort: 'updatedAt' })).toEqual(
      knowledgeQueryKeys.jobs.list({ sort: 'updatedAt', limit: 200 }),
    );
    expect(knowledgeQueryKeys.spaces.detail('space-a')).not.toEqual(
      knowledgeQueryKeys.spaces.detail('space-b'),
    );
    expect(knowledgeQueryKeys.spaces.list({ limit: 10 })).not.toEqual(
      knowledgeQueryKeys.spaces.list({ limit: 20 }),
    );
    expect(knowledgeQueryKeys.spaces.detail('space-a')).toContain('v1');
  });

  it('keeps new query keys isolated from older responses and invalidates only selected keys', async () => {
    const client = createKnowledgeQueryClient();
    const oldKey = knowledgeQueryKeys.spaces.detail('space-a');
    const newKey = knowledgeQueryKeys.spaces.detail('space-b');
    client.setQueryData(oldKey, { value: 'old' });
    client.setQueryData(newKey, { value: 'new' });

    expect(client.getQueryData(oldKey)).toEqual({ value: 'old' });
    expect(client.getQueryData(newKey)).toEqual({ value: 'new' });

    const oldQuery = client.getQueryCache().find({ queryKey: oldKey, exact: true });
    const newQuery = client.getQueryCache().find({ queryKey: newKey, exact: true });
    await client.invalidateQueries({ queryKey: oldKey, exact: true });
    expect(oldQuery?.state.isInvalidated).toBe(true);
    expect(newQuery?.state.isInvalidated).toBe(false);
  });

  it('sends Idempotency-Key only for writes and preserves a supplied key', async () => {
    vi.resetModules();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === '/api/console/session') {
          return new Response(
            JSON.stringify({
              workspaceId: 'workspace-a',
              memberId: 'member-a',
              scopes: ['knowledge:read'],
              isWorkspaceOwner: true,
              expiresIn: 60,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: { ok: true },
            traceId: 'trace-a',
            requestId: 'request-a',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { knowledgeRequest } = await import('../../src/client/knowledge-client');

    await knowledgeRequest('/v1/knowledge/spaces');
    await knowledgeRequest('/v1/knowledge/spaces', {
      method: 'POST',
      body: { name: 'Space' },
      idempotencyKey: 'idem-fixed',
    });

    const getHeaders = new Headers(requests[1]?.init?.headers);
    const writeHeaders = new Headers(requests[2]?.init?.headers);
    expect(getHeaders.get('Idempotency-Key')).toBeNull();
    expect(writeHeaders.get('Idempotency-Key')).toBe('idem-fixed');
    vi.unstubAllGlobals();
  });

  it('keeps all nine pages off the retired request hook and table', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const pages = [
      'spaces/index.tsx',
      'spaces/new.tsx',
      'spaces/[spaceId]/overview.tsx',
      'spaces/[spaceId]/sources.tsx',
      'spaces/[spaceId]/segments.tsx',
      'spaces/[spaceId]/tags.tsx',
      'spaces/[spaceId]/access.tsx',
      'spaces/[spaceId]/jobs.tsx',
      'system/status.tsx',
    ];
    for (const page of pages) {
      const source = readFileSync(resolve(repositoryRoot, 'projects/app/src/pages', page), 'utf8');
      expect(source, page).not.toContain('useKnowledgeRequest');
      expect(source, page).not.toMatch(/<DataTable\b/);
    }
  });
});
