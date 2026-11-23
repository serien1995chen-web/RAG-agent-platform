import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S5OcrHttpAdapter } from '../../src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrApplication } from '../../src/modules/knowledge/application/s5-ocr.application';
import {
  S5OcrProviderError,
  type OcrCredentialProfilePort,
  type OcrProviderPort,
  type S5OcrHttpRequest,
  type S5OcrHttpResponse,
  type S5OcrHttpTransportPort,
  type S5OcrProviderConfig,
  type S5ProviderUsageFact,
  type S5ProviderUsageRecorderPort,
} from '../../src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b11_ocr_contract',
  memberId: 'mem_b11_ocr_contract',
  requestId: 'req-b11-ocr-contract',
  traceId: 'trace-b11-ocr-contract',
  scopes: ['knowledge:read', 'knowledge:write'],
};

const profiles: OcrCredentialProfilePort = {
  async resolve(_profileId, provider) {
    return {
      endpoint: 'https://ocr.example.invalid/api',
      credentials: {
        token: `token-${provider}`,
        apiKey: `key-${provider}`,
        appId: 'app-b11',
        secretCode: 'secret-b11',
      },
    };
  },
};

function config(
  provider: S5OcrProviderConfig['provider'],
  overrides: Partial<S5OcrProviderConfig> = {},
): S5OcrProviderConfig {
  const common = {
    credentialProfileId: 'env:B11_OCR_PROFILE',
    timeoutMs: 10_000,
    fallbackProvider: 'none' as const,
    imageHandling: 'drop' as const,
  };
  if (provider === 'sangfor') {
    return {
      ...common,
      provider,
      keepHeaderFooter: false,
      keepAppendix: true,
      imageAnalysis: false,
      chartAnalysis: false,
      ...overrides,
    } as S5OcrProviderConfig;
  }
  if (provider === 'textin') {
    return {
      ...common,
      provider,
      removeWatermark: true,
      parseMode: 'auto',
      ...overrides,
    } as S5OcrProviderConfig;
  }
  if (provider === 'doc2x') {
    return {
      ...common,
      provider,
      pollIntervalMs: 1,
      ...overrides,
    } as S5OcrProviderConfig;
  }
  return { ...common, provider, ...overrides } as S5OcrProviderConfig;
}

function request(
  provider: S5OcrProviderConfig['provider'],
  overrides: Record<string, unknown> = {},
) {
  return {
    workspaceId: context.workspaceId,
    sourceId: '65f1e5b2a1c9d4b7e8f10001',
    sourceVersion: 1,
    bytes: Buffer.from('%PDF-1.4 B11 OCR fixture'),
    fileName: 'b11-ocr.pdf',
    mimeType: 'application/pdf',
    config: config(provider),
    timeoutMs: 10_000,
    requestId: 'req-b11-provider',
    traceId: 'trace-b11-provider',
    ...overrides,
  };
}

function page(markdown: string, pageNumber = 1) {
  return { pageNumber, markdown };
}

class Facts implements S5ProviderUsageRecorderPort {
  readonly values: S5ProviderUsageFact[] = [];

  async recordProviderUsage(fact: S5ProviderUsageFact): Promise<boolean> {
    this.values.push(fact);
    return true;
  }
}

function application(
  provider: OcrProviderPort,
  options: {
    fallback?: boolean;
    usage?: Facts;
    remoteFetches?: { count: number };
    writes?: { count: number };
  } = {},
) {
  const usage = options.usage ?? new Facts();
  return new S5OcrApplication({
    provider,
    usage,
    remoteAssets: {
      async fetch(url) {
        if (options.remoteFetches) options.remoteFetches.count += 1;
        return {
          bytes: Buffer.from(`image:${url}`),
          mimeType: 'image/png',
          sha256: createHash('sha256').update(url).digest('hex'),
        };
      },
    },
    assetSink: {
      async putImage() {
        if (options.writes) options.writes.count += 1;
        return { objectRefId: 'b11-object-ref', markdownUrl: 'object://b11-object-ref' };
      },
    },
    sourceGuard: { async assertSource() {} },
    sleep: async () => undefined,
    ...(options.fallback
      ? {
          fallbackPdf: async () => ({
            markdown: 'LiteParse fallback',
            pages: [{ pageNumber: 1, text: 'LiteParse fallback', assets: [] }],
            assets: [],
            diagnostics: [],
          }),
        }
      : {}),
  });
}

