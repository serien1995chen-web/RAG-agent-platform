import { describe, expect, it, vi } from 'vitest';
import {
  S5AiproxyHttpAdapter,
  type S5HttpRequest,
  type S5HttpResponse,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import {
  S5OcrHttpAdapter,
  type S5OcrHttpResponse,
} from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import type {
  OcrCredentialProfilePort,
  S5OcrHttpRequest,
  S5OcrHttpTransportPort,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import {
  S11ConnectorHttpClient,
  S11ConnectorTokenCache,
  parseConnectorResponse,
} from '../../packages/service/src/modules/knowledge/adapter/connectors/s11-connector-http';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s11_provider_fault',
  memberId: 'mem_s11_provider_fault',
  requestId: 'req_s11_provider_fault',
  traceId: 'trace_s11_provider_fault',
  scopes: ['knowledge:read', 'knowledge:write'],
};

class QueueTransport<TRequest, TResponse> {
  readonly requests: TRequest[] = [];

  constructor(
    private readonly responses: Array<
      TResponse | ((request: TRequest) => TResponse | Promise<TResponse>)
    >,
  ) {}

  async request(request: TRequest): Promise<TResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected request');
    return typeof response === 'function' ? response(request) : response;
  }
}

function aiproxy(status: number) {
  const transport = new QueueTransport<S5HttpRequest, S5HttpResponse>([
    { status, headers: {}, data: {} },
  ]);
  const adapter = new S5AiproxyHttpAdapter({
    baseUrl: 'https://provider.example.test/v1',
    token: 'provider-secret',
    transport: transport as S5HttpTransportPort,
  });
  return adapter.invoke(
    {
      kind: 'llm',
      modelId: 'provider-llm',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 8,
    },
    context,
  );
}

