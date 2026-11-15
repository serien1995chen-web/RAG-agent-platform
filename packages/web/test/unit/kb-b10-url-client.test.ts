import { afterEach, describe, expect, it, vi } from 'vitest';

function sessionResponse() {
  return new Response(
    JSON.stringify({
      workspaceId: 'ws_b10_web',
      memberId: 'mem_b10_web',
      scopes: ['knowledge:read', 'knowledge:write'],
      isWorkspaceOwner: true,
      expiresIn: 60,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function jobResponse(jobId: string) {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        jobId,
        kind: 'import',
        resourceType: 'space',
        resourceId: 'space_b10_web',
        status: 'queued',
        steps: [],
        result: null,
        version: 1,
      },
      traceId: 'trace_b10_web',
      requestId: 'req_b10_web',
    }),
    { status: 202, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('L1-B10-ING-003-C04 UI URL client requests', () => {
  it('L1-B10-ING-003-C04 reuses a stable per-entry idempotency key on retry', async () => {
    const writes: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/console/session') return sessionResponse();
        writes.push({
          url,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return jobResponse(`job-${writes.length}`);
      }),
    );
    const { importUrl } = await import('../../src/product/api');

    await importUrl('space_b10_web', {
      idempotencyKey: 'b10-item-stable-key-0001',
      url: 'https://public.example.test/docs',
      selector: 'main',
    } as never);
    await importUrl('space_b10_web', {
      idempotencyKey: 'b10-item-stable-key-0001',
      url: 'https://public.example.test/docs',
      selector: 'main',
    } as never);

    expect(writes).toHaveLength(2);
    expect(writes[0]?.headers.get('Idempotency-Key')).toBe('b10-item-stable-key-0001');
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe('b10-item-stable-key-0001');
  });

  it('L1-B10-ING-003-UI03 isolates preview and submit idempotency for the same URL entry', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/console/session') return sessionResponse();
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push({ body, headers: new Headers(init?.headers) });
        if (body.dryRun) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                title: 'Preview',
                safeUrl: 'https://public.example.test/docs',
                selector: 'main',
                contentHash: 'a'.repeat(64),
                totalChunks: 1,
                chunks: [{ q: 'Selected body', a: '' }],
                truncated: false,
              },
              traceId: 'trace_b10_web',
              requestId: 'req_b10_web',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return jobResponse('job-b10-submit');
      }),
    );
    const { importUrl } = await import('../../src/product/api');

    const input = {
      idempotencyKey: 'b10-preview-stable-key-0001',
      url: 'https://public.example.test/docs',
      selector: 'main',
      chunking: {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 512,
      },
    } as const;

    await importUrl('space_b10_web', { ...input, dryRun: true });
    await importUrl('space_b10_web', { ...input, dryRun: false });
    await importUrl('space_b10_web', { ...input, dryRun: false });

    expect(requests).toHaveLength(3);
    expect(requests[0]?.body).toMatchObject({
      url: 'https://public.example.test/docs',
      selector: 'main',
      dryRun: true,
      chunking: {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 512,
      },
    });
    expect(requests[0]?.headers.get('Idempotency-Key')).toBe('b10-preview-stable-key-0001:preview');
    expect(requests[1]?.headers.get('Idempotency-Key')).toBe('b10-preview-stable-key-0001');
    expect(requests[2]?.headers.get('Idempotency-Key')).toBe('b10-preview-stable-key-0001');
    expect(requests.slice(1).map((request) => request.body.dryRun)).toEqual([false, false]);
  });
});
