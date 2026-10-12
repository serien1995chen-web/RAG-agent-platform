import { ApiErrorException } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  createApiDatasetSourceProvider,
  createExternalSourceProvider,
  createFileSourceProvider,
  createSourceProviderRegistry,
  createTextSourceProvider,
} from '../../src/modules/collection/adapter/source-provider/index';
import type {
  ApiDatasetCatalogRequest,
  ApiDatasetConfig,
  DatasetSourceProvider,
  ObjectStorePort,
  PdfEnhanceProviderPort,
  SourceReadRequest,
} from '../../src/ports/capabilities';
import type { RequestContext } from '../../src/ports/types';

const stubParser = {
  parse: async (input: { bytes?: Uint8Array }) => ({
    format: 'text',
    rawText: Buffer.from(input.bytes ?? new Uint8Array()).toString('utf8'),
    scanRequired: false,
    imageRefs: [],
    contentHash: 'sha256:stub',
  }),
};

const context: RequestContext = {
  requestId: 'req-1',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function request(sourceType: string, sourceRef: string): SourceReadRequest {
  return { datasetId: 'ds-1', sourceType, sourceRef, options: { timeoutMs: 5000 } };
}

async function captureCode(
  provider: DatasetSourceProvider,
  req: SourceReadRequest,
): Promise<number> {
  try {
    await provider.read(req, context);
    return 0;
  } catch (error) {
    if (error instanceof ApiErrorException) return error.error.code;
    throw error;
  }
}

function codeOf(error: unknown): number {
  if (error instanceof ApiErrorException) return error.error.code;
  throw error;
}

async function codeOfAsync(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
    return 0;
  } catch (error) {
    return codeOf(error);
  }
}

function apiConfig(overrides: Partial<ApiDatasetConfig> = {}): ApiDatasetConfig {
  return {
    provider: 'custom',
    credentialRef: 'ref://demo',
    capabilities: [
      { name: 'getCatalog', supported: true },
      { name: 'getPathNames', supported: true },
      { name: 'list', supported: true },
    ],
    ...overrides,
  };
}

function catalogRequest(config: ApiDatasetConfig, parentId = 'root'): ApiDatasetCatalogRequest {
  return { datasetId: 'ds-1', apiConfig: config, parentId, options: { timeoutMs: 5000 } };
}

