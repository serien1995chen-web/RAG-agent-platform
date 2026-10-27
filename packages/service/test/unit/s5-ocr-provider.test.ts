import { describe, expect, it } from 'vitest';
import { S5OcrCredentialProfileAdapter } from '../../src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import { S5OcrHttpAdapter } from '../../src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5RemoteAssetAdapter } from '../../src/modules/knowledge/adapter/s5-remote-asset.adapter';
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
  workspaceId: 'ws_ocr',
  memberId: 'mem_ocr',
  requestId: 'req-ocr',
  traceId: 'trace-ocr',
  scopes: ['knowledge:read', 'knowledge:write'],
};

const profile: OcrCredentialProfilePort = {
  async resolve() {
    return {
      endpoint: 'https://ocr.example.invalid/api',
      credentials: {
        token: 'fake-token',
        apiKey: 'fake-api-key',
        appId: 'fake-app-id',
        secretCode: 'fake-secret-code',
      },
    };
  },
};

function common(provider: S5OcrProviderConfig['provider']): Omit<S5OcrProviderConfig, 'provider'> {
  return {
    credentialProfileId: 'env:OCR_PROFILE',
    timeoutMs: 10_000,
    fallbackProvider: 'none',
    imageHandling: 'upload_to_storage',
    ...(provider === 'doc2x' ? { pollIntervalMs: 1 } : {}),
  } as Omit<S5OcrProviderConfig, 'provider'>;
}

const configs: Record<S5OcrProviderConfig['provider'], S5OcrProviderConfig> = {
  sangfor: {
    ...common('sangfor'),
    provider: 'sangfor',
    keepHeaderFooter: false,
    keepAppendix: true,
    imageAnalysis: false,
    chartAnalysis: false,
  },
  somark: { ...common('somark'), provider: 'somark' },
  textin: {
    ...common('textin'),
    provider: 'textin',
    removeWatermark: true,
    parseMode: 'auto',
  },
  doc2x: { ...common('doc2x'), provider: 'doc2x', pollIntervalMs: 1 },
};

function response(data: unknown, status = 200): S5OcrHttpResponse {
  return { status, headers: {}, data };
}

