import { describe, expect, it, vi } from 'vitest';
import { S09SynonymClient } from '../../src/client/s09-synonym-client';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const config = {
  knowledgeSpaceId: spaceId,
  fileName: 'synonyms.csv',
  sizeBytes: 32,
  activeFileVersion: 1,
  enabled: true,
  schemaVersion: 2,
  status: 'rebuilding',
  mappingCount: 1,
  termCount: 2,
  version: 2,
  updatedAt: '2026-10-28T12:00:00.000Z',
  lastError: null,
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('S9 synonym client', () => {
  it('TEST-X-FRONTEND-A11Y sends workspace, FormData and Idempotency-Key', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return jsonResponse(config);
    }) as unknown as typeof fetch;
    const client = new S09SynonymClient({
      workspaceId: 'ws_fixture',
      fetchImpl,
      idempotencyKeyFactory: () => 'idempotency-key-0001',
    });
    const file = new File(['标准词,同义词\n退款,退货'], 'synonyms.csv', {
      type: 'text/csv',
    });
    await client.upload(spaceId, file, { enabled: true });
    const request = requests[0]!;
    expect(request.url).toBe(`/v1/knowledge/spaces/${spaceId}/synonyms/files`);
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      'X-Workspace-Id': 'ws_fixture',
      'Idempotency-Key': 'idempotency-key-0001',
    });
    const form = request.init.body as FormData;
    expect(form.get('enabled')).toBe('true');
    expect((form.get('file') as File).name).toBe('synonyms.csv');
  });

  it('TEST-X-FRONTEND-A11Y covers update, toggle, delete, rebuild, mappings and BOM download', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith('/synonyms/files/1')) {
        return new Response(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]), {
          status: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        });
      }
      if (String(url).includes('/mappings')) {
        return jsonResponse({
          items: [],
          nextCursor: 'cursor-2',
          hasMore: true,
          fileVersion: 1,
        });
      }
      if (String(url).includes('/rebuild')) {
        return jsonResponse({ jobId: 'job', status: 'queued' });
      }
      return jsonResponse(config);
    }) as unknown as typeof fetch;
    const client = new S09SynonymClient({
      workspaceId: 'ws_fixture',
      fetchImpl,
      idempotencyKeyFactory: () => 'idempotency-key-0002',
    });
    const file = new File(['x'], 'synonyms.xlsx');
    await client.update(spaceId, file, {
      enabled: true,
      expectedFileVersion: 1,
    });
    await client.toggle(spaceId, { enabled: false, version: 2 });
    await client.delete(spaceId, { version: 3 });
    await client.rebuild(spaceId, { version: 4 });
    await client.mappings(spaceId, { limit: 20, search: '退款' });
    const blob = await client.download(spaceId, 1);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(requests.map((request) => request.init.method)).toEqual([
      'PUT',
      'PATCH',
      'DELETE',
      'POST',
      'GET',
      'GET',
    ]);
    expect(String(requests[1]?.init.body)).toContain('"enabled":false');
    expect(requests[4]?.url).toContain('limit=20');
    expect(requests[4]?.url).toContain('search=');
  });
});