describe('L1-B11-A PARSE-002 provider request contract', () => {
  it('L1-B11-A-PARSE-002-P01 sends provider-specific authentication and consumes page markdown', async () => {
    const calls: S5OcrHttpRequest[] = [];
    const transport: S5OcrHttpTransportPort = {
      async request<T>(input): Promise<S5OcrHttpResponse<T>> {
        calls.push(input);
        const url = new URL(input.url);
        if (url.pathname.endsWith('/v2/parse/preupload')) {
          return {
            status: 200,
            headers: {},
            data: {
              uploadUrl: 'https://upload.example.invalid/put',
              statusUrl: 'https://upload.example.invalid/status',
            },
          } as S5OcrHttpResponse<T>;
        }
        if (url.hostname === 'upload.example.invalid' && input.method === 'PUT') {
          return { status: 200, headers: {}, data: {} } as S5OcrHttpResponse<T>;
        }
        if (url.hostname === 'upload.example.invalid') {
          return {
            status: 200,
            headers: {},
            data: {
              status: 'success',
              markdown: 'Doc2x page',
              pages: [page('Doc2x page')],
            },
          } as S5OcrHttpResponse<T>;
        }
        if (url.pathname.endsWith('/parse/sync')) {
          return {
            status: 200,
            headers: {},
            data: {
              code: 0,
              markdown: 'SomArk page',
              pages: [{ pageNum: 1, markdown: 'SomArk page' }],
            },
          } as S5OcrHttpResponse<T>;
        }
        return {
          status: 200,
          headers: {},
          data: {
            code: 200,
            markdown: 'TextIn page',
            pages: [{ pageNumber: 1, markdown: 'TextIn page' }],
          },
        } as S5OcrHttpResponse<T>;
      },
    };
    const adapter = new S5OcrHttpAdapter({ profiles, transport, sleep: async () => undefined });

    for (const provider of ['somark', 'textin', 'doc2x'] as const) {
      const result = await adapter.parse(request(provider), context);
      expect(result.pages).toHaveLength(1);
      expect(result.markdown).toMatch(/page/i);
      expect(result.usage).toContainEqual(
        expect.objectContaining({ provider, unit: 'page', quantity: 1, status: 200 }),
      );
      expect(JSON.stringify(result.requestEvidence)).not.toMatch(
        /secret-b11|key-|token-|authorization/i,
      );
    }

    const somark = calls.find((call) => call.url.endsWith('/parse/sync'));
    expect(somark?.body).toBeInstanceOf(FormData);
    const textin = calls.find((call) => call.url.includes('/pdf_to_markdown'));
    expect(textin?.headers['x-ti-app-id']).toBe('app-b11');
    expect(textin?.headers['x-ti-secret-code']).toBe('secret-b11');
    const doc2x = calls.find((call) => call.url.endsWith('/v2/parse/preupload'));
    expect(doc2x?.headers.Authorization).toBe('Bearer key-doc2x');
  });

  it('L1-B11-A-PARSE-002-P01 preserves SomArk total page count without page payloads', async () => {
    const adapter = new S5OcrHttpAdapter({
      profiles,
      transport: {
        async request<T>() {
          return {
            status: 200,
            headers: {},
            data: {
              code: 0,
              data: {
                result: { outputs: { markdown: 'SomArk combined markdown' } },
                metadata: { page_num: 2 },
              },
            },
          } as S5OcrHttpResponse<T>;
        },
      },
    });
    const result = await adapter.parse(request('somark'), context);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0]?.text).toBe('SomArk combined markdown');
    expect(result.pages[1]?.text).toBe('');
    expect(result.usage).toContainEqual(
      expect.objectContaining({ provider: 'somark', unit: 'page', quantity: 2 }),
    );
  });

  it('L1-B11-A-PARSE-002-N01 classifies 401, 403, 402, 429 and 503 without converting them to success', async () => {
    const cases = [
      [401, 'auth', false],
      [403, 'auth', false],
      [402, 'quota', false],
      [429, 'rate_limit', true],
      [503, 'provider', true],
    ] as const;
    for (const [status, kind, retryable] of cases) {
      const adapter = new S5OcrHttpAdapter({
        profiles,
        transport: {
          async request<T>() {
            return { status, headers: {}, data: { code: status } } as S5OcrHttpResponse<T>;
          },
        },
      });
      const error = await adapter.parse(request('somark'), context).catch((caught) => caught);
      expect(error).toMatchObject({ name: 'S5OcrProviderError', kind, status, retryable });
    }
  });

  it('L1-B11-A-PARSE-002-N02 rejects invalid JSON, missing markdown and invalid pages as contract failures', async () => {
    const responses = [
      { code: 0, data: { malformed: true } },
      { code: 0, markdown: '', pages: [page('x')] },
      { code: 0, markdown: 'text', pages: [{ pageNumber: 0, markdown: 'text' }] },
      {
        code: 0,
        data: {
          result: { outputs: { markdown: 'text' } },
          metadata: { page_num: 0 },
        },
      },
    ];
    for (const data of responses) {
      const adapter = new S5OcrHttpAdapter({
        profiles,
        transport: {
          async request<T>() {
            return { status: 200, headers: {}, data } as S5OcrHttpResponse<T>;
          },
        },
      });
      const error = await adapter.parse(request('somark'), context).catch((caught) => caught);
      expect(error).toMatchObject({
        name: 'S5OcrProviderError',
        kind: 'contract',
        schemaRetryable: true,
      });
    }
  });

  it('L1-B11-A-PARSE-002-N03 honors TextIn parse mode and watermark options', async () => {
    let captured: S5OcrHttpRequest | undefined;
    const adapter = new S5OcrHttpAdapter({
      profiles,
      transport: {
        async request<T>(input) {
          captured = input;
          return {
            status: 200,
            headers: {},
            data: { code: 200, markdown: 'scan', pages: [page('scan')] },
          } as S5OcrHttpResponse<T>;
        },
      },
    });
    await adapter.parse(
      request('textin', {
        config: config('textin', {
          removeWatermark: false,
          parseMode: 'scan',
        }),
      }),
      context,
    );
    const query = new URL(captured!.url).searchParams;
    expect(query.get('parse_mode')).toBe('scan');
    expect(query.get('remove_watermark')).toBe('0');
  });

  it('L1-B11-A-PARSE-002-N04 rejects an oversized provider page count before usage accounting', async () => {
    const adapter = new S5OcrHttpAdapter({
      profiles,
      transport: {
        async request<T>() {
          return {
            status: 200,
            headers: {},
            data: {
              code: 0,
              data: {
                result: { outputs: { markdown: 'oversized' } },
                metadata: { page_num: 1_000_000_000 },
              },
            },
          } as S5OcrHttpResponse<T>;
        },
      },
    });
    const error = await adapter.parse(request('somark'), context).catch((caught) => caught);
    expect(error).toMatchObject({
      name: 'S5OcrProviderError',
      kind: 'contract',
    });
  });
});