describe('TEST-PARSE-002-BLOCK four OCR provider contracts', () => {
  it('resolves env credential profiles without leaking the raw JSON', async () => {
    const adapter = new S5OcrCredentialProfileAdapter({
      OCR_PROFILE: JSON.stringify({
        endpoint: 'https://ocr.example.invalid',
        credentials: { apiKey: 'secret-profile-value' },
      }),
      BAD_PROFILE: '{not-json-secret-profile}',
    });
    await expect(adapter.resolve('env:OCR_PROFILE', 'somark')).resolves.toMatchObject({
      endpoint: 'https://ocr.example.invalid',
      credentials: { apiKey: 'secret-profile-value' },
    });
    const failure = await adapter.resolve('env:BAD_PROFILE', 'somark').catch((error) => error);
    expect(failure).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(JSON.stringify(failure)).not.toContain('secret-profile');
  });

  it('maps all four provider requests and schemas', async () => {
    const calls: S5OcrHttpRequest[] = [];
    const transport: S5OcrHttpTransportPort = {
      async request<T>(request) {
        calls.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith('/parse/preupload')) {
          return response({
            uploadUrl: 'https://upload.example.invalid/put',
            statusUrl: 'https://upload.example.invalid/status',
          }) as S5OcrHttpResponse<T>;
        }
        if (url.hostname === 'upload.example.invalid' && request.method === 'PUT') {
          return response({}) as S5OcrHttpResponse<T>;
        }
        if (url.hostname === 'upload.example.invalid') {
          return response({
            status: 'success',
            markdown: 'Doc2x result',
            pages: [{ pageNumber: 1, markdown: 'Doc2x result' }],
          }) as S5OcrHttpResponse<T>;
        }
        if (url.pathname.endsWith('/parse/sync')) {
          return response({
            code: 0,
            markdown: 'Somark result',
            pages: [{ pageNum: 1, markdown: 'Somark result' }],
          }) as S5OcrHttpResponse<T>;
        }
        if (url.pathname.endsWith('/pdf_to_markdown')) {
          return response({
            code: 200,
            markdown: 'Textin result',
            pages: [{ page: 1, text: 'Textin result' }],
          }) as S5OcrHttpResponse<T>;
        }
        return response({
          markdown: 'Sangfor result',
          pages: [{ pageNumber: 1, markdown: 'Sangfor result' }],
        }) as S5OcrHttpResponse<T>;
      },
    };
    const adapter = new S5OcrHttpAdapter({
      profiles: profile,
      transport,
      sleep: async () => undefined,
    });
    for (const provider of ['sangfor', 'somark', 'textin', 'doc2x'] as const) {
      const result = await adapter.parse(
        {
          workspaceId: context.workspaceId,
          sourceId: 'source-1',
          sourceVersion: 1,
          bytes: Buffer.from('%PDF-1.4 fixture'),
          fileName: 'fixture.pdf',
          mimeType: 'application/pdf',
          config: configs[provider],
          timeoutMs: 10_000,
          requestId: context.requestId,
          traceId: context.traceId,
        },
        context,
      );
      expect(result.markdown.toLowerCase()).toContain(provider === 'textin' ? 'textin' : provider);
      expect(result.pages.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.requestEvidence)).not.toContain('fake-');
    }
    expect(calls).toHaveLength(6);
    const textin = calls.find((call) => call.url.includes('/pdf_to_markdown'));
    expect(textin?.headers['x-ti-app-id']).toBe('fake-app-id');
    expect(textin?.headers['x-ti-secret-code']).toBe('fake-secret-code');
    const sangfor = calls.find((call) => call.url.endsWith('/ocr'));
    expect(sangfor?.headers.Authorization).toBe('Bearer fake-token');
    expect(sangfor?.body).toBeInstanceOf(FormData);
  });

  it('rejects private, loopback and redirect-to-private asset URLs', async () => {
    const adapter = new S5RemoteAssetAdapter({
      lookup: async (hostname) =>
        hostname === 'public.example.invalid'
          ? [{ address: '93.184.216.34', family: 4 }]
          : hostname === 'mapped-private.example.invalid'
            ? [{ address: '::ffff:ac10:1', family: 6 }]
            : hostname === 'mapped-metadata.example.invalid'
              ? [{ address: '::ffff:a9fe:a9fe', family: 6 }]
              : hostname === 'mapped-cgnat.example.invalid'
                ? [{ address: '::ffff:6440:1', family: 6 }]
                : [{ address: '127.0.0.1', family: 4 }],
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('public.example.invalid')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://private.example.invalid/image.png' },
          });
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    });
    for (const url of [
      'http://127.0.0.1/image.png',
      'http://localhost/image.png',
      'http://169.254.169.254/latest/meta-data',
      'https://mapped-private.example.invalid/image.png',
      'https://mapped-metadata.example.invalid/image.png',
      'https://mapped-cgnat.example.invalid/image.png',
      'https://public.example.invalid/redirect.png',
    ]) {
      await expect(adapter.fetch(url)).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
      });
    }
  });

  it('fetches a bounded public image and hashes actual bytes', async () => {
    let dispatcherPinned = false;
    const adapter = new S5RemoteAssetAdapter({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetch: async (_input, init) => {
        dispatcherPinned = init.dispatcher !== undefined;
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '3' },
        });
      },
    });
    await expect(adapter.fetch('https://public.example.invalid/image.png')).resolves.toMatchObject({
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    });
    expect(dispatcherPinned).toBe(true);
  });
});

class UsageRecorder implements S5ProviderUsageRecorderPort {
  readonly facts: S5ProviderUsageFact[] = [];

  async recordProviderUsage(fact: S5ProviderUsageFact): Promise<boolean> {
    this.facts.push(fact);
    return true;
  }
}

function application(provider: OcrProviderPort, options: { fallback?: boolean } = {}) {
  const usage = new UsageRecorder();
  let fallbackCalls = 0;
  const client = new S5OcrApplication({
    provider,
    usage,
    remoteAssets: {
      async fetch() {
        return {
          bytes: new Uint8Array([9, 9]),
          mimeType: 'image/png',
          sha256: 'image-sha',
        };
      },
    },
    assetSink: {
      async putImage() {
        return { objectRefId: 'image-ref', markdownUrl: 'object://image-ref' };
      },
    },
    sourceGuard: { async assertSource() {} },
    ...(options.fallback
      ? {
          fallbackPdf: async () => {
            fallbackCalls += 1;
            return {
              markdown: 'fallback text',
              pages: [{ pageNumber: 1, text: 'fallback text', assets: [] }],
              assets: [],
              diagnostics: [],
            };
          },
        }
      : {}),
    sleep: async () => undefined,
  });
  return { client, usage, fallbackCalls: () => fallbackCalls };
}

