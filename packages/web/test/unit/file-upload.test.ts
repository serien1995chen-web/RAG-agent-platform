import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(data: unknown, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({
      success: true,
      data,
      traceId: 'trace',
      requestId: 'request',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    },
  );
}

function sessionResponse() {
  return new Response(
    JSON.stringify({
      workspaceId: 'ws_upload',
      memberId: 'member',
      scopes: ['knowledge:write'],
      isWorkspaceOwner: false,
      expiresIn: 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function createFetchMock(presignedStatus = 200) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/console/session') return sessionResponse();
    if (url === '/v1/knowledge/uploads') {
      return jsonResponse({
        uploadId: '65f1e5b2a1c9d4b7e8f09abc',
        mode: 'single',
        status: 'uploading',
        partSizeBytes: 8388608,
        partCount: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        version: 1,
      });
    }
    if (url.endsWith('/presign')) {
      return jsonResponse({
        uploads: [
          {
            partNumber: 1,
            method: 'PUT',
            url: 'https://uploads.example.invalid/part-1',
            headers: { 'Content-Type': 'text/plain' },
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      });
    }
    if (url === 'https://uploads.example.invalid/part-1') {
      return new Response(null, {
        status: presignedStatus,
        headers: presignedStatus === 200 ? { etag: '"etag-1"' } : {},
      });
    }
    if (url.endsWith('/parts/1')) {
      return jsonResponse({
        uploadId: '65f1e5b2a1c9d4b7e8f09abc',
        partNumber: 1,
        etag: 'etag-1',
      });
    }
    if (url.endsWith('/complete')) {
      return jsonResponse({
        blobId: '65f1e5b2a1c9d4b7e8f09abc',
        workspaceId: 'ws_upload',
        bucket: 'kb-test',
        objectKey: 'ws/ws_upload/space/space/source/unbound/source/blob/file.txt',
        state: 'active',
        sizeBytes: 5,
        etag: 'etag-1',
      });
    }
    if (url.endsWith('/abort')) {
      return jsonResponse({ id: '65f1e5b2a1c9d4b7e8f09abc', status: 'accepted', jobId: null });
    }
    throw new DOMException(`unexpected request: ${url}`, 'NotFoundError');
  });
}

function createMultipartFetchMock() {
  const session = {
    uploadId: '65f1e5b2a1c9d4b7e8f09abc',
    mode: 'multipart',
    status: 'uploading',
    partSizeBytes: 8 * 1024 * 1024,
    partCount: 3,
    originalName: 'large.txt',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    version: 1,
    parts: [],
  };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/console/session') return sessionResponse();
    if (url === '/v1/knowledge/uploads' || url === `/v1/knowledge/uploads/${session.uploadId}`) {
      return jsonResponse(session);
    }
    if (url.endsWith('/presign')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { partNumbers?: number[] };
      const partNumber = body.partNumbers?.[0] ?? 1;
      return jsonResponse({
        uploads: [
          {
            partNumber,
            method: 'PUT',
            url: `https://uploads.example.invalid/part-${partNumber}`,
            headers: { 'Content-Type': 'text/plain' },
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      });
    }
    if (url.startsWith('https://uploads.example.invalid/part-')) {
      const partNumber = url.split('-').at(-1);
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${partNumber}"` },
      });
    }
    if (url.endsWith('/complete')) {
      return jsonResponse({
        blobId: session.uploadId,
        workspaceId: 'ws_upload',
        bucket: 'kb-test',
        objectKey: 'ws/ws_upload/space/space/source/unbound/source/blob/large.txt',
        state: 'active',
        sizeBytes: 2 * 8 * 1024 * 1024 + 1,
        etag: 'etag-complete',
      });
    }
    throw new DOMException(`unexpected request: ${url}`, 'NotFoundError');
  });
}

afterEach(() => {
  globalThis.localStorage?.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('knowledge file upload client', () => {
  it('uses a single PUT for files up to 8 MiB and completes the same upload', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const states: string[] = [];
    const result = await knowledgeMultipartUpload(
      new File(['hello'], 'file.txt', { type: 'text/plain' }),
      {
        knowledgeSpaceId: 'space',
        onState: (state) => states.push(state.phase),
      },
    );
    expect(result.state).toBe('active');
    expect(states).toContain('completed');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(true);
  });

  it('falls back to the binary proxy when a presigned part fails', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const fetchMock = createFetchMock(403);
    vi.stubGlobal('fetch', fetchMock);
    const result = await knowledgeMultipartUpload(
      new File(['hello'], 'file.txt', { type: 'text/plain' }),
      { knowledgeSpaceId: 'space' },
    );
    expect(result.blobId).toBe('65f1e5b2a1c9d4b7e8f09abc');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/parts/1'))).toBe(true);
  });

  it('isolates idempotency keys per part and resumes only missing multipart parts', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload, restoreKnowledgeUpload } =
      await import('../../src/client/file-upload');
    const fetchMock = createMultipartFetchMock();
    const storage = new Map<string, string>();
    const writtenKeys: string[] = [];
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
        writtenKeys.push(key);
      },
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    const size = 2 * 8 * 1024 * 1024 + 1;
    const file = new File([new Uint8Array(size)], 'large.txt', { type: 'text/plain' });

    await knowledgeMultipartUpload(file, { knowledgeSpaceId: 'space' });
    expect(writtenKeys).toContain(`kb-upload:ws_upload:${file.name}:${file.size}`);
    expect(writtenKeys).not.toContain(`kb-upload:space:${file.name}:${file.size}`);
    const firstKeys = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/presign'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(firstKeys).toHaveLength(3);
    expect(new Set(firstKeys).size).toBe(3);

    fetchMock.mockClear();
    globalThis.localStorage.setItem(
      `kb-upload:ws_upload:${file.name}:${file.size}`,
      JSON.stringify({
        uploadId: '65f1e5b2a1c9d4b7e8f09abc',
        phase: 'uploading',
        progress: 66,
        parts: [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ],
      }),
    );
    const restored = await restoreKnowledgeUpload('ws_upload', file.name, file.size);
    expect(restored?.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    await knowledgeMultipartUpload(file, {
      knowledgeSpaceId: 'space',
      ...(restored ? { resumeSession: restored } : {}),
    });
    const resumedParts = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/presign'))
      .map(([url]) => String(url));
    expect(resumedParts).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/parts/1'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/parts/2'))).toBe(false);
  });

  it('aborts an already-cancelled upload and clears persisted state', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const fetchMock = createFetchMock();
    const storage = new Map<string, string>();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      knowledgeMultipartUpload(new File(['hello'], 'abort.txt', { type: 'text/plain' }), {
        knowledgeSpaceId: 'space',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/abort'))).toBe(true);
    expect(storage.size).toBe(0);
  });

  it('refreshes the session version before aborting after a proxied part', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const uploadId = '65f1e5b2a1c9d4b7e8f09abc';
    const baseSession = {
      uploadId,
      mode: 'multipart',
      status: 'uploading',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 3,
      originalName: 'abort-after-part.txt',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      version: 1,
      parts: [],
    };
    const controller = new AbortController();
    let abortBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === '/api/console/session') return sessionResponse();
        if (url === '/v1/knowledge/uploads') return jsonResponse(baseSession);
        if (url === `/v1/knowledge/uploads/${uploadId}`) {
          return jsonResponse({
            ...baseSession,
            version: 2,
            parts: [{ partNumber: 1, etag: 'etag-1' }],
          });
        }
        if (url.endsWith('/presign')) {
          return jsonResponse({
            uploads: [
              {
                partNumber: 1,
                method: 'PUT',
                url: 'https://uploads.example.invalid/part-1',
                headers: { 'Content-Type': 'text/plain' },
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            ],
          });
        }
        if (url === 'https://uploads.example.invalid/part-1') {
          return new Response(null, { status: 403 });
        }
        if (url.endsWith('/parts/1')) {
          return jsonResponse({ uploadId, partNumber: 1, etag: 'etag-1' });
        }
        if (url.endsWith('/abort')) {
          abortBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return jsonResponse({ id: uploadId, status: 'accepted', jobId: null });
        }
        throw new DOMException(`unexpected request: ${url}`, 'NotFoundError');
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const file = new File([new Uint8Array(2 * 8 * 1024 * 1024 + 1)], 'abort-after-part.txt', {
      type: 'text/plain',
    });
    await expect(
      knowledgeMultipartUpload(file, {
        knowledgeSpaceId: 'space',
        signal: controller.signal,
        onState(next) {
          if (next.completedParts === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortBody).toMatchObject({ version: 2 });
    const abortCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/abort'));
    expect((abortCall?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toContain(
      ':abort:2',
    );
  });
});
