import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeishuHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu-http.delegate';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { apiHeaders, createSpace, requiredEnv, startS4App } from '../e2e/s4-app-harness';
import {
  B09FeishuResourceManager,
  missingFeishuEnvironment,
  safeSha256,
  writeB09ProviderEvidence,
} from './b09-feishu-resources';

const context: TenantContext = {
  workspaceId: 'ws_b09_real_provider',
  memberId: 'mem_b09_real_provider',
  requestId: 'req_b09_real_provider',
  traceId: 'trace_b09_real_provider',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};
const missing = missingFeishuEnvironment();
const evidenceDir =
  process.env.S11_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), 'test-results', 'b09', '20261115-140502', 'provider');

describe('L1-B09 ING-007 real Feishu lifecycle', () => {
  it('L1-B09-ING-007-Q01 records provider input readiness without making unsafe calls', async () => {
    const status = missing.length === 0 ? 'REAL_INPUT_READY' : 'BLOCKED_PROVIDER';
    await writeB09ProviderEvidence(evidenceDir, 'preflight.json', {
      status,
      missing,
      credentialsPrinted: false,
      realCalls: 0,
    });
    if (status === 'BLOCKED_PROVIDER') {
      expect(missing.length).toBeGreaterThan(0);
    } else {
      expect(missing).toEqual([]);
    }
  });

  it.skipIf(missing.length > 0)(
    'L1-B09-ING-007-P01/Q01 creates isolated copies, verifies content identity and consumes rename/move/delete',
    async () => {
      const resources = new B09FeishuResourceManager();
      let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>> | undefined;
      let app: Awaited<ReturnType<typeof startS4App>> | undefined;
      let productWorkspaceId: string | undefined;
      try {
        const provisioned = await resources.provision();
        const delegate = new FeishuHttpDelegate({ sleep: async () => undefined });
        const credentials = {
          provider: 'feishu' as const,
          appId: process.env.S11_FEISHU_APP_ID!,
          appSecret: process.env.S11_FEISHU_APP_SECRET!,
        };
        const config = {
          provider: 'feishu' as const,
          folderToken: provisioned.rootFolderToken,
        };
        const root = await delegate.catalog({
          provider: 'feishu',
          config,
          credentials,
          rootId: provisioned.rootFolderToken,
          context,
        });
        expect(root.items.some((item) => item.type === 'directory')).toBe(true);
        expect(root.items.filter((item) => item.type === 'document')).toHaveLength(2);

        const externalIds = [
          `feishu:docx:${provisioned.keepDocumentToken}`,
          `feishu:docx:${provisioned.mutateDocumentToken}`,
        ];
        const firstContent = await delegate.content({
          provider: 'feishu',
          config,
          credentials,
          externalIds,
          context,
        });
        expect(firstContent.map((item) => item.externalId).sort()).toEqual([...externalIds].sort());
        const firstHashes = firstContent.map((item) => safeSha256(item.bytes)).sort();
        expect(new Set(firstHashes).size).toBe(2);
        const firstHashesByExternalId = new Map(
          firstContent.map((item) => [item.externalId, safeSha256(item.bytes)]),
        );

        const suffix = randomSuffix(provisioned.runId);
        const workspaceId = `ws_b09_real_${suffix}`;
        productWorkspaceId = workspaceId;
        const memberId = `mem_b09_real_${suffix}`;
        const authToken = `b09-real-token-${suffix}`;
        app = await startS4App({
          suffix,
          workspaceId,
          memberId,
          authToken,
          connectorMode: 'real',
        });
        const spaceId = await createSpace({
          baseUrl: app.baseUrl,
          authToken,
          workspaceId,
          suffix,
        });
        connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
        registerKnowledgeModels(connection);

        const connectResponse = await fetch(
          `${app.baseUrl}/v1/knowledge/spaces/${spaceId}/connectors/feishu/connect`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders({
                authToken,
                workspaceId,
                idempotencyKey: `b09-real-connect-${suffix}`,
              }),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              provider: 'feishu',
              name: `B09 real ${provisioned.runId}`,
              credentials,
              config,
              syncEnabled: true,
              syncIntervalMinutes: 60,
            }),
          },
        );
        expect(connectResponse.status).toBe(201);
        const connected = (await connectResponse.json()) as {
          data: { id: string };
        };
        expect(JSON.stringify(connected)).not.toContain(process.env.S11_FEISHU_APP_SECRET!);

        const importResponse = await fetch(
          `${app.baseUrl}/v1/knowledge/spaces/${spaceId}/connectors/feishu/import`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders({
                authToken,
                workspaceId,
                idempotencyKey: `b09-real-import-${suffix}`,
              }),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              externalIds: [...externalIds],
              directoryId: null,
            }),
          },
        );
        expect(importResponse.status).toBe(202);
        const importPayload = (await importResponse.json()) as {
          data: { jobId: string; kind: string; status: string };
        };
        expect(importPayload.data).toMatchObject({ kind: 'import', status: 'queued' });
        const sources = await connection.models.KnowledgeSource.find({
          workspaceId,
          connectorId: connected.data.id,
          deletedAt: null,
        }).lean();
        expect(sources.map((source) => source.externalId).sort()).toEqual([...externalIds].sort());

        const syncResponse = await fetch(
          `${app.baseUrl}/v1/knowledge/connectors/${connected.data.id}/sync`,
          {
            method: 'POST',
            headers: {
              ...apiHeaders({
                authToken,
                workspaceId,
                idempotencyKey: `b09-real-sync-${suffix}`,
              }),
              'content-type': 'application/json',
            },
            body: JSON.stringify({ full: true }),
          },
        );
        expect(syncResponse.status).toBe(202);
        expect(await syncResponse.json()).toMatchObject({
          data: { kind: 'sync', status: 'queued' },
        });

        await resources.renameMutateDocument(`${provisioned.runId}-mutate-renamed`);
        await resources.moveMutateDocument();
        const nested = await delegate.catalog({
          provider: 'feishu',
          config: { ...config, folderToken: provisioned.nestedFolderToken },
          credentials,
          rootId: provisioned.nestedFolderToken,
          context,
        });
        expect(nested.items).toContainEqual(
          expect.objectContaining({
            id: `feishu:docx:${provisioned.mutateDocumentToken}`,
          }),
        );

        const secondContent = await delegate.content({
          provider: 'feishu',
          config: { ...config, folderToken: provisioned.nestedFolderToken },
          credentials,
          externalIds: [`feishu:docx:${provisioned.mutateDocumentToken}`],
          context,
        });
        expect(safeSha256(secondContent[0]!.bytes)).toBe(
          firstHashesByExternalId.get(`feishu:docx:${provisioned.mutateDocumentToken}`),
        );

        await resources.deleteMutateDocument();
        const nestedAfterDelete = await delegate.catalog({
          provider: 'feishu',
          config: { ...config, folderToken: provisioned.nestedFolderToken },
          credentials,
          rootId: provisioned.nestedFolderToken,
          context,
        });
        expect(
          nestedAfterDelete.items.some(
            (item) => item.id === `feishu:docx:${provisioned.mutateDocumentToken}`,
          ),
        ).toBe(false);
        const rootAfterDelete = await delegate.catalog({
          provider: 'feishu',
          config,
          credentials,
          rootId: provisioned.rootFolderToken,
          context,
        });
        expect(
          rootAfterDelete.items.some(
            (item) => item.id === `feishu:docx:${provisioned.keepDocumentToken}`,
          ),
        ).toBe(true);

        await writeB09ProviderEvidence(evidenceDir, 't01-feishu-lifecycle.json', {
          status: 'PARTIAL_DEPENDENCY',
          runId: provisioned.runId,
          providerCalls: resources.evidence,
          externalIdsSha256: safeSha256(JSON.stringify([...externalIds].sort())),
          contentHashes: firstHashes,
          retainedDocument: safeSha256(provisioned.keepDocumentToken),
          deletedDocument: safeSha256(provisioned.mutateDocumentToken),
          productImport: {
            status: 'REAL_REQUEST_ACCEPTED',
            jobKind: importPayload.data.kind,
            sourceCount: sources.length,
          },
          productSyncProcessing: 'NOT_RUN_WORKER',
        });
      } finally {
        const cleanup = await resources.cleanup();
        await writeB09ProviderEvidence(evidenceDir, 'cleanup.json', cleanup);
        await app?.close();
        if (connection && productWorkspaceId) {
          for (const model of Object.values(registerKnowledgeModels(connection))) {
            await model.deleteMany({ workspaceId: productWorkspaceId });
          }
          await connection.close();
        }
        expect(cleanup).toEqual({ complete: true, failures: [] });
      }
    },
    120_000,
  );
});

function randomSuffix(value: string): string {
  return safeSha256(value).slice(0, 12);
}
