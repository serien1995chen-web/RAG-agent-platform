import { describe, expect, it } from 'vitest';
import {
  MockCloudConnectorClient,
  classifyCloudProviderChange,
} from '../../packages/service/src/modules/knowledge/adapter/connectors/common';
import { DingtalkConnectorClient } from '../../packages/service/src/modules/knowledge/adapter/connectors/dingtalk';
import { FeishuConnectorClient } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu';
import { FeishuHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu-http.delegate';
import type {
  S11ConnectorHttpRequest,
  S11ConnectorHttpResponse,
  S11ConnectorHttpTransport,
} from '../../packages/service/src/modules/knowledge/adapter/connectors/s11-connector-http';
import { YuqueConnectorClient } from '../../packages/service/src/modules/knowledge/adapter/connectors/yuque';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s4_provider_contract',
  memberId: 'mem_s4_provider_contract',
  requestId: 'req_s4_provider_contract',
  traceId: 'trace_s4_provider_contract',
  scopes: ['knowledge:write'],
};

describe('TEST-ING-007/008/009 cloud provider contract fixtures', () => {
  it('TEST-ING-007-BLOCK pages Feishu twice and refreshes an expired token once', async () => {
    const delegate = new MockCloudConnectorClient();
    const client = new FeishuConnectorClient(delegate);
    const input = {
      config: { provider: 'feishu', folderToken: 'folder' },
      credentials: {
        provider: 'feishu',
        appId: 'app',
        appSecret: 'secret',
        accessToken: 'expired',
      },
      rootId: 'root',
      context,
    };
    const first = await client.catalog(input);
    const second = await client.catalog({ ...input, cursor: first.nextCursor ?? undefined });
    expect(first.items.map((item) => item.id)).toEqual(['fld_support', 'doc_a']);
    expect(second.items.map((item) => item.id)).toEqual(['doc_b']);
    expect(second.nextCursor).toBeNull();
    expect(client.tokenRefreshCount).toBe(1);
  });

  it('TEST-ING-008-BLOCK reads Yuque repo/toc/doc composite IDs and classifies changes', async () => {
    const client = new YuqueConnectorClient();
    const content = await client.content({
      config: { provider: 'yuque' },
      credentials: { provider: 'yuque', userId: 'u', token: 't' },
      externalIds: ['repo:eng/toc:1/doc:arch'],
      context,
    });
    expect(content[0]).toMatchObject({
      externalId: 'repo:eng/toc:1/doc:arch',
      title: 'Architecture',
    });
    expect(
      classifyCloudProviderChange('yuque', {
        externalId: 'repo:eng/toc:1/doc:arch',
        nameChanged: true,
      }),
    ).toBe('rename');
    expect(
      classifyCloudProviderChange('yuque', {
        externalId: 'repo:eng/toc:1/doc:arch',
        parentChanged: true,
      }),
    ).toBe('move');
    expect(
      classifyCloudProviderChange('yuque', {
        externalId: 'repo:eng/toc:1/doc:arch',
        providerStatus: 404,
        confirmed: true,
      }),
    ).toBe('delete');
    await expect(
      client.content({
        config: { provider: 'yuque' },
        credentials: { provider: 'yuque', userId: 'u', token: 't' },
        externalIds: ['repo:eng/arch'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('TEST-ING-009-BLOCK imports DingTalk online docs and rejects non-document blocks', async () => {
    const client = new DingtalkConnectorClient();
    await expect(
      client.content({
        config: { provider: 'dingtalk' },
        credentials: { provider: 'dingtalk', appKey: 'k', appSecret: 's', userId: 'u' },
        externalIds: ['wiki:root/node:1/doc:ops'],
        context,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: 'wiki:root/node:1/doc:ops',
        title: 'Operations',
      }),
    ]);
    await expect(
      client.content({
        config: { provider: 'dingtalk' },
        credentials: { provider: 'dingtalk', appKey: 'k', appSecret: 's', userId: 'u' },
        externalIds: ['wiki:root/node:1/block:raw'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(
      classifyCloudProviderChange('dingtalk', {
        externalId: 'wiki:root/node:1/block:raw',
        documentType: 'block',
      }),
    ).toBe('non_document');
  });

  it('TEST-X-CONNECTOR-TOKEN/429/404 maps provider failures without leaking credentials', async () => {
    const client = new MockCloudConnectorClient();
    const feishu = {
      provider: 'feishu' as const,
      config: { provider: 'feishu', folderToken: 'folder' },
      rootId: 'root',
      context,
    };
    await expect(
      client.catalog({
        ...feishu,
        credentials: { provider: 'feishu', accessToken: 'invalid' },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    await expect(
      client.catalog({
        ...feishu,
        credentials: { provider: 'feishu', rateLimited: true },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_RATE_LIMITED' } },
    });
    await expect(
      client.content({
        provider: 'feishu',
        config: { provider: 'feishu', folderToken: 'folder' },
        credentials: { provider: 'feishu', accessToken: 'valid' },
        externalIds: ['missing:doc'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('TEST-X-CONNECTOR-DELETE only classifies a confirmed structured 404 as delete', () => {
    const base = { externalId: 'repo:eng/toc:1/doc:arch' };
    expect(classifyCloudProviderChange('yuque', { ...base, providerStatus: 404 })).toBe('unknown');
    expect(
      classifyCloudProviderChange('yuque', {
        ...base,
        providerStatus: 404,
        confirmed: true,
      }),
    ).toBe('delete');
    expect(
      classifyCloudProviderChange('yuque', {
        ...base,
        action: 'delete',
      }),
    ).toBe('delete');
  });
});

describe('L1-B09 Feishu provider behavior', () => {
  it('L1-B09-ING-007-P02 browses the user-selected folder and exposes pagination identity', async () => {
    const requests: S11ConnectorHttpRequest[] = [];
    const transport: S11ConnectorHttpTransport = {
      async request<T = unknown>(
        request: S11ConnectorHttpRequest,
      ): Promise<S11ConnectorHttpResponse<T>> {
        requests.push(request);
        if (request.url.includes('/tenant_access_token/')) {
          return {
            status: 200,
            headers: {},
            data: {
              code: 0,
              tenant_access_token: 'safe-token',
              expire: 7_200,
            } as T,
          };
        }
        return {
          status: 200,
          headers: {},
          data: {
            code: 0,
            data: {
              files: [
                {
                  token: 'doc_1',
                  name: 'Selected folder document',
                  type: 'docx',
                  parent_token: 'selected-child',
                },
              ],
              has_more: true,
              next_page_token: 'page-2',
            },
          } as T,
        };
      },
    };
    const delegate = new FeishuHttpDelegate({
      transport,
      baseUrl: 'https://feishu.example.test',
      sleep: async () => undefined,
    });

    const result = await delegate.catalog({
      provider: 'feishu',
      config: { provider: 'feishu', folderToken: 'configured-root' },
      credentials: {
        provider: 'feishu',
        appId: 'safe-app-id',
        appSecret: 'safe-app-secret',
      },
      rootId: 'selected-child',
      context,
    });

    const listRequest = requests.find((request) =>
      request.url.includes('/open-apis/drive/v1/files'),
    );
    expect(listRequest).toBeDefined();
    const listUrl = new URL(listRequest!.url);
    expect(listUrl.searchParams.get('folder_token')).toBe('selected-child');
    expect(listUrl.searchParams.get('page_size')).toBe('200');
    expect(result).toMatchObject({
      provider: 'feishu',
      nextCursor: 'page-2',
      items: [
        {
          id: 'feishu:docx:doc_1',
          name: 'Selected folder document',
          type: 'document',
        },
      ],
    });
  });

  it('L1-B09-ING-007-N01 rejects a non-document Feishu external id with a stable unsupported error', async () => {
    const transport: S11ConnectorHttpTransport = {
      async request<T = unknown>(
        request: S11ConnectorHttpRequest,
      ): Promise<S11ConnectorHttpResponse<T>> {
        if (request.url.includes('/tenant_access_token/')) {
          return {
            status: 200,
            headers: {},
            data: {
              code: 0,
              tenant_access_token: 'safe-token',
              expire: 7_200,
            } as T,
          };
        }
        if (request.url.endsWith('/raw_content')) {
          return {
            status: 200,
            headers: {},
            data: { code: 0, data: { content: 'sheet-like content' } } as T,
          };
        }
        return {
          status: 200,
          headers: {},
          data: {
            code: 0,
            data: { document: { title: 'Spreadsheet' } },
          } as T,
        };
      },
    };
    const delegate = new FeishuHttpDelegate({
      transport,
      baseUrl: 'https://feishu.example.test',
      sleep: async () => undefined,
    });

    await expect(
      delegate.content({
        provider: 'feishu',
        config: { provider: 'feishu', folderToken: 'selected-child' },
        credentials: {
          provider: 'feishu',
          appId: 'safe-app-id',
          appSecret: 'safe-app-secret',
        },
        externalIds: ['feishu:sheet:sheet_1'],
        context,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        },
      },
    });
  });
});