describe('TEST-FI-PROVIDER-001 source providers', () => {
  it('reads text with a stable content hash and allows empty text', async () => {
    const provider = createTextSourceProvider();
    const result = await provider.read(request('text', '纯文本内容'), context);
    expect(result.rawText).toBe('纯文本内容');
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const empty = await provider.read(request('text', ''), context);
    expect(empty.rawText).toBe('');
  });

  it('reads files through ObjectStore and @kb/parse', async () => {
    const objectStore: ObjectStorePort = {
      get: async () => ({
        ref: { bucket: 'kb-source', key: 'a.txt' },
        body: Buffer.from('file body'),
      }),
      put: async () => ({ bucket: 'kb-source', key: 'x' }),
      delete: async () => ({ deleted: true }),
      promote: async (input) => input.ref,
      prepareMultipart: async (input) => input.ref,
      uploadPart: async (input) => ({
        partNumber: input.partNumber,
        etag: 'stub',
        size: input.body.byteLength,
      }),
      completeMultipart: async (input) => ({ ...input.ref, etag: input.hash }),
      abort: async () => ({ aborted: true }),
    };
    const provider = createFileSourceProvider({ objectStore, parser: stubParser });
    const result = await provider.read(request('file', 'a.txt'), context);
    expect(result.rawText).toBe('file body');
    expect(result.fileRef).toBe('a.txt');
  });

  it('rejects files without extension as 501035', async () => {
    const objectStore: ObjectStorePort = {
      get: async () => ({ ref: { bucket: 'kb-source', key: 'noext' }, body: Buffer.from('x') }),
      put: async () => ({ bucket: 'kb-source', key: 'x' }),
      delete: async () => ({ deleted: true }),
      promote: async (input) => input.ref,
      prepareMultipart: async (input) => input.ref,
      uploadPart: async (input) => ({
        partNumber: input.partNumber,
        etag: 'stub',
        size: input.body.byteLength,
      }),
      completeMultipart: async (input) => ({ ...input.ref, etag: input.hash }),
      abort: async () => ({ aborted: true }),
    };
    const provider = createFileSourceProvider({ objectStore, parser: stubParser });
    expect(await captureCode(provider, request('file', 'noext'))).toBe(501035);
  });

  it('does not issue any request when apiFile is unconfigured (501062)', async () => {
    let called = 0;
    const provider = createApiDatasetSourceProvider({
      configured: false,
      client: {
        get: async () => {
          called += 1;
          return { status: 200, data: 'x' };
        },
      },
    });
    expect(await captureCode(provider, request('apiFile', 'x'))).toBe(501062);
    expect(called).toBe(0);
  });

  it('maps a configured apiFile success and failure', async () => {
    const ok = createApiDatasetSourceProvider({
      configured: true,
      client: { get: async () => ({ status: 200, data: '第三方内容' }) },
    });
    expect((await ok.read(request('apiFile', 'x'), context)).rawText).toBe('第三方内容');
    const failed = createApiDatasetSourceProvider({
      configured: true,
      client: {
        get: async () => {
          throw { response: { status: 503 } };
        },
      },
    });
    expect(await captureCode(failed, request('apiFile', 'x'))).toBe(501039);
  });

  it('maps the PDF provider mock (TEST-PDF-MOCK-001)', async () => {
    const pdfProvider: PdfEnhanceProviderPort = {
      upload: async () => ({ providerTaskId: 't1' }),
      parse: async () => ({ state: 'done', text: 'PDF 解析正文' }),
      poll: async () => ({ state: 'done', text: 'PDF 解析正文' }),
      cancel: async () => ({ cancelled: true }),
    };
    const provider = createExternalSourceProvider({
      configured: true,
      pdfProvider,
      mock: false,
      environment: 'test',
      sleep: async () => {},
    });
    const result = await provider.read(request('externalFile', 'scan.pdf'), context);
    expect(result.rawText).toBe('PDF 解析正文');
  });

  it('wires the audit sink through the registry and records read/blocked/failed with minimal fields (TEST-E2E-PROVIDER-001)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const registry = createSourceProviderRegistry({
      linkFetcher: async () => ({
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null,
        },
        text: async () =>
          '<html><body><p>正文内容足够长用于通过占比校验的静态文本。</p></body></html>',
      }),
      resolveHost: async () => ['93.184.216.34'],
      linkLimits: { retryBackoffMs: [] },
      audit: (entry) => events.push(entry as unknown as Record<string, unknown>),
    });
    const provider = registry.resolve('link') as DatasetSourceProvider;

    const result = await provider.read(request('link', 'https://example.com/a?secret=1'), context);
    expect(result.rawText).toContain('正文内容');

    await provider.read(request('link', 'http://10.0.0.9/'), context).catch(() => undefined);

    const readEvent = events.find((entry) => entry.event === 'source.read');
    expect(readEvent).toBeDefined();
    expect(readEvent?.host).toBe('example.com');
    expect(typeof readEvent?.urlHash).toBe('string');
    expect(events.some((entry) => entry.event === 'source.blocked')).toBe(true);
    for (const entry of events) {
      expect(Object.keys(entry)).not.toContain('body');
      expect(Object.keys(entry)).not.toContain('query');
      expect(JSON.stringify(entry)).not.toContain('secret=1');
    }
  });

  it('records source.failed for a 4xx link response', async () => {
    const events: Array<Record<string, unknown>> = [];
    const registry = createSourceProviderRegistry({
      linkFetcher: async () => ({
        status: 404,
        headers: { get: () => null },
        text: async () => '',
      }),
      resolveHost: async () => ['93.184.216.34'],
      linkLimits: { retryBackoffMs: [] },
      audit: (entry) => events.push(entry as unknown as Record<string, unknown>),
    });
    const provider = registry.resolve('link') as DatasetSourceProvider;
    await provider
      .read(request('link', 'https://example.com/missing'), context)
      .catch(() => undefined);
    expect(events.some((entry) => entry.event === 'source.failed')).toBe(true);
  });

  it('rejects production + mock with 501063 without calling the provider (TEST-U25-PROVIDER-001)', async () => {
    let called = 0;
    const pdfProvider: PdfEnhanceProviderPort = {
      upload: async () => {
        called += 1;
        return { providerTaskId: 't1' };
      },
      parse: async () => ({ state: 'done', text: 'x' }),
      poll: async () => ({ state: 'done', text: 'x' }),
      cancel: async () => ({ cancelled: true }),
    };
    const registry = createSourceProviderRegistry({
      pdfProvider,
      pdfProviderConfigured: true,
      mock: true,
      environment: 'production',
    });
    const provider = registry.resolve('externalFile') as DatasetSourceProvider;
    try {
      await provider.read(request('externalFile', 'scan.pdf'), context);
      expect.unreachable('should throw');
    } catch (error) {
      expect(codeOf(error)).toBe(501063);
    }
    expect(called).toBe(0);
  });

  it('rejects unregistered source types with a stable error', async () => {
    const registry = createSourceProviderRegistry({});
    try {
      await registry.read(request('unknownType', 'x'), context);
      expect.unreachable('should throw');
    } catch (error) {
      expect(codeOf(error)).toBe(501035);
    }
  });

  it('rejects API Dataset calls when unconfigured (501017) without issuing a request', async () => {
    let called = 0;
    const provider = createApiDatasetSourceProvider({
      configured: false,
      client: {
        get: async () => ({ status: 200, data: 'x' }),
        getCatalog: async () => {
          called += 1;
          return [];
        },
      },
    });
    expect(
      await codeOfAsync(() => provider.getCatalog!(catalogRequest(apiConfig()), context)),
    ).toBe(501017);
    expect(called).toBe(0);
  });

  it('rejects API Dataset calls when the capability is not declared (501019)', async () => {
    let called = 0;
    const provider = createApiDatasetSourceProvider({
      configured: true,
      client: {
        get: async () => ({ status: 200, data: 'x' }),
        getCatalog: async () => {
          called += 1;
          return [];
        },
      },
    });
    const config = apiConfig({ capabilities: [{ name: 'list', supported: true }] });
    expect(await codeOfAsync(() => provider.getCatalog!(catalogRequest(config), context))).toBe(
      501019,
    );
    expect(called).toBe(0);
  });

  it('does not fake success when the injected client lacks the API Dataset method', async () => {
    const provider = createApiDatasetSourceProvider({
      configured: true,
      client: { get: async () => ({ status: 200, data: 'x' }) },
    });
    expect(
      await codeOfAsync(() => provider.getCatalog!(catalogRequest(apiConfig()), context)),
    ).toBe(501019);
    expect(
      await codeOfAsync(() =>
        provider.list!(
          { datasetId: 'ds-1', apiConfig: apiConfig(), options: { timeoutMs: 5000 } },
          context,
        ),
      ),
    ).toBe(501019);
  });

  it('passes API Dataset catalog/path/list through to the injected client', async () => {
    const provider = createApiDatasetSourceProvider({
      configured: true,
      baseUrl: 'https://api.example.test',
      client: {
        get: async () => ({ status: 200, data: 'x' }),
        getCatalog: async (req, options) => {
          expect(req.parentId).toBe('root');
          expect(options.baseUrl).toBe('https://api.example.test');
          expect(options.timeoutMs).toBe(5000);
          return [{ id: 'n1' }];
        },
        getPathNames: async () => '/root/n1',
        list: async () => [{ id: 'f1' }],
      },
    });
    expect(await provider.getCatalog!(catalogRequest(apiConfig()), context)).toEqual([
      { id: 'n1' },
    ]);
    expect(
      await provider.getPathNames!(
        { datasetId: 'ds-1', apiConfig: apiConfig(), nodeId: 'n1', options: { timeoutMs: 5000 } },
        context,
      ),
    ).toBe('/root/n1');
    expect(
      await provider.list!(
        { datasetId: 'ds-1', apiConfig: apiConfig(), options: { timeoutMs: 5000 } },
        context,
      ),
    ).toEqual([{ id: 'f1' }]);
  });

  it('maps API Dataset provider failures to 501039', async () => {
    const provider = createApiDatasetSourceProvider({
      configured: true,
      client: {
        get: async () => ({ status: 200, data: 'x' }),
        getCatalog: async () => {
          throw { response: { status: 503 } };
        },
      },
    });
    expect(
      await codeOfAsync(() => provider.getCatalog!(catalogRequest(apiConfig()), context)),
    ).toBe(501039);
  });

  it('caches getCatalog per teamId+datasetId+provider+parentId for 5 minutes', async () => {
    let calls = 0;
    const registry = createSourceProviderRegistry({
      apiDataset: {
        configured: true,
        client: {
          get: async () => ({ status: 200, data: 'x' }),
          getCatalog: async () => {
            calls += 1;
            return [{ id: `n${calls}` }];
          },
        },
      },
    });
    const first = await registry.getCatalog(catalogRequest(apiConfig()), context);
    const second = await registry.getCatalog(catalogRequest(apiConfig()), context);
    expect(first).toEqual([{ id: 'n1' }]);
    expect(second).toEqual(first);
    expect(calls).toBe(1);

    await registry.getCatalog(catalogRequest(apiConfig(), 'other-parent'), context);
    expect(calls).toBe(2);
  });
});
