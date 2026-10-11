import { ApiErrorException } from '../../packages/contracts/src/index';
import { describe, expect, it } from 'vitest';
import {
  createLinkSourceProvider,
  type LinkFetchResponse,
} from '../../packages/service/src/modules/collection/adapter/source-provider/link-provider';
import type { SourceReadRequest } from '../../packages/service/src/ports/capabilities';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-ssrf',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function request(url: string): SourceReadRequest {
  return { datasetId: 'ds-1', sourceType: 'link', sourceRef: url, options: { timeoutMs: 30000 } };
}

function htmlResponse(body: string, contentType = 'text/html'): LinkFetchResponse {
  return {
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => body,
  };
}

function provider(
  fetcher: (url: string) => Promise<LinkFetchResponse>,
  hosts: Record<string, string[]> = {},
) {
  return createLinkSourceProvider({
    fetcher: async (url) => fetcher(url),
    resolveHost: async (hostname) => hosts[hostname] ?? ['93.184.216.34'],
    sleep: async () => {},
    limits: { retryBackoffMs: [0, 0] },
  });
}

async function code(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (error) {
    if (error instanceof ApiErrorException) return error.error.code;
    throw error;
  }
}

describe('TEST-LINK-SSRF-001 protocol and address guards', () => {
  it('rejects non-http(s) protocols with 501031', async () => {
    const p = provider(async () => htmlResponse('x'));
    expect(await code(() => p.read(request('file:///etc/passwd'), context))).toBe(501031);
    expect(await code(() => p.read(request('ftp://example.com/x'), context))).toBe(501031);
  });

  it('rejects userinfo and non-whitelisted ports with 501031', async () => {
    const p = provider(async () => htmlResponse('x'));
    expect(await code(() => p.read(request('http://user:pass@example.com/'), context))).toBe(
      501031,
    );
    expect(await code(() => p.read(request('http://example.com:8080/'), context))).toBe(501031);
  });

  it('rejects an over-long URL with 501031', async () => {
    const p = provider(async () => htmlResponse('x'));
    expect(
      await code(() => p.read(request('http://example.com/' + 'a'.repeat(3000)), context)),
    ).toBe(501031);
  });

  it('blocks loopback/private/metadata addresses with 501032', async () => {
    const p = provider(async () => htmlResponse('x'));
    expect(await code(() => p.read(request('http://127.0.0.1/'), context))).toBe(501032);
    expect(await code(() => p.read(request('http://10.0.0.5/'), context))).toBe(501032);
    expect(
      await code(() => p.read(request('http://169.254.169.254/latest/meta-data'), context)),
    ).toBe(501032);
    expect(await code(() => p.read(request('http://metadata.google.internal/'), context))).toBe(
      501032,
    );
  });

  it('blocks decimal/hex/octal literal and IPv4-mapped IPv6 with 501032', async () => {
    const p = provider(async () => htmlResponse('x'));
    expect(await code(() => p.read(request('http://2130706433/'), context))).toBe(501032);
    expect(await code(() => p.read(request('http://0x7f000001/'), context))).toBe(501032);
    expect(await code(() => p.read(request('http://0177.0.0.1/'), context))).toBe(501032);
    expect(await code(() => p.read(request('http://[::ffff:127.0.0.1]/'), context))).toBe(501032);
  });

  it('blocks DNS rebinding when any resolved address is private (TEST-LINK-SSRF-001)', async () => {
    let fetched = 0;
    const p = provider(
      async () => {
        fetched += 1;
        return htmlResponse('x');
      },
      { 'rebind.example': ['93.184.216.34', '10.0.0.9'] },
    );
    expect(await code(() => p.read(request('http://rebind.example/'), context))).toBe(501032);
    expect(fetched).toBe(0);
  });

  it('rejects more than 5 redirects with 501033 and re-validates each hop', async () => {
    const p = provider(async (url) => {
      const n = Number(new URL(url).searchParams.get('n') ?? '0');
      return {
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location' ? 'http://example.com/?n=' + String(n + 1) : null,
        },
        text: async () => '',
      };
    });
    expect(await code(() => p.read(request('http://example.com/?n=0'), context))).toBe(501033);
  });

  it('blocks https to http downgrade with 501031', async () => {
    const p = provider(async () => ({
      status: 301,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'location' ? 'http://example.com/' : null),
      },
      text: async () => '',
    }));
    expect(await code(() => p.read(request('https://example.com/'), context))).toBe(501031);
  });

  it('blocks a redirect that targets a private address', async () => {
    const p = provider(
      async (url) => {
        if (url.includes('start')) {
          return {
            status: 302,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'location' ? 'http://internal.example/' : null,
            },
            text: async () => '',
          };
        }
        return htmlResponse('x');
      },
      { 'internal.example': ['192.168.1.10'] },
    );
    expect(await code(() => p.read(request('http://example.com/start'), context))).toBe(501032);
  });
});

describe('TEST-LINK-LIMIT-001 content-type and size', () => {
  it('rejects unsupported content type with 501035', async () => {
    const p = provider(async () => htmlResponse('x', 'application/octet-stream'));
    expect(await code(() => p.read(request('http://example.com/a.bin'), context))).toBe(501035);
  });

  it('rejects content over the size limit with 501065', async () => {
    const p = provider(async () => htmlResponse('<p>' + '字'.repeat(20) + '</p>'), {});
    const small = createLinkSourceProvider({
      fetcher: async () => htmlResponse('<p>' + '字'.repeat(100) + '</p>'),
      resolveHost: async () => ['93.184.216.34'],
      limits: { maxBytes: 50, retryBackoffMs: [] },
    });
    expect(await code(() => small.read(request('http://example.com/big'), context))).toBe(501065);
    expect(await code(() => p.read(request('http://example.com/ok'), context))).toBe(0);
  });
});

describe('TEST-LINK-CHARSET-001 and TEST-LINK-EMPTY-001', () => {
  it('converts HTML to markdown preserving headings and links', async () => {
    const p = provider(async () =>
      htmlResponse(
        '<html><body><nav>menu</nav><h1>标题</h1><p>正文内容，链接到 <a href="/x">这里</a>。</p></body></html>',
      ),
    );
    const result = await p.read(request('http://example.com/a'), context);
    expect(result.rawText).toContain('# 标题');
    expect(result.rawText).not.toContain('menu');
    expect(result.rawText).toContain('(http://example.com/x)');
  });

  it('rejects an empty body with 501036', async () => {
    const p = provider(async () => htmlResponse('<html><body><script>x()</script></body></html>'));
    expect(await code(() => p.read(request('http://example.com/empty'), context))).toBe(501036);
  });

  it('rejects a JS-only dynamic page below 5% static text with 501036', async () => {
    const heavy = '<script>' + 'var a=1;'.repeat(400) + '</script><p>hi</p>';
    const p = provider(async () => htmlResponse(heavy));
    expect(await code(() => p.read(request('http://example.com/spa'), context))).toBe(501036);
  });
});

describe('TEST-LINK-CANCEL-001 and retry classification', () => {
  it('maps repeated 5xx to 501034 after bounded retries', async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      return {
        status: 503,
        headers: { get: () => null },
        text: async () => '',
      };
    });
    expect(await code(() => p.read(request('http://example.com/down'), context))).toBe(501034);
    expect(calls).toBeGreaterThan(1);
  });

  it('does not retry 4xx and records 501039', async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      return { status: 404, headers: { get: () => null }, text: async () => '' };
    });
    expect(await code(() => p.read(request('http://example.com/missing'), context))).toBe(501039);
    expect(calls).toBe(1);
  });
});
