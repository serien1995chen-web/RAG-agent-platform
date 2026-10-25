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
    throw new DOMException(`unexpected request: ${url}`, 'NotFoundError');
  });
}

afterEach(() => {
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
});
