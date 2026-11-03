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
import { S11ConnectorHttpClient } from '../../packages/service/src/modules/knowledge/adapter/connectors/s11-connector-http';
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
