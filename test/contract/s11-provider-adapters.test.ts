import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { S5AiproxyHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5OcrHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrCredentialProfileAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import type {
  OcrCredentialProfilePort,
  S5OcrProviderName,
  S5OcrHttpTransportPort,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { S5ModelInvocation } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type {
  S5HttpRequest,
  S5HttpResponse,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { S5HttpTransportPort } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { FeishuHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu-http.delegate';
import { YuqueHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/yuque-http.delegate';
import { DingtalkHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/dingtalk-http.delegate';
import type {
  S11ConnectorHttpRequest,
  S11ConnectorHttpResponse,
  S11ConnectorHttpTransport,
} from '../../packages/service/src/modules/knowledge/adapter/connectors/s11-connector-http';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const root = resolve(import.meta.dirname, '../..');
const context: TenantContext = {
  workspaceId: 'ws_s11_provider_contract',
  memberId: 'mem_s11_provider_contract',
  requestId: 'req_s11_provider_contract',
  traceId: 'trace_s11_provider_contract',
  scopes: ['knowledge:read', 'knowledge:write'],
};

class ScriptedTransport<TRequest, TResponse> {
  readonly requests: TRequest[] = [];
  readonly responses: Array<TResponse | ((request: TRequest) => TResponse | Promise<TResponse>)>;

  constructor(
    responses: Array<TResponse | ((request: TRequest) => TResponse | Promise<TResponse>)>,
  ) {
    this.responses = [...responses];
  }

  async request(request: TRequest): Promise<TResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected transport request');
    return typeof response === 'function'
      ? (response as (request: TRequest) => TResponse | Promise<TResponse>)(request)
      : response;
  }
}

class ConnectorTransport implements S11ConnectorHttpTransport {
  readonly requests: S11ConnectorHttpRequest[] = [];

  constructor(
    private readonly responses: Array<
      S11ConnectorHttpResponse | ((request: S11ConnectorHttpRequest) => S11ConnectorHttpResponse)
    >,
  ) {}

  async request<T = unknown>(
    request: S11ConnectorHttpRequest,
  ): Promise<S11ConnectorHttpResponse<T>> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('unexpected connector request');
    return (
      typeof response === 'function' ? response(request) : response
    ) as S11ConnectorHttpResponse<T>;
  }
}

function response<T>(status: number, data: T, headers: Record<string, string> = {}) {
  return { status, headers, data };
}

function invokeModel(
  status: number,
  data: unknown,
  kind: S5ModelInvocation = {
    kind: 'llm',
    modelId: 's11-llm',
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 32,
  },
) {
  const transport = new ScriptedTransport<S5HttpRequest, S5HttpResponse>([response(status, data)]);
  const adapter = new S5AiproxyHttpAdapter({
    baseUrl: 'https://aiproxy.example.test/v1',
    token: 's11-aiproxy-token',
    transport: transport as S5HttpTransportPort,
  });
  return {
    transport,
    result: adapter.invoke(kind, {
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    }),
  };
}

const OCR_PROFILES: Record<
  S5OcrProviderName,
  { endpoint: string; credentials: Record<string, string> }
> = {
  sangfor: { endpoint: 'https://sangfor.example.test/api', credentials: { token: 'sg-token' } },
  somark: { endpoint: 'https://somark.example.test/api', credentials: { apiKey: 'sm-key' } },
  textin: {
    endpoint: 'https://textin.example.test/api',
    credentials: { appId: 'ti-app', secretCode: 'ti-secret' },
  },
  doc2x: { endpoint: 'https://doc2x.example.test/api', credentials: { apiKey: 'dx-key' } },
};

function ocrRequest(provider: S5OcrProviderName) {
  const common = {
    credentialProfileId: `env:S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`,
    timeoutMs: 10_000,
    fallbackProvider: 'none' as const,
    imageHandling: 'drop' as const,
  };
  const config =
    provider === 'sangfor'
      ? {
          ...common,
          provider,
          keepHeaderFooter: false,
          keepAppendix: true,
          imageAnalysis: false,
          chartAnalysis: false,
        }
      : provider === 'textin'
        ? { ...common, provider, removeWatermark: true, parseMode: 'auto' as const }
        : provider === 'doc2x'
          ? { ...common, provider, pollIntervalMs: 1 }
          : { ...common, provider };
  return {
    workspaceId: context.workspaceId,
    sourceId: 'source-s11-provider',
    sourceVersion: 1,
    bytes: new TextEncoder().encode('%PDF-1.4'),
    fileName: 'provider.pdf',
    mimeType: 'application/pdf',
    config,
    timeoutMs: 10_000,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

describe('TEST-X-S11-PROVIDER-REAL contract adapters', () => {
  it('uses AIProxy HTTP schema, bearer scoping, model IDs, and token usage', async () => {
    const invocation: S5ModelInvocation = {
      kind: 'llm',
      modelId: 's11-llm',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 12,
    };
    const transport = new ScriptedTransport<S5HttpRequest, S5HttpResponse>([
      response(200, {
        choices: [{ message: { content: 'real-safe-output' } }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      }),
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.test/base',
      token: 'aiproxy-secret-value',
      transport: transport as S5HttpTransportPort,
    });
    const result = await adapter.invoke(invocation, {
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    expect(result).toMatchObject({
      status: 200,
      quantity: 12,
      usage: { inputTokens: 7, outputTokens: 5 },
    });
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer aiproxy-secret-value',
        'X-Workspace-Id': context.workspaceId,
      },
      body: { model: 's11-llm', max_tokens: 12 },
    });
    expect(transport.requests[0]?.url).toBe(
      'https://aiproxy.example.test/base/v1/chat/completions',
    );
  });

  it('classifies AIProxy 401, 429, timeout, and invalid schema without retrying auth', async () => {
    await expect(invokeModel(401, {}).result).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    await expect(invokeModel(429, {}).result).rejects.toMatchObject({
      kind: 'rate_limit',
      status: 429,
    });
    await expect(invokeModel(503, {}).result).rejects.toMatchObject({
      kind: 'provider',
      status: 503,
    });
    await expect(invokeModel(200, { choices: [] }).result).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('keeps four OCR request shapes and provider usage without exposing profile values', async () => {
    for (const provider of ['sangfor', 'somark', 'textin', 'doc2x'] as const) {
      const transport = new ScriptedTransport<
        Parameters<S5OcrHttpTransportPort['request']>[0],
        S5HttpResponse
      >([]);
      if (provider === 'doc2x') {
        transport.responses.push(
          response(200, {
            uploadUrl: 'https://upload.example.test/object',
            statusUrl: 'https://doc2x.example.test/status/1',
          }),
          response(200, {}),
          response(200, {
            status: 'success',
            markdown: '# Doc2X',
            pages: [{ pageNumber: 1, markdown: 'Doc2X' }],
          }),
        );
      } else {
        transport.responses.push(
          response(
            200,
            provider === 'somark'
              ? { code: 0, markdown: '# Somark', pages: [{ pageNumber: 1, markdown: 'Somark' }] }
              : provider === 'textin'
                ? {
                    code: 200,
                    markdown: '# TextIn',
                    pages: [{ pageNumber: 1, markdown: 'TextIn' }],
                  }
                : { markdown: '# Sangfor', pages: [{ pageNumber: 1, markdown: 'Sangfor' }] },
          ),
        );
      }
      const profiles: OcrCredentialProfilePort = {
        resolve: vi.fn().mockResolvedValue(OCR_PROFILES[provider]),
      };
      const adapter = new S5OcrHttpAdapter({
        profiles,
        transport: transport as S5OcrHttpTransportPort,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
      const result = await adapter.parse(ocrRequest(provider) as never, context);
      expect(result.markdown).toBeTruthy();
      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.usage.some((usage) => usage.unit === 'page')).toBe(true);
      expect(transport.requests[0]?.url).toMatch(
        /\/api\/(ocr|parse\/sync|pdf_to_markdown|parse\/preupload)$/,
      );
      expect(JSON.stringify(result.requestEvidence)).not.toMatch(
        /sg-token|sm-key|ti-secret|dx-key|S11_OCR_.*PROFILE_JSON/,
      );
    }
  });

  it('maps OCR auth and invalid schema to retry-safe provider categories', async () => {
    const profiles: OcrCredentialProfilePort = {
      resolve: vi.fn().mockResolvedValue(OCR_PROFILES.sangfor),
    };
    const authTransport = new ScriptedTransport<
      Parameters<S5OcrHttpTransportPort['request']>[0],
      S5HttpResponse
    >([response(401, {})]);
    const authAdapter = new S5OcrHttpAdapter({
      profiles,
      transport: authTransport as S5OcrHttpTransportPort,
    });
    await expect(authAdapter.parse(ocrRequest('sangfor') as never, context)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });

    const invalidTransport = new ScriptedTransport<
      Parameters<S5OcrHttpTransportPort['request']>[0],
      S5HttpResponse
    >([response(200, { markdown: '' })]);
    const invalidAdapter = new S5OcrHttpAdapter({
      profiles,
      transport: invalidTransport as S5OcrHttpTransportPort,
    });
    await expect(
      invalidAdapter.parse(ocrRequest('sangfor') as never, context),
    ).rejects.toMatchObject({
      kind: 'contract',
      schemaRetryable: true,
    });
  });

  it('resolves OCR profiles only from explicitly referenced environment variables', async () => {
    const profileAdapter = new S5OcrCredentialProfileAdapter({
      S11_OCR_SANGFOR_PROFILE_JSON: JSON.stringify(OCR_PROFILES.sangfor),
    });
    await expect(
      profileAdapter.resolve('env:S11_OCR_SANGFOR_PROFILE_JSON', 'sangfor'),
    ).resolves.toEqual(OCR_PROFILES.sangfor);
    await expect(profileAdapter.resolve('raw-profile-id', 'sangfor')).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('Feishu refreshes once, paginates with page_size=200, and redacts evidence', async () => {
    const transport = new ConnectorTransport([
      response(200, { code: 0, tenant_access_token: 'tenant-one', expire: 7200 }),
      response(200, { code: 0, data: { files: [], next_page_token: 'next-page', has_more: true } }),
      response(401, {}),
      response(200, { code: 0, tenant_access_token: 'tenant-two', expire: 7200 }),
      response(200, {
        code: 0,
        data: {
          files: [
            { token: 'doc-token', name: 'Release Notes', type: 'docx' },
            { token: 'folder-token', name: 'Index', type: 'folder' },
          ],
          has_more: false,
        },
      }),
      response(200, { code: 0, data: { metas: [{ doc_token: 'doc-token', title: 'Notes' }] } }),
    ]);
    const delegate = new FeishuHttpDelegate({
      baseUrl: 'https://open.feishu.cn',
      transport,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const input = {
      provider: 'feishu' as const,
      config: { provider: 'feishu' as const, folderToken: 'folder value' },
      credentials: {
        provider: 'feishu' as const,
        appId: 'app-id',
        appSecret: 'app-secret-value',
      },
      rootId: 'folder',
      context,
    };
    const first = await delegate.catalog(input);
    expect(first.nextCursor).toBe('next-page');
    const second = await delegate.catalog({ ...input, cursor: first.nextCursor ?? undefined });
    expect(second.items).toEqual([
      expect.objectContaining({ id: 'feishu:docx:doc-token', name: 'Notes' }),
      expect.objectContaining({ id: 'feishu:folder:folder-token', type: 'directory' }),
    ]);
    expect(transport.requests[1]?.url).toContain('folder_token=folder+value');
    expect(transport.requests[1]?.url).toContain('page_size=200');
    expect(transport.requests[4]?.url).toContain('page_token=next-page');
    expect(transport.requests[2]?.headers.authorization).toBe('Bearer tenant-one');
    expect(transport.requests[4]?.headers.authorization).toBe('Bearer tenant-two');
    expect(JSON.stringify(delegate.evidence)).not.toMatch(
      /app-secret-value|tenant-one|tenant-two|folder\+value/,
    );
  });

  it('Feishu and Yuque use the fixed 5/10/20/40 second retry policy', async () => {
    const feishuTransport = new ConnectorTransport([
      response(200, { tenant_access_token: 'token', expire: 7200 }),
      response(429, {}),
      response(429, {}),
      response(429, {}),
      response(429, {}),
      response(200, { data: { files: [], has_more: false } }),
    ]);
    const sleeps: number[] = [];
    const feishu = new FeishuHttpDelegate({
      baseUrl: 'https://open.feishu.cn',
      transport: feishuTransport,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await feishu.catalog({
      provider: 'feishu',
      config: { provider: 'feishu', folderToken: 'folder' },
      credentials: { provider: 'feishu', appId: 'app', appSecret: 'secret' },
      rootId: 'folder',
      context,
    });
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000]);

    const yuqueTransport = new ConnectorTransport([response(429, {}), response(200, { data: [] })]);
    const yuqueSleeps: number[] = [];
    const yuque = new YuqueHttpDelegate({
      baseUrl: 'https://yuque.example.test',
      transport: yuqueTransport,
      sleep: async (ms) => {
        yuqueSleeps.push(ms);
      },
    });
    await yuque.listRepos({
      userId: 'user',
      credentials: { provider: 'yuque', userId: 'user', token: 'yuque-token' },
      context,
    });
    expect(yuqueSleeps).toEqual([5_000]);
  });

  it('Yuque uses X-Auth-Token, offset/limit pagination, and repo/toc/doc IDs', async () => {
    const transport = new ConnectorTransport([
      response(200, {
        data: [
          {
            uuid: 'toc-root',
            title: 'Engineering',
            type: 'TITLE',
            children: [
              {
                uuid: 'toc-doc',
                title: 'Runbook',
                type: 'DOC',
                slug: 'runbook',
              },
            ],
          },
        ],
      }),
    ]);
    const delegate = new YuqueHttpDelegate({
      baseUrl: 'https://yuque.example.test',
      transport,
    });
    const catalog = await delegate.catalog({
      provider: 'yuque',
      config: { provider: 'yuque', basePath: '/engineering' },
      credentials: { provider: 'yuque', userId: 'user', token: 'yuque-secret-token' },
      rootId: 'repo:41',
      context,
    });
    expect(catalog.items).toContainEqual({
      id: 'repo:41/toc:toc-doc/doc:runbook',
      name: 'Runbook',
      type: 'document',
    });
    expect(transport.requests[0]?.headers['X-Auth-Token']).toBe('yuque-secret-token');
    expect(transport.requests[0]?.url).toBe('https://yuque.example.test/api/v2/repos/41/toc');

    const reposTransport = new ConnectorTransport([
      response(200, { data: [{ id: 41, name: 'Knowledge' }] }),
    ]);
    const repos = new YuqueHttpDelegate({
      baseUrl: 'https://yuque.example.test',
      transport: reposTransport,
    });
    await repos.listRepos({
      userId: 'user',
      offset: 0,
      credentials: { provider: 'yuque', userId: 'user', token: 'yuque-secret-token' },
      context,
    });
    expect(reposTransport.requests[0]?.url).toContain('offset=0');
    expect(reposTransport.requests[0]?.url).toContain('limit=100');
  });

  it('DingTalk caches the app token, follows nextToken, and imports only online documents', async () => {
    const transport = new ConnectorTransport([
      response(200, { accessToken: 'ding-token', expireIn: 7200 }),
      response(200, {
        result: {
          nodes: [
            { nodeId: 'doc-node', name: 'Runbook', type: 'document', extension: 'adoc' },
            { nodeId: 'folder-node', name: 'Folder', type: 'folder' },
          ],
          nextToken: 'next-node',
        },
      }),
      response(200, { nodeId: 'doc-node', name: 'Runbook', type: 'document', extension: 'adoc' }),
      response(200, {
        blocks: [{ blockType: 'paragraph', markdown: '# Runbook' }],
      }),
    ]);
    const delegate = new DingtalkHttpDelegate({
      baseUrl: 'https://api.dingtalk.com',
      transport,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const config = {
      provider: 'dingtalk' as const,
      operatorId: 'operator',
      workspaceId: 'workspace',
      rootNodeId: 'root-node',
    };
    const credentials = {
      provider: 'dingtalk' as const,
      appKey: 'ding-app',
      appSecret: 'ding-secret',
      userId: 'user',
    };
    const catalog = await delegate.catalog({
      provider: 'dingtalk',
      config,
      credentials,
      rootId: 'root-node',
      context,
    });
    expect(catalog.nextCursor).toBe('next-node');
    expect(catalog.items).toContainEqual({
      id: 'wiki:workspace/node:doc-node/doc:doc-node',
      name: 'Runbook',
      type: 'document',
    });
    expect(transport.requests[1]?.url).toContain('maxResults=100');
    expect(transport.requests[1]?.url).toContain('operatorId=operator');
    expect(transport.requests[1]?.headers['x-acs-dingtalk-access-token']).toBe('ding-token');

    const content = await delegate.content({
      provider: 'dingtalk',
      config,
      credentials,
      externalIds: ['wiki:workspace/node:doc-node/doc:doc-node'],
      context,
    });
    expect(content[0]?.title).toBe('Runbook');
    expect(content[0]?.bytes.toString('utf8')).toBe('# Runbook');
    expect(
      transport.requests.filter((request) => request.url.endsWith('/accessToken')),
    ).toHaveLength(1);
  });

  it('provider input preflight emits safe field names only and returns BLOCKED for gaps', () => {
    const env = {
      PATH: process.env.PATH ?? '',
      S11_PROVIDER_MODE: 'real',
      S11_SCOPE_PROFILE: 'knowledge-usability-v1',
      S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL: 'https://aiproxy.example.test/secret-query?token=hidden',
      AIPROXY_API_TOKEN: 'aiproxy-secret-value',
      S11_AIPROXY_LLM_MODEL: 'llm-real',
      S11_AIPROXY_EMBEDDING_MODEL: 'embedding-real',
      S11_AIPROXY_RERANK_MODEL: 'rerank-real',
      S11_AIPROXY_VLM_MODEL: 'vlm-real',
      S11_AIPROXY_VISION_EMBEDDING_MODEL: 'vision-real',
      S11_OCR_SANGFOR_PROFILE_JSON: JSON.stringify(OCR_PROFILES.sangfor),
      S11_OCR_SOMARK_PROFILE_JSON: JSON.stringify(OCR_PROFILES.somark),
      S11_OCR_TEXTIN_PROFILE_JSON: JSON.stringify(OCR_PROFILES.textin),
      S11_OCR_DOC2X_PROFILE_JSON: JSON.stringify(OCR_PROFILES.doc2x),
      S11_FEISHU_APP_ID: 'feishu-app',
      S11_FEISHU_APP_SECRET: 'feishu-secret',
      S11_FEISHU_FOLDER_TOKEN: 'feishu-folder',
      S11_FEISHU_DOC_1: 'feishu-doc-1',
      S11_FEISHU_DOC_2: 'feishu-doc-2',
      S11_YUQUE_USER_ID: 'yuque-user',
      S11_YUQUE_TOKEN: 'yuque-secret',
      S11_YUQUE_BASE_URL: 'https://yuque.example.test',
      S11_YUQUE_BASE_PATH: '/engineering',
      S11_YUQUE_REPO_ID: 'repo-1',
      S11_YUQUE_TOC_ID: 'toc-1',
      S11_YUQUE_DOC_1: 'doc-1',
      S11_YUQUE_DOC_2: 'doc-2',
      S11_DINGTALK_APP_KEY: 'ding-app',
      S11_DINGTALK_APP_SECRET: 'ding-secret',
      S11_DINGTALK_USER_ID: 'ding-user',
      S11_DINGTALK_OPERATOR_ID: 'ding-operator',
      S11_DINGTALK_WORKSPACE_ID: 'ding-workspace',
      S11_DINGTALK_ROOT_NODE_ID: 'ding-root',
      S11_DINGTALK_DOC_1: 'ding-doc-1',
      S11_DINGTALK_DOC_2: 'ding-doc-2',
    };
    const inputScript = resolve(root, 'scripts/check-provider-inputs.mjs');
    const ready = spawnSync(process.execPath, [inputScript, '--json'], {
      encoding: 'utf8',
      env,
    });
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain('"status": "READY"');
    expect(ready.stdout).toContain('"scopeProfile": "knowledge-usability-v1"');
    expect(ready.stdout).toContain('"status": "DEFERRED_BY_SCOPE"');
    for (const secret of ['aiproxy-secret-value', 'feishu-secret', 'yuque-secret', 'ding-secret']) {
      expect(`${ready.stdout}${ready.stderr}`).not.toContain(secret);
    }
    expect(`${ready.stdout}${ready.stderr}`).not.toContain('token=hidden');
  });

  it('provider preflight exits 2 with PROVIDER_BLOCKED', () => {
    const inputScript = resolve(root, 'scripts/check-provider-inputs.mjs');
    const blocked = spawnSync(process.execPath, [inputScript, '--json'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('PROVIDER_BLOCKED');
    expect(blocked.stdout).toContain('S11_PROVIDER_MODE=real');
  });

  it('provider preflight uses SCOPED_BLOCKED for missing in-scope inputs', () => {
    const inputScript = resolve(root, 'scripts/check-provider-inputs.mjs');
    const blocked = spawnSync(process.execPath, [inputScript, '--json'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        S11_PROVIDER_MODE: 'real',
        S11_SCOPE_PROFILE: 'knowledge-usability-v1',
      },
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('SCOPED_BLOCKED');
    expect(blocked.stdout).toContain('S11_FEISHU_FOLDER_TOKEN');
    expect(blocked.stdout).toContain('S11_AIPROXY_MODEL_MAPPING_APPROVED');
  });
});
