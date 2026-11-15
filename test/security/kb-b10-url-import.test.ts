import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { extractHtmlDocument } from '../../packages/parse/src/parsers/html';
import { KnowledgeUrlImportAdapter } from '../../packages/service/src/modules/knowledge/adapter/url-import';
import {
  isForbiddenAddress,
  validateUrlSyntax,
  validateUrlTarget,
} from '../../packages/service/src/modules/knowledge/adapter/ssrf';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b10_security',
  memberId: 'mem_b10_security',
  requestId: 'req_b10_security',
  traceId: 'trace_b10_security',
  scopes: ['knowledge:write'],
};

function publicTarget(raw: string) {
  return {
    url: new URL(raw),
    address: '93.184.216.34',
    family: 4 as const,
    addresses: ['93.184.216.34'],
  };
}

describe('L1-B10-ING-003-Q URL import security', () => {
  it('L1-B10-ING-003-Q01 rejects the complete non-public address matrix', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it('L1-B10-ING-003-N01 rejects invalid schemes and URL userinfo before DNS', () => {
    for (const raw of [
      'file:///etc/passwd',
      'ftp://example.com/file',
      'http://user:secret@example.com/path',
    ]) {
      expect(() => validateUrlSyntax(raw, context), raw).toThrow();
    }
  });

  it('L1-B10-ING-003-Q02 fails closed for every mixed DNS answer set', async () => {
    await expect(
      validateUrlTarget('https://mixed.example.test', context, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('L1-B10-ING-003-F03/Q03 revalidates a redirect before the next hop request', async () => {
    const resolutions: string[] = [];
    let requests = 0;
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        resolutions.push(raw);
        return validateUrlTarget(raw, context, async (hostname) => {
          if (hostname === 'private.example.test') {
            return [{ address: '10.0.0.8', family: 4 }];
          }
          return [{ address: '93.184.216.34', family: 4 }];
        });
      },
      async requestPage() {
        requests += 1;
        return {
          status: 302,
          location: 'https://private.example.test/internal',
          contentType: 'text/html',
          bytes: new Uint8Array(),
        };
      },
    });

    await expect(
      adapter.fetch({ url: 'https://public.example.test/start', selector: 'body', context }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(resolutions).toHaveLength(2);
    expect(requests).toBe(1);
  });

  it('L1-B10-ING-003-F04/Q03 blocks DNS rebinding across a same-host redirect', async () => {
    let resolution = 0;
    let requests = 0;
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        resolution += 1;
        return validateUrlTarget(raw, context, async () => [
          resolution === 1
            ? { address: '93.184.216.34', family: 4 }
            : { address: '169.254.169.254', family: 4 },
        ]);
      },
      async requestPage() {
        requests += 1;
        return {
          status: 302,
          location: 'https://rebind.example.test/next',
          contentType: 'text/html',
          bytes: new Uint8Array(),
        };
      },
    });

    await expect(
      adapter.fetch({ url: 'https://rebind.example.test/start', selector: 'body', context }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(resolution).toBe(2);
    expect(requests).toBe(1);
  });

  it('L1-B10-ING-003-Q03 fails closed on missing Location and https-to-http downgrade', async () => {
    const missingLocation = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        return publicTarget(raw);
      },
      async requestPage() {
        return {
          status: 302,
          location: null,
          contentType: 'text/html',
          bytes: new Uint8Array(),
        };
      },
    });
    await expect(
      missingLocation.fetch({
        url: 'https://public.example.test/start',
        selector: 'body',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });

    const downgrade = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        return publicTarget(raw);
      },
      async requestPage(target) {
        if (target.url.protocol === 'https:') {
          return {
            status: 302,
            location: 'http://public.example.test/plain',
            contentType: 'text/html',
            bytes: new Uint8Array(),
          };
        }
        return {
          status: 200,
          location: null,
          contentType: 'text/html',
          bytes: Buffer.from('<html><title>downgraded</title><body>secret</body></html>'),
        };
      },
    });
    await expect(
      downgrade.fetch({ url: 'https://public.example.test/start', selector: 'body', context }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('L1-B10-ING-003-Q06 rejects unsupported MIME and empty HTML bodies', async () => {
    for (const response of [
      {
        contentType: 'application/octet-stream',
        bytes: Buffer.from([0, 1, 2, 3]),
      },
      {
        contentType: 'text/html',
        bytes: Buffer.from('<html><body><script>only()</script></body></html>'),
      },
    ]) {
      const adapter = new KnowledgeUrlImportAdapter({
        async resolve(raw) {
          return publicTarget(raw);
        },
        async requestPage() {
          return {
            status: 200,
            location: null,
            contentType: response.contentType,
            bytes: response.bytes,
          };
        },
      });
      await expect(
        adapter.fetch({
          url: 'https://public.example.test/content',
          selector: 'body',
          context,
        }),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
      });
    }
  });

  it('L1-B10-ING-003-Q05 strips credentials, query and fragment from the persisted URL', async () => {
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        return publicTarget(raw);
      },
      async requestPage() {
        return {
          status: 200,
          location: null,
          contentType: 'text/html; charset=utf-8',
          bytes: Buffer.from('<html><body><p>safe</p></body></html>'),
        };
      },
    });

    const snapshot = await adapter.fetch({
      url: 'https://public.example.test/docs?token=secret#fragment',
      selector: 'body',
      context,
    });
    expect(snapshot.safeUrl).toBe('https://public.example.test/docs');
    expect(snapshot.urlHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('L1-B10-ING-003-P03 follows the FastGPT title, h1 and URL fallback order', async () => {
    for (const scenario of [
      {
        html: '<html><head><title>Page title</title></head><body><h1>Heading</h1></body></html>',
        title: 'Page title',
      },
      {
        html: '<html><body><h1>Heading only</h1><p>Body</p></body></html>',
        title: 'Heading only',
      },
      {
        html: '<html><body><p>Body only</p></body></html>',
        title: 'https://public.example.test/docs',
      },
    ]) {
      const adapter = new KnowledgeUrlImportAdapter({
        async resolve(raw) {
          return publicTarget(raw);
        },
        async requestPage() {
          return {
            status: 200,
            location: null,
            contentType: 'text/html',
            bytes: Buffer.from(scenario.html),
          };
        },
      });
      await expect(
        adapter.fetch({
          url: 'https://public.example.test/docs',
          selector: 'body',
          context,
        }),
      ).resolves.toMatchObject({ title: scenario.title });
    }
  });

  it('L1-B10-ING-003-P06/Q04 requests one pinned page and never follows discovered links', async () => {
    const requests: Array<{ address: string; url: string }> = [];
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestPage(target) {
        requests.push({ address: target.address, url: target.url.toString() });
        return {
          status: 200,
          location: null,
          contentType: 'text/html',
          bytes: Buffer.from(
            '<html><body><main>single page <a href="/next-page">next</a></main></body></html>',
          ),
        };
      },
    });

    await adapter.fetch({
      url: 'https://public.example.test/start',
      selector: 'main',
      context,
    });
    expect(requests).toEqual([
      { address: '93.184.216.34', url: 'https://public.example.test/start' },
    ]);
  });

  it('L1-B10-ING-003-Q04 supports Node dual-form pinned lookup on a real socket', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><head><title>Pinned</title></head><body><main>Pinned body</main></body></html>',
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local port');
      const adapter = new KnowledgeUrlImportAdapter({
        async resolve(raw) {
          return {
            url: new URL(raw),
            address: '127.0.0.1',
            family: 4,
            addresses: ['127.0.0.1'],
          };
        },
        extractHtml: extractHtmlDocument,
      });
      const snapshot = await adapter.fetch({
        url: `http://pinned.example.test:${address.port}/`,
        selector: 'main',
        context,
      });
      expect(snapshot).toMatchObject({
        title: 'Pinned',
        selector: 'main',
        markdown: 'Pinned body',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('L1-B10-ING-003-Q06 rejects a real streamed response above 50 MiB', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(Buffer.alloc(50 * 1024 * 1024 + 1, 'x'));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing local port');
      const adapter = new KnowledgeUrlImportAdapter({
        async resolve(raw) {
          return {
            url: new URL(raw),
            address: '127.0.0.1',
            family: 4,
            addresses: ['127.0.0.1'],
          };
        },
        extractHtml: extractHtmlDocument,
      });
      await expect(
        adapter.fetch({
          url: `http://oversized.example.test:${address.port}/large`,
          selector: 'body',
          context,
        }),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
