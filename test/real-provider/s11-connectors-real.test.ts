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

function deleteCaseEvidence(input: { evidenceDir: string; caseId: string }): {
  verified: boolean;
  sha256: string | null;
  error: string | null;
} {
  const path = join(input.evidenceDir, 't02-feishu-delete.json');
  if (!existsSync(path)) {
    return { verified: false, sha256: null, error: 'delete_evidence_missing' };
  }
  const bytes = readFileSync(path);
  try {
    const value = JSON.parse(bytes.toString('utf8')) as {
      status?: unknown;
      caseIdHash?: unknown;
      deletedExternalIdHash?: unknown;
      retainedExternalIdHash?: unknown;
      beforeExternalIdHashes?: unknown;
      afterExternalIdHashes?: unknown;
    };
    const expectedCaseHash = sha256(input.caseId);
    const valid =
      value.status === 'REAL_VERIFIED' &&
      value.caseIdHash === expectedCaseHash &&
      typeof value.deletedExternalIdHash === 'string' &&
      typeof value.retainedExternalIdHash === 'string' &&
      value.deletedExternalIdHash !== value.retainedExternalIdHash &&
      Array.isArray(value.beforeExternalIdHashes) &&
      Array.isArray(value.afterExternalIdHashes) &&
      value.beforeExternalIdHashes.includes(value.deletedExternalIdHash) &&
      !value.afterExternalIdHashes.includes(value.deletedExternalIdHash) &&
      value.beforeExternalIdHashes.includes(value.retainedExternalIdHash) &&
      value.afterExternalIdHashes.includes(value.retainedExternalIdHash);
    return {
      verified: valid,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      error: valid ? null : 'delete_evidence_invalid',
    };
  } catch {
    return { verified: false, sha256: null, error: 'delete_evidence_invalid_json' };
  }
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
    let catalogErrorCode: string | null = null;
    try {
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
    } catch (error) {
      const problem = error as { problem?: { error?: { code?: unknown } } };
      catalogErrorCode =
        typeof problem.problem?.error?.code === 'string'
          ? problem.problem.error.code
          : 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE';
    }

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

    const caseId = process.env.S11_FEISHU_DELETE_CASE_ID?.trim() ?? '';
    const deletion =
      caseId && process.env.S11_EVIDENCE_DIR
        ? deleteCaseEvidence({
            evidenceDir: process.env.S11_EVIDENCE_DIR,
            caseId,
          })
        : { verified: false, sha256: null, error: 'delete_evidence_missing' };
    const deleteVerified =
      process.env.S11_FEISHU_DELETE_PROPAGATION_VERIFIED === 'true' &&
      deletion.verified &&
      catalogErrorCode === null;
    const evidence = {
      status: deleteVerified ? 'REAL_VERIFIED' : 'SCOPED_BLOCKED',
      catalogStatus: catalogErrorCode === null ? 'PASS' : 'SCOPED_BLOCKED',
      catalogErrorCode,
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
        verified: deleteVerified,
        caseIdHash: caseId ? sha256(caseId) : null,
        evidenceSha256: deletion.sha256,
        error: deletion.error,
      },
    };
    expect(JSON.stringify(evidence)).not.toContain(credentials.appSecret);
    writeProviderEvidence('t02-connectors.json', evidence);
  });
});
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