describe('L1-B11-A PARSE-002 application retry and fallback', () => {
  it('L1-B11-A-PARSE-002-F01 does not retry or fallback after authentication failure', async () => {
    let calls = 0;
    let fallbackCalls = 0;
    const app = new S5OcrApplication({
      provider: {
        async parse() {
          calls += 1;
          throw new S5OcrProviderError('auth', 401, [], false, false);
        },
      },
      usage: new Facts(),
      remoteAssets: {
        async fetch() {
          throw new Error('unused');
        },
      },
      assetSink: {
        async putImage() {
          throw new Error('unused');
        },
      },
      sourceGuard: { async assertSource() {} },
      fallbackPdf: async () => {
        fallbackCalls += 1;
        return {
          markdown: 'fallback',
          pages: [{ pageNumber: 1, text: 'fallback', assets: [] }],
          assets: [],
          diagnostics: [],
        };
      },
      sleep: async () => undefined,
    });
    await expect(
      app.parse({
        ...request('somark', {
          knowledgeSpaceId: 'space-b11',
          context,
          config: config('somark', { fallbackProvider: 'liteparse' }),
        }),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
    });
    expect(calls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  it('L1-B11-A-PARSE-002-F02 bounds 429/5xx/timeout at three attempts and then falls back only for PDF', async () => {
    for (const failure of [
      new S5OcrProviderError('rate_limit', 429, [], true, false),
      new S5OcrProviderError('provider', 503, [], true, false),
      new S5OcrProviderError('timeout', null, [], true, false),
    ]) {
      let calls = 0;
      const usage = new Facts();
      const app = application(
        {
          async parse() {
            calls += 1;
            throw failure;
          },
        },
        { usage, fallback: true },
      );
      const result = await app.parse({
        ...request('somark', {
          knowledgeSpaceId: 'space-b11',
          context,
          config: config('somark', { fallbackProvider: 'liteparse' }),
        }),
      });
      expect(calls).toBe(3);
      expect(result.fallbackUsed).toBe(true);
      expect(result.actualProvider).toBe('liteparse');
      expect(usage.values.filter((fact) => fact.provider === 'liteparse')).toHaveLength(1);
    }
  });

  it('L1-B11-A-PARSE-002-F03 retries invalid provider schema exactly once', async () => {
    let calls = 0;
    const app = application({
      async parse() {
        calls += 1;
        if (calls === 1) {
          throw new S5OcrProviderError('contract', 200, [], false, true);
        }
        return {
          markdown: 'repaired',
          pages: [{ pageNumber: 1, text: 'repaired', assets: [] }],
          assets: [],
          diagnostics: [],
          usage: [{ provider: 'somark', unit: 'page', quantity: 1, status: 200 }],
          requestEvidence: { provider: 'somark' },
        };
      },
    });
    const result = await app.parse({
      ...request('somark', {
        knowledgeSpaceId: 'space-b11',
        context,
      }),
    });
    expect(calls).toBe(2);
    expect(result.markdown).toBe('repaired');
  });

  it('L1-B11-A-PARSE-002-F04 never applies LiteParse fallback to a non-PDF input', async () => {
    const app = application(
      {
        async parse() {
          throw new S5OcrProviderError('timeout', null, [], true, false);
        },
      },
      { fallback: true },
    );
    await expect(
      app.parse({
        ...request('somark', {
          knowledgeSpaceId: 'space-b11',
          context,
          fileName: 'b11.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          config: config('somark', { fallbackProvider: 'liteparse' }),
        }),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });
});

describe('L1-B11-A PARSE-002 image handling', () => {
  it('L1-B11-A-PARSE-002-P02 uploads, keeps or drops images according to the configured mode', async () => {
    for (const mode of ['upload_to_storage', 'keep_url', 'drop'] as const) {
      const remoteFetches = { count: 0 };
      const writes = { count: 0 };
      const app = application(
        {
          async parse() {
            const markdown = 'before ![scan](https://cdn.example.invalid/scan.png) after';
            return {
              markdown,
              pages: [{ pageNumber: 1, text: markdown, assets: [] }],
              assets: [],
              diagnostics: [],
              usage: [{ provider: 'somark', unit: 'page', quantity: 1, status: 200 }],
              requestEvidence: { provider: 'somark' },
            };
          },
        },
        { remoteFetches, writes },
      );
      const result = await app.parse({
        ...request('somark', {
          knowledgeSpaceId: 'space-b11',
          context,
          config: config('somark', { imageHandling: mode }),
        }),
      });
      if (mode === 'upload_to_storage') {
        expect(remoteFetches.count).toBe(1);
        expect(writes.count).toBe(1);
        expect(result.markdown).toContain('object://b11-object-ref');
        expect(result.assets[0]?.objectRefId).toBe('b11-object-ref');
      } else if (mode === 'keep_url') {
        expect(remoteFetches.count).toBe(0);
        expect(writes.count).toBe(0);
        expect(result.markdown).toContain('https://cdn.example.invalid/scan.png');
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'ocr_image_url_kept_unverified' }),
        );
      } else {
        expect(remoteFetches.count).toBe(0);
        expect(writes.count).toBe(0);
        expect(result.markdown).not.toContain('https://cdn.example.invalid');
      }
    }
  });
});
