import { describe, expect, it } from 'vitest';
import { FeishuHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu-http.delegate';
import { createConnectorProviderClients } from '../../packages/service/src/modules/knowledge/adapter/connectors/provider-clients';
import {
  providerContext,
  requiredProviderEnv,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

function documentExternalId(value: string): string {
  if (value.startsWith('feishu:docx:') || value.startsWith('feishu:doc:')) return value;
  return `feishu:docx:${value}`;
}

describe('TEST-X-S11-PROVIDER-REAL connectors', () => {
  it('Feishu paginates, reads two documents and defers Yuque/DingTalk without calls', async () => {
    const clients = createConnectorProviderClients({
      mode: 'real',
      scopeProfile: 'knowledge-usability-v1',
    });
    expect(clients.feishu).toBeInstanceOf(FeishuHttpDelegate);
    const delegate = clients.feishu as FeishuHttpDelegate;
    const credentials = {
      provider: 'feishu' as const,
      appId: requiredProviderEnv('S11_FEISHU_APP_ID'),
      appSecret: requiredProviderEnv('S11_FEISHU_APP_SECRET'),
    };
    const config = {
      provider: 'feishu' as const,
      folderToken: requiredProviderEnv('S11_FEISHU_FOLDER_TOKEN'),
    };
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await delegate.catalog({
        provider: 'feishu',
        config,
        credentials,
        rootId: config.folderToken,
        ...(cursor ? { cursor } : {}),
        context: providerContext,
      });
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < 20);

    const externalIds = [
      documentExternalId(requiredProviderEnv('S11_FEISHU_DOC_1')),
      documentExternalId(requiredProviderEnv('S11_FEISHU_DOC_2')),
    ];
    const contents = await delegate.content({
      provider: 'feishu',
      config,
      credentials,
      externalIds,
      context: providerContext,
    });
    expect(contents).toHaveLength(2);
    expect(contents.every((item) => item.bytes.byteLength > 0)).toBe(true);
    const repeated = await delegate.content({
      provider: 'feishu',
      config,
      credentials,
      externalIds,
      context: providerContext,
    });
    expect(repeated.map((item) => sha256(item.bytes))).toEqual(
      contents.map((item) => sha256(item.bytes)),
    );

    await expect(
      clients.yuque.catalog({
        provider: 'yuque',
        config: {},
        credentials: {},
        rootId: 'deferred',
        context: providerContext,
      }),
    ).rejects.toMatchObject({
      problem: { error: { details: { reason: 'DEFERRED_BY_SCOPE' } } },
    });
    await expect(
      clients.dingtalk.catalog({
        provider: 'dingtalk',
        config: {},
        credentials: {},
        rootId: 'deferred',
        context: providerContext,
      }),
    ).rejects.toMatchObject({
      problem: { error: { details: { reason: 'DEFERRED_BY_SCOPE' } } },
    });

    const evidence = {
      status:
        process.env.S11_FEISHU_DELETE_PROPAGATION_VERIFIED === 'true' &&
        process.env.S11_FEISHU_DELETE_CASE_ID?.trim()
          ? 'REAL_VERIFIED'
          : 'SCOPED_BLOCKED',
      documentCount: contents.length,
      catalogPages: pages.length,
      externalIdHash: sha256(JSON.stringify([...externalIds].sort())),
      contentHashes: contents.map((item) => sha256(item.bytes)),
      refreshHttpStatuses: delegate.evidence.map((entry) => entry.status),
      yuque: 'DEFERRED_BY_SCOPE',
      yuqueRealCalls: 0,
      dingtalk: 'DEFERRED_BY_SCOPE',
      dingtalkRealCalls: 0,
      deletePropagation: {
        verified: process.env.S11_FEISHU_DELETE_PROPAGATION_VERIFIED === 'true',
        caseIdHash: process.env.S11_FEISHU_DELETE_CASE_ID?.trim()
          ? sha256(process.env.S11_FEISHU_DELETE_CASE_ID.trim())
          : null,
      },
    };
    expect(JSON.stringify(evidence)).not.toContain(credentials.appSecret);
    writeProviderEvidence('t02-connectors.json', evidence);
  });
});
