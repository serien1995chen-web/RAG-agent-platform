import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  it('TEST-ING-006-BLOCK uses fixed catalog/detail/content methods and safe DTOs', async () => {
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
        return { status: 200, body: { name: 'Runbook', mimeType: 'text/markdown' } };
      }
      return { status: 200, body: { content: '# Runbook' } };
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
    const content = await client.content({
      config,
      credentials,
      fileIds: ['file:1'],
      context,
    });

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['POST', '/v1/file/list'],
      ['GET', '/v1/file/detail'],
      ['GET', '/v1/file/content'],
    ]);
    expect(calls[0]?.body).toEqual({ parentId: 'root', cursor: 'cursor-1' });
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(new URL(calls[1]!.url).searchParams.get('fileId')).toBe('file:1');
    expect(new URL(calls[2]!.url).searchParams.get('fileId')).toBe('file:1');
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
});

describe('TEST-X-SECURITY-URL custom API transport', () => {
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
