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

  it('L1-B10-ING-003-UI03 sends dry-run preview with selector and chunking', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/console/session') return sessionResponse();
        requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
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
      }),
    );
    const { importUrl } = await import('../../src/product/api');

    await importUrl('space_b10_web', {
      idempotencyKey: 'b10-preview-stable-key-0001',
      url: 'https://public.example.test/docs',
      selector: 'main',
      dryRun: true,
      chunking: {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 512,
      },
    } as never);

    expect(requestBody).toMatchObject({
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
  });
});