function input(overrides: Partial<Parameters<S5OcrApplication['parse']>[0]> = {}) {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId: 'space-ocr',
    sourceId: 'source-ocr',
    sourceVersion: 1,
    bytes: Buffer.from('%PDF-1.4 fixture'),
    fileName: 'fixture.pdf',
    mimeType: 'application/pdf',
    config: { ...configs.sangfor, fallbackProvider: 'liteparse' as const },
    timeoutMs: 10_000,
    requestId: context.requestId,
    traceId: context.traceId,
    context,
    ...overrides,
  };
}

describe('TEST-X-OCR-TIMEOUT application retry and fallback', () => {
  it('retries timeout three times and records a separate LiteParse fallback call', async () => {
    let calls = 0;
    const harness = application(
      {
        async parse() {
          calls += 1;
          throw new S5OcrProviderError(
            'timeout',
            null,
            [{ provider: 'sangfor', unit: 'request', quantity: 1, status: null }],
            true,
            false,
          );
        },
      },
      { fallback: true },
    );
    const result = await harness.client.parse(input());
    expect(calls).toBe(3);
    expect(harness.fallbackCalls()).toBe(1);
    expect(result.fallbackUsed).toBe(true);
    expect(result.actualProvider).toBe('liteparse');
    expect(harness.usage.facts).toHaveLength(4);
    expect(harness.usage.facts.at(-1)?.provider).toBe('liteparse');
  });

  it('does not retry or fallback after auth failure', async () => {
    let calls = 0;
    const harness = application(
      {
        async parse() {
          calls += 1;
          throw new S5OcrProviderError(
            'auth',
            401,
            [{ provider: 'sangfor', unit: 'request', quantity: 1, status: 401 }],
            false,
            false,
          );
        },
      },
      { fallback: true },
    );
    await expect(harness.client.parse(input())).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
    });
    expect(calls).toBe(1);
    expect(harness.fallbackCalls()).toBe(0);
  });

  it('retries invalid schema exactly once', async () => {
    let calls = 0;
    const harness = application({
      async parse() {
        calls += 1;
        if (calls === 1) {
          throw new S5OcrProviderError(
            'contract',
            200,
            [{ provider: 'sangfor', unit: 'request', quantity: 1, status: 200 }],
            false,
            true,
          );
        }
        return {
          markdown: 'valid after repair',
          pages: [{ pageNumber: 1, text: 'valid after repair', assets: [] }],
          assets: [],
          diagnostics: [],
          usage: [{ provider: 'sangfor', unit: 'page', quantity: 1, status: 200 }],
          requestEvidence: { provider: 'sangfor' },
        };
      },
    });
    const result = await harness.client.parse(input());
    expect(result.markdown).toBe('valid after repair');
    expect(calls).toBe(2);
  });

  it('transfers remote images once and rewrites markdown to an object reference', async () => {
    let remoteFetches = 0;
    let sinkWrites = 0;
    const usage = new UsageRecorder();
    const client = new S5OcrApplication({
      provider: {
        async parse() {
          return {
            markdown: 'before ![image](https://cdn.example.invalid/a.png) after',
            pages: [
              {
                pageNumber: 1,
                text: 'before ![image](https://cdn.example.invalid/a.png) after',
                assets: [],
              },
            ],
            assets: [],
            diagnostics: [],
            usage: [{ provider: 'sangfor', unit: 'page', quantity: 1, status: 200 }],
            requestEvidence: {},
          };
        },
      },
      usage,
      remoteAssets: {
        async fetch() {
          remoteFetches += 1;
          return {
            bytes: new Uint8Array([1]),
            mimeType: 'image/png',
            sha256: 'asset-sha',
          };
        },
      },
      assetSink: {
        async putImage() {
          sinkWrites += 1;
          return { objectRefId: 'object-id', markdownUrl: 'object://object-id' };
        },
      },
      sourceGuard: { async assertSource() {} },
    });
    const result = await client.parse(input());
    expect(remoteFetches).toBe(1);
    expect(sinkWrites).toBe(1);
    expect(result.markdown).toContain('object://object-id');
    expect(result.markdown).not.toContain('https://cdn.example.invalid');
    expect(result.assets[0]?.objectRefId).toBe('object-id');
  });
});
