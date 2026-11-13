import { afterEach, describe, expect, it, vi } from 'vitest';

const UPLOAD_ID = '65f1e5b2a1c9d4b7e8f09abc';

function jsonResponse(data: unknown) {
  return new Response(
    JSON.stringify({ success: true, data, traceId: 'trace', requestId: 'request' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function sessionResponse() {
  return new Response(
    JSON.stringify({
      workspaceId: 'ws_b06a_unit',
      memberId: 'member',
      scopes: ['knowledge:write'],
      isWorkspaceOwner: false,
      expiresIn: 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function multipartSession(partCount: number) {
  return {
    uploadId: UPLOAD_ID,
    mode: 'multipart' as const,
    status: 'uploading' as const,
    partSizeBytes: 8 * 1024 * 1024,
    partCount,
    originalName: 'unit-large.txt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    version: 1,
    parts: [],
  };
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

afterEach(() => {
  globalThis.localStorage?.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('B06A upload client state', () => {
  it('L1-B06-FILE-001-UI01 上传中取消会调用 abort 并发布 aborted 状态', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const controller = new AbortController();
    const session = multipartSession(2);
    const abortBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/console/session') return sessionResponse();
      if (url === '/v1/knowledge/uploads') return jsonResponse(session);
      if (url === '/v1/knowledge/uploads/' + UPLOAD_ID) return jsonResponse(session);
      if (url.endsWith('/presign')) {
        controller.abort();
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
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }
      if (url.endsWith('/abort')) {
        abortBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ id: UPLOAD_ID, status: 'accepted', jobId: null });
      }
      throw new DOMException('unexpected request: ' + url, 'NotFoundError');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', memoryStorage());

    const phases: string[] = [];
    const size = 2 * 8 * 1024 * 1024 + 1;
    const file = new File([new Uint8Array(size)], 'unit-large.txt', { type: 'text/plain' });
    await expect(
      knowledgeMultipartUpload(file, {
        knowledgeSpaceId: 'space',
        signal: controller.signal,
        onState: (state) => phases.push(state.phase),
      }),
    ).rejects.toThrow(/abort/i);

    expect(phases).toContain('aborted');
    expect(abortBodies).toEqual([{ version: 1 }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/abort'))).toHaveLength(1);
  });

  it('L1-B06-FILE-001-UI01 同名同大小但内容变化会创建新会话而不是复用旧会话', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const session = multipartSession(1);
    const initCalls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/console/session') return sessionResponse();
      if (url === '/v1/knowledge/uploads') {
        initCalls.push(url);
        return jsonResponse(session);
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
        return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({
          blobId: UPLOAD_ID,
          workspaceId: 'ws_b06a_unit',
          bucket: 'kb-test',
          objectKey: 'ws/ws_b06a_unit/space/space/source/unbound/source/blob/unit.txt',
          state: 'active',
          sizeBytes: 9,
          etag: 'etag',
        });
      }
      throw new DOMException('unexpected request: ' + url, 'NotFoundError');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', memoryStorage());

    const first = new File(['first-version'], 'same.txt', {
      type: 'text/plain',
      lastModified: 1_700_000_000_000,
    });
    const second = new File(['other-version'], 'same.txt', {
      type: 'text/plain',
      lastModified: 1_700_000_000_000,
    });
    await knowledgeMultipartUpload(first, { knowledgeSpaceId: 'space' });
    await knowledgeMultipartUpload(second, { knowledgeSpaceId: 'space' });
    expect(initCalls).toHaveLength(2);
  });

  it('L1-B06-FILE-001-UI01 多分片进度单调递增并以 completed/100 结束', async () => {
    vi.resetModules();
    const { knowledgeMultipartUpload } = await import('../../src/client/file-upload');
    const session = multipartSession(3);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/console/session') return sessionResponse();
      if (url === '/v1/knowledge/uploads') return jsonResponse(session);
      if (url.endsWith('/presign')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { partNumbers?: number[] };
        const partNumber = body.partNumbers?.[0] ?? 1;
        return jsonResponse({
          uploads: [
            {
              partNumber,
              method: 'PUT',
              url: 'https://uploads.example.invalid/part-' + partNumber,
              headers: { 'Content-Type': 'text/plain' },
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          ],
        });
      }
      if (url.startsWith('https://uploads.example.invalid/part-')) {
        const partNumber = url.split('-').at(-1);
        return new Response(null, { status: 200, headers: { etag: '"etag-' + partNumber + '"' } });
      }
      if (url.endsWith('/complete')) {
        return jsonResponse({
          blobId: UPLOAD_ID,
          workspaceId: 'ws_b06a_unit',
          bucket: 'kb-test',
          objectKey: 'ws/ws_b06a_unit/space/space/source/unbound/source/blob/unit-large.txt',
          state: 'active',
          sizeBytes: 2 * 8 * 1024 * 1024 + 1,
          etag: 'etag-complete',
        });
      }
      throw new DOMException('unexpected request: ' + url, 'NotFoundError');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', memoryStorage());

    const progress: number[] = [];
    const phases: string[] = [];
    const size = 2 * 8 * 1024 * 1024 + 1;
    await knowledgeMultipartUpload(
      new File([new Uint8Array(size)], 'unit-large.txt', { type: 'text/plain' }),
      {
        knowledgeSpaceId: 'space',
        onState: (state) => {
          progress.push(state.progress);
          phases.push(state.phase);
        },
      },
    );
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]!);
    }
    expect(progress.at(-1)).toBe(100);
    expect(phases.at(-1)).toBe('completed');
  });
});
