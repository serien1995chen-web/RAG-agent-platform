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

// ---------------------------------------------------------------------------
// RK-03 字节级 IPv6 拦截 / RK-04 大小、字符集、取消
// ---------------------------------------------------------------------------

function bytesResponse(
  bytes: Uint8Array,
  contentType: string,
  contentLength?: string,
): LinkFetchResponse {
  return {
    status: 200,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength ?? null;
        return null;
      },
    },
    text: async () => Buffer.from(bytes).toString('utf8'),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

describe('TEST-LINK-SSRF-001 (RK-03) byte-level IPv6 embedded IPv4', () => {
  const cases = [
    'http://[::127.0.0.1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[::169.254.169.254]/',
  ];
  it('blocks IPv4-compatible/mapped, NAT64, 6to4 and metadata-embedded addresses with 501032 and no request', async () => {
    let fetched = 0;
    const p = provider(async () => {
      fetched += 1;
      return htmlResponse('x');
    });
    for (const url of cases) {
      expect(await code(() => p.read(request(url), context))).toBe(501032);
    }
    expect(fetched).toBe(0);
  });
});

describe('TEST-LINK-CHARSET-001 (RK-04) charset decode', () => {
  it('decodes GBK bytes using the Content-Type charset', async () => {
    const gbk = new Uint8Array([0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c, 0x2f, 0x70, 0x3e]);
    const p = provider(async () => bytesResponse(gbk, 'text/html; charset=gbk'));
    const result = await p.read(request('http://example.com/gbk'), context);
    expect(result.rawText).toContain('中文');
  });

  it('decodes UTF-16LE BOM bytes', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
    const p = provider(async () => bytesResponse(utf16, 'text/plain'));
    const result = await p.read(request('http://example.com/u16'), context);
    expect(result.rawText).toBe('中文');
  });

  it('HTML meta charset wins over a conflicting BOM (Plan v2 order)', async () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文 (GBK)
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('<meta charset="gbk"><p>', 'utf8'),
        gbk,
        Buffer.from('</p>', 'utf8'),
      ]),
    );
    const p = provider(async () => bytesResponse(bytes, 'text/html'));
    const result = await p.read(request('http://example.com/conflict'), context);
    expect(result.rawText).toContain('中文');
  });

  it('decodes UTF-8 BOM bytes', async () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')]);
    const p = provider(async () => bytesResponse(new Uint8Array(utf8), 'text/plain'));
    const result = await p.read(request('http://example.com/u8'), context);
    expect(result.rawText).toBe('中文');
  });
});

describe('TEST-LINK-LIMIT-001 (RK-04) size enforcement', () => {
  it('rejects over Content-Length without reading the body', async () => {
    let bodyRead = false;
    const response: LinkFetchResponse = {
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-length' ? '20000000' : 'text/html'),
      },
      text: async () => {
        bodyRead = true;
        return 'x';
      },
      arrayBuffer: async () => {
        bodyRead = true;
        return new Uint8Array([1]).buffer;
      },
    };
    const p = provider(async () => response);
    expect(await code(() => p.read(request('http://example.com/big'), context))).toBe(501065);
    expect(bodyRead).toBe(false);
  });

  it('rejects a stream that exceeds maxBytes while reading', async () => {
    const chunk = new Uint8Array(100);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response: LinkFetchResponse = {
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null),
      },
      text: async () => '',
      body: stream,
    };
    const p = createLinkSourceProvider({
      fetcher: async () => response,
      resolveHost: async () => ['93.184.216.34'],
      limits: { maxBytes: 150, retryBackoffMs: [] },
    });
    expect(await code(() => p.read(request('http://example.com/stream'), context))).toBe(501065);
  });
});

describe('TEST-LINK-CANCEL-001 (RK-04) caller cancellation', () => {
  it('passes an aborted caller signal to fetch and never logs a request body', async () => {
    const controller = new AbortController();
    controller.abort();
    let observedAborted = false;
    const audits: Array<Record<string, unknown>> = [];
    const p = createLinkSourceProvider({
      fetcher: async (_url, init) => {
        observedAborted = init.signal.aborted;
        const err = new Error('aborted') as Error & { name: string };
        err.name = 'AbortError';
        throw err;
      },
      resolveHost: async () => ['93.184.216.34'],
      signal: controller.signal,
      audit: (entry) => audits.push(entry as unknown as Record<string, unknown>),
      sleep: async () => {},
      limits: { retryBackoffMs: [0] },
    });
    expect(await code(() => p.read(request('http://example.com/cancel'), context))).toBe(501034);
    expect(observedAborted).toBe(true);
    for (const entry of audits) {
      expect(Object.keys(entry)).not.toContain('body');
      expect(Object.keys(entry)).not.toContain('query');
    }
  });
});