describe('TEST-X-S11-PROVIDER-REAL provider fault classification', () => {
  it('does not retry AIProxy auth failures and classifies rate limits', async () => {
    await expect(aiproxy(401)).rejects.toMatchObject({ kind: 'auth', status: 401 });
    await expect(aiproxy(429)).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('maps an invalid OCR success body to a contract error', async () => {
    const profiles: OcrCredentialProfilePort = {
      async resolve() {
        return {
          endpoint: 'https://ocr.example.test/api',
          credentials: { token: 'provider-secret' },
        };
      },
    };
    const transport = new QueueTransport<S5OcrHttpRequest, S5OcrHttpResponse>([
      { status: 200, headers: {}, data: { markdown: '' } },
    ]);
    const adapter = new S5OcrHttpAdapter({
      profiles,
      transport: transport as S5OcrHttpTransportPort,
    });
    await expect(
      adapter.parse(
        {
          workspaceId: context.workspaceId,
          sourceId: 'source-s11-fault',
          sourceVersion: 1,
          bytes: new TextEncoder().encode('%PDF-1.4'),
          fileName: 'fault.pdf',
          mimeType: 'application/pdf',
          timeoutMs: 1_000,
          fallbackProvider: 'none',
          imageHandling: 'drop',
          requestId: context.requestId,
          traceId: context.traceId,
          config: {
            provider: 'sangfor',
            credentialProfileId: 'env:S11_OCR_SANGFOR_PROFILE_JSON',
            timeoutMs: 1_000,
            fallbackProvider: 'none',
            imageHandling: 'drop',
            keepHeaderFooter: false,
            keepAppendix: true,
            imageAnalysis: false,
            chartAnalysis: false,
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ kind: 'contract', schemaRetryable: true });
  });

  it('treats connector permission failures as non-retryable and redacts evidence', async () => {
    const transport = new QueueTransport<
      Parameters<S11ConnectorHttpClient['request']>[0],
      S5HttpResponse
    >([{ status: 403, headers: {}, data: { secret: 'provider-secret' } }]);
    const client = new S11ConnectorHttpClient({
      provider: 'feishu',
      transport: transport as never,
      sleep: vi.fn(),
    });
    await expect(
      client.request(
        {
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/drive/v1/files?folder_token=hidden',
          headers: { authorization: 'Bearer provider-secret' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          retryable: false,
          details: { providerStatus: 403, errorKind: 'permission' },
        },
      },
    });
    expect(JSON.stringify(client.evidence)).not.toContain('provider-secret');
    expect(JSON.stringify(client.evidence)).not.toContain('hidden');
  });

  it('retries connector 5xx with the fixed policy and records attempts', async () => {
    const transport = new QueueTransport<
      Parameters<S11ConnectorHttpClient['request']>[0],
      S5HttpResponse
    >([
      { status: 503, headers: {}, data: {} },
      { status: 200, headers: {}, data: { data: [] } },
    ]);
    const sleeps: number[] = [];
    const client = new S11ConnectorHttpClient({
      provider: 'yuque',
      transport: transport as never,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.request(
      {
        method: 'GET',
        url: 'https://www.yuque.com/api/v2/groups/example/repos',
        headers: { 'X-Auth-Token': 'provider-secret' },
      },
      context,
    );
    expect(sleeps).toEqual([5_000]);
    expect(client.evidence.map((entry) => entry.attempt)).toEqual([1, 2]);
  });
});

describe('L1-B09 connector fault and concurrency boundaries', () => {
  it('L1-B09-ING-007-C01 coalesces concurrent token cache misses into one provider refresh', async () => {
    const cache = new S11ConnectorTokenCache();
    let loads = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        cache.getOrLoad('workspace:feishu:credential', async () => {
          loads += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { token: 'safe-refreshed-token', expiresInSeconds: 7_200 };
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => 'safe-refreshed-token'));
    expect(loads).toBe(1);
  });

  it('L1-B09-ING-007-F02 limits invalid schema repair to one bounded re-read', async () => {
    let requests = 0;
    await expect(
      parseConnectorResponse(
        async () => {
          requests += 1;
          return {
            status: 200,
            headers: {},
            data: { data: { files: 'not-an-array' } },
          };
        },
        (value) => {
          const data = (value as { data?: { files?: unknown } }).data;
          if (!Array.isArray(data?.files)) throw new Error('files must be an array');
          return data.files;
        },
        { provider: 'feishu', context },
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
          details: {
            provider: 'feishu',
            schemaRetries: 1,
          },
        },
      },
    });
    expect(requests).toBe(2);
  });

  it('L1-B09-ING-007-N02 does not retry auth failures and caps 429 retries at five attempts', async () => {
    const authTransport = new QueueTransport<
      Parameters<S11ConnectorHttpClient['request']>[0],
      S5HttpResponse
    >([{ status: 401, headers: {}, data: {} }]);
    const authSleep = vi.fn();
    const authClient = new S11ConnectorHttpClient({
      provider: 'feishu',
      transport: authTransport as never,
      sleep: authSleep,
    });
    await expect(
      authClient.request(
        {
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/drive/v1/files?folder_token=safe',
          headers: { authorization: 'Bearer safe-token' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          retryable: false,
          details: { providerStatus: 401, errorKind: 'auth' },
        },
      },
    });
    expect(authTransport.requests).toHaveLength(1);
    expect(authSleep).not.toHaveBeenCalled();

    const limitedTransport = new QueueTransport<
      Parameters<S11ConnectorHttpClient['request']>[0],
      S5HttpResponse
    >(
      Array.from({ length: 5 }, () => ({
        status: 429,
        headers: {},
        data: {},
      })),
    );
    const sleeps: number[] = [];
    const limitedClient = new S11ConnectorHttpClient({
      provider: 'feishu',
      transport: limitedTransport as never,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(
      limitedClient.request(
        {
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/drive/v1/files?folder_token=safe',
          headers: { authorization: 'Bearer safe-token' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_RATE_LIMITED',
          retryable: true,
          details: { attempts: 5 },
        },
      },
    });
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(limitedTransport.requests).toHaveLength(5);
  });
});
