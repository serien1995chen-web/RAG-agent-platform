import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CustomApiLibraryClient,
  createPinnedJsonRequester,
  type JsonRequester,
} from '../../packages/service/src/modules/knowledge/adapter/api-library';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s4_api_contract',
  memberId: 'mem_s4_api_contract',
  requestId: 'req_s4_api_contract',
  traceId: 'trace_s4_api_contract',
  scopes: ['knowledge:write'],
};

const config = {
  provider: 'custom_api',
  baseUrl: 'https://api.example.test',
  catalogPath: '/v1/file/list',
  detailPath: '/v1/file/detail',
  contentPath: '/v1/file/content',
  previewPath: '/v1/file/read',
  pageMode: 'cursor',
};

const credentials = {
  provider: 'custom_api',
  authMode: 'bearer',
  authorization: 'secret-token',
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('TEST-ING-006 and TEST-API-002 custom API contract', () => {
  it('TEST-ING-006-BLOCK/TEST-API-002-BLOCK uses fixed catalog/detail/content/preview DTOs', async () => {
    const calls: Array<{
      url: string;
      method: 'GET' | 'POST';
      body?: unknown;
      headers: Record<string, string>;
    }> = [];
    const requester: JsonRequester = async (url, input) => {
      calls.push({
        url,
        method: input.method,
        body: input.body,
        headers: input.headers,
      });
      if (url.endsWith('/v1/file/list')) {
        return {
          status: 200,
          body: {
            items: [{ id: 'file:1', name: 'Runbook', type: 'document' }],
            nextCursor: 'next',
          },
        };
      }
      if (url.includes('/v1/file/detail')) {
        return {
          status: 200,
          body: {
            name: 'Runbook',
            mimeType: 'text/markdown',
            sizeBytes: 9,
            updatedAt: '2026-10-27T00:00:00.000Z',
          },
        };
      }
      if (url.includes('/v1/file/content')) {
        return { status: 200, body: { content: '# Runbook' } };
      }
      return {
        status: 200,
        body: { mimeType: 'text/markdown', previewText: '# Runbook preview' },
      };
    };
    const client = new CustomApiLibraryClient(requester);

    await expect(
      client.catalog({
        config,
        credentials,
        parentId: 'root',
        cursor: 'cursor-1',
        context,
      }),
    ).resolves.toEqual({
      provider: 'custom',
      items: [{ id: 'file:1', name: 'Runbook', type: 'document' }],
      nextCursor: 'next',
    });
    const detail = await client.detail({
      config,
      credentials,
      fileIds: ['file:1'],
      context,
    });
    const content = await client.content({
      config,
      credentials,
      fileIds: ['file:1'],
      context,
    });
    const preview = await client.preview({
      config,
      credentials,
      fileIds: ['file:1'],
      context,
    });

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['POST', '/v1/file/list'],
      ['GET', '/v1/file/detail'],
      ['GET', '/v1/file/detail'],
      ['GET', '/v1/file/content'],
      ['GET', '/v1/file/read'],
    ]);
    expect(calls[0]?.body).toEqual({ parentId: 'root', cursor: 'cursor-1' });
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(new URL(calls[1]!.url).searchParams.get('fileId')).toBe('file:1');
    expect(new URL(calls[2]!.url).searchParams.get('fileId')).toBe('file:1');
    expect(new URL(calls[3]!.url).searchParams.get('fileId')).toBe('file:1');
    expect(new URL(calls[4]!.url).searchParams.get('fileId')).toBe('file:1');
    expect(detail).toEqual([
      {
        fileId: 'file:1',
        name: 'Runbook',
        mimeType: 'text/markdown',
        sizeBytes: 9,
        updatedAt: '2026-10-27T00:00:00.000Z',
      },
    ]);
    expect(content).toEqual([
      {
        externalId: 'file:1',
        title: 'Runbook',
        mimeType: 'text/markdown',
        bytes: Buffer.from('# Runbook'),
      },
    ]);
    expect(JSON.stringify(content)).not.toContain('objectKey');
    expect(JSON.stringify(content)).not.toContain('secret-token');
    expect(preview).toEqual([
      {
        fileId: 'file:1',
        mimeType: 'text/markdown',
        previewText: '# Runbook preview',
      },
    ]);
    expect(JSON.stringify(preview)).not.toContain('objectKey');

    const openapi = JSON.parse(
      readFileSync(
        join(process.cwd(), 'packages/contracts/openapi/knowledge-target.openapi.json'),
        'utf8',
      ),
    ) as {
      components: {
        schemas: Record<string, { $defs?: Record<string, unknown> }>;
      };
    };
    const api002 = openapi.components.schemas.ApiLibraryCatalog?.$defs;
    expect(Object.keys(api002 ?? {})).toEqual([
      'ApiLibraryFileDetail',
      'ApiLibraryFileContent',
      'ApiLibraryFilePreview',
    ]);
    expect(JSON.stringify(api002)).not.toContain('objectKey');
  });

  it('TEST-ING-006-BLOCK captures none/cursor/offset page modes', async () => {
    const bodies: unknown[] = [];
    const client = new CustomApiLibraryClient(async (_url, input) => {
      bodies.push(input.body);
      return { status: 200, body: { items: [] } };
    });
    for (const pageMode of ['none', 'cursor', 'offset'] as const) {
      await client.catalog({
        config: { ...config, pageMode },
        credentials,
        parentId: 'root',
        cursor: 'cursor-2',
        offset: 42,
        context,
      });
    }
    expect(bodies).toEqual([
      { parentId: 'root' },
      { parentId: 'root', cursor: 'cursor-2' },
      { parentId: 'root', offset: 42 },
    ]);
  });

  it('TEST-ING-006-U01/U02/U03 rejects free paths, invalid schemas and cursor conflicts', async () => {
    const client = new CustomApiLibraryClient(async (url) => {
      if (url.includes('/v1/file/list')) return { status: 409, body: {} };
      return { status: 200, body: { items: 'invalid' } };
    });
    await expect(
      client.catalog({
        config: { ...config, catalogPath: '/custom/list' },
        credentials,
        parentId: '',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID' } },
    });
    await expect(
      client.catalog({
        config,
        credentials,
        parentId: '',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CURSOR_INVALID' } },
    });

    const invalidSchema = new CustomApiLibraryClient(async () => ({
      status: 200,
      body: { items: 'invalid' },
    }));
    await expect(
      invalidSchema.catalog({
        config: { ...config, pageMode: 'none' },
        credentials,
        parentId: '',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });
  });

  it('TEST-ING-006-U04 rejects a private base URL before issuing a request', async () => {
    let requests = 0;
    const client = new CustomApiLibraryClient(
      createPinnedJsonRequester({
        async requestOnce() {
          requests += 1;
          return { status: 200, location: null, headers: {}, bytes: new Uint8Array() };
        },
      }),
    );
    await expect(
      client.catalog({
        config: { ...config, baseUrl: 'http://169.254.169.254' },
        credentials,
        parentId: '',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(requests).toBe(0);
  });

  it('TEST-ING-006 rejects empty content without materializing a DTO', async () => {
    const client = new CustomApiLibraryClient(async (url) => {
      if (url.includes('/v1/file/detail')) {
        return { status: 200, body: { name: 'Empty', mimeType: 'text/plain' } };
      }
      return { status: 200, body: { content: '   ' } };
    });
    await expect(
      client.content({
        config,
        credentials,
        fileIds: ['file:empty'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });
  });

  it('TEST-API-002-BLOCK rejects missing detail and preview fields', async () => {
    const detailClient = new CustomApiLibraryClient(async () => ({
      status: 200,
      body: { mimeType: 'text/plain' },
    }));
    await expect(
      detailClient.detail({
        config: { ...config, pageMode: 'none' },
        credentials,
        fileIds: ['file:missing-detail'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });

    const previewClient = new CustomApiLibraryClient(async () => ({
      status: 200,
      body: { mimeType: 'text/plain', previewText: '   ' },
    }));
    await expect(
      previewClient.preview({
        config: { ...config, pageMode: 'none' },
        credentials,
        fileIds: ['file:missing-preview'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });
  });
});

describe('TEST-X-SECURITY-URL custom API transport', () => {
  it('S4-R2-01 strips credentials on cross-origin redirect and rejects HTTPS downgrade', async () => {
    const seen: Array<{
      url: string;
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: unknown;
    }> = [];
    const requester = createPinnedJsonRequester({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestOnce(target, input) {
        seen.push({
          url: target.url.toString(),
          method: input.method,
          headers: input.headers,
          body: input.body,
        });
        if (target.url.hostname === 'api.example.test') {
          return {
            status: 302,
            location: 'https://cdn.example.test/file',
            headers: {},
            bytes: new Uint8Array(),
          };
        }
        return {
          status: 200,
          location: null,
          headers: {},
          bytes: Buffer.from(JSON.stringify({ ok: true })),
        };
      },
    });
    await expect(
      requester('https://api.example.test/start', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'x-api-key': 'secret-api-key',
          cookie: 'session=secret-cookie',
          'x-trace-id': 'trace-safe',
        },
        body: { parentId: 'root' },
        timeoutMs: 1_000,
        context,
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(seen[1]).toMatchObject({
      url: 'https://cdn.example.test/file',
      method: 'GET',
      headers: { 'x-trace-id': 'trace-safe' },
    });
    expect(seen[1]?.body).toBeUndefined();
    expect(JSON.stringify(seen[1])).not.toContain('secret-token');
    expect(JSON.stringify(seen[1])).not.toContain('secret-api-key');
    expect(JSON.stringify(seen[1])).not.toContain('secret-cookie');

    let downgradeRequests = 0;
    const downgrade = createPinnedJsonRequester({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestOnce() {
        downgradeRequests += 1;
        return {
          status: 302,
          location: 'http://api.example.test/insecure',
          headers: {},
          bytes: new Uint8Array(),
        };
      },
    });
    await expect(
      downgrade('https://api.example.test/start', {
        method: 'GET',
        headers: { authorization: 'Bearer secret-token' },
        timeoutMs: 1_000,
        context,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          details: { reason: 'https_downgrade' },
        },
      },
    });
    expect(downgradeRequests).toBe(1);
  });

  it('S4-R2-01 preserves credential and body only for same-origin 307 redirects', async () => {
    const seen: Array<{
      url: string;
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: unknown;
    }> = [];
    const requester = createPinnedJsonRequester({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestOnce(target, input) {
        seen.push({
          url: target.url.toString(),
          method: input.method,
          headers: input.headers,
          body: input.body,
        });
        if (target.url.pathname === '/start') {
          return {
            status: 307,
            location: '/next',
            headers: {},
            bytes: new Uint8Array(),
          };
        }
        return {
          status: 200,
          location: null,
          headers: {},
          bytes: Buffer.from(JSON.stringify({ ok: true })),
        };
      },
    });
    await requester('https://api.example.test/start', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: { parentId: 'root' },
      timeoutMs: 1_000,
      context,
    });
    expect(seen[1]).toMatchObject({
      url: 'https://api.example.test/next',
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: { parentId: 'root' },
    });
  });

  it('revalidates every redirect and blocks redirect-to-private before the second request', async () => {
    let requests = 0;
    let resolutions = 0;
    const requester = createPinnedJsonRequester({
      async resolve(raw) {
        resolutions += 1;
        const url = new URL(raw);
        if (url.hostname === 'private.example.test') {
          throw Object.assign(new Error('private'), {
            problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
          });
        }
        return {
          url,
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestOnce() {
        requests += 1;
        return {
          status: 302,
          location: 'https://private.example.test/metadata',
          headers: {},
          bytes: new Uint8Array(),
        };
      },
    });
    await expect(
      requester('https://public.example.test/start', {
        method: 'GET',
        headers: {},
        timeoutMs: 1_000,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(resolutions).toBe(2);
    expect(requests).toBe(1);
  });

  it('pins the vetted loopback address for the contract server', async () => {
    const { baseUrl } = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
    });
    const requester = createPinnedJsonRequester({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '127.0.0.1',
          family: 4,
          addresses: ['127.0.0.1'],
        };
      },
    });
    await expect(
      requester(`${baseUrl}/pinned`, {
        method: 'GET',
        headers: {},
        timeoutMs: 1_000,
        context,
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { path: '/pinned', host: expect.stringContaining('127.0.0.1') },
    });
  });

  it('TEST-ING-003-U05 returns 504 on timeout and 413 on streamed size overflow', async () => {
    const timeoutServer = await listen(() => undefined);
    const pinned = async (raw: string) => ({
      url: new URL(raw),
      address: '127.0.0.1' as const,
      family: 4 as const,
      addresses: ['127.0.0.1'],
    });
    const timeoutRequester = createPinnedJsonRequester({
      resolve: pinned,
    });
    await expect(
      timeoutRequester(`${timeoutServer.baseUrl}/slow`, {
        method: 'GET',
        headers: {},
        timeoutMs: 50,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });

    const oversizedServer = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('1234');
      response.end('5');
    });
    const sizeRequester = createPinnedJsonRequester({
      resolve: pinned,
    });
    await expect(
      sizeRequester(`${oversizedServer.baseUrl}/oversized`, {
        method: 'GET',
        headers: {},
        timeoutMs: 1_000,
        maxBytes: 4,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
    });
  });
});
