import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../sdk/storage/src/index';
import { FeishuHttpDelegate } from '../../packages/service/src/modules/knowledge/adapter/connectors/feishu-http.delegate';
import { KnowledgeCredentialCipher } from '../../packages/service/src/modules/knowledge/adapter/credential-cipher';
import { KnowledgeIngestionContentAdapter } from '../../packages/service/src/modules/knowledge/adapter/ingestion-content';
import { KnowledgeConnectorSyncApplication } from '../../packages/service/src/modules/knowledge/application/s06-connector-sync.application';
import { KnowledgeConnectorRepository } from '../../packages/service/src/modules/knowledge/repository/connector.repository';
import { KnowledgeImportRepository } from '../../packages/service/src/modules/knowledge/repository/import.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { apiHeaders, createSpace, requiredEnv, startS4App } from '../e2e/s4-app-harness';
import {
  B09FeishuResourceManager,
  missingFeishuEnvironment,
  safeEndpointPath,
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
  it('L1-B09-ING-007-Q01 redacts nested docx resource identifiers from evidence paths', () => {
    const safe = safeEndpointPath(
      'https://open.feishu.cn/open-apis/docx/v1/documents/doc_private/blocks/block_private/children?document_revision_id=-1',
    );

    expect(safe).toBe('/open-apis/docx/v1/documents/:documentId/blocks/:blockId/children');
    expect(safe).not.toContain('doc_private');
    expect(safe).not.toContain('block_private');
  });

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
      let objectStore: MinioKnowledgeObjectStore | undefined;
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
        const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
        objectStore = new MinioKnowledgeObjectStore({
          provider: 'minio',
          endPoint: endpoint.hostname,
          port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
          useSSL: endpoint.protocol === 'https:',
          accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
          secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
          region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
          bucket: requiredEnv('KB_TEST_S3_BUCKET'),
        });
        await objectStore.ensureBucket({
          workspaceId,
          knowledgeSpaceId: spaceId,
          requestId: context.requestId,
          traceId: context.traceId,
        });
        const productContext: TenantContext = {
          ...context,
          workspaceId,
          memberId,
          requestId: `req_b09_real_${suffix}`,
          traceId: safeSha256(`trace:${suffix}`),
        };
        const syncApplication = new KnowledgeConnectorSyncApplication({
          connectors: new KnowledgeConnectorRepository(
            connection,
            new KnowledgeCredentialCipher(`s4-e2e-credential-key-${suffix}-value`),
          ),
          gateway: delegate,
          content: new KnowledgeIngestionContentAdapter(objectStore),
          imports: new KnowledgeImportRepository(connection),
        });

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
        const runQueuedSync = async (label: string) => {
          const response = await fetch(
            `${app.baseUrl}/v1/knowledge/connectors/${connected.data.id}/sync`,
            {
              method: 'POST',
              headers: {
                ...apiHeaders({
                  authToken,
                  workspaceId,
                  idempotencyKey: `b09-real-sync-${label}-${suffix}`,
                }),
                'content-type': 'application/json',
              },
              body: JSON.stringify({ full: true }),
            },
          );
          expect(response.status).toBe(202);
          const payload = (await response.json()) as {
            data: { jobId: string; kind: string; status: string };
          };
          expect(payload.data).toMatchObject({ kind: 'sync', status: 'queued' });
          const result = await syncApplication.discover(
            {
              jobId: payload.data.jobId,
              connectorId: connected.data.id,
              full: true,
            },
            productContext,
          );
          await syncApplication.complete(
            {
              connectorId: connected.data.id,
              success: true,
            },
            productContext,
          );
          return { payload, result };
        };

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

        const initialSync = await runQueuedSync('initial');
        expect(initialSync.result.sourceCount).toBe(2);

        const renamedTitle = `${provisioned.runId}-mutate-renamed`;
        await resources.renameMutateDocument(renamedTitle);
        const renamedContent = await delegate.content({
          provider: 'feishu',
          config,
          credentials,
          externalIds: [`feishu:docx:${provisioned.mutateDocumentToken}`],
          context,
        });
        expect(renamedContent[0]?.title).toBe(renamedTitle);
        const renamedHash = safeSha256(renamedContent[0]!.bytes);
        const renamedSync = await runQueuedSync('rename');
        expect(renamedSync.result.sourceCount).toBe(2);
        const renamedSource = await connection.models.KnowledgeSource.findOne({
          workspaceId,
          connectorId: connected.data.id,
          externalId: `feishu:docx:${provisioned.mutateDocumentToken}`,
          deletedAt: null,
        }).lean();
        expect(renamedSource?.name).toBe(renamedTitle);

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
        expect(safeSha256(secondContent[0]!.bytes)).toBe(renamedHash);
        const movedSync = await runQueuedSync('move');
        expect(movedSync.result.sourceCount).toBe(2);
        const movedSource = await connection.models.KnowledgeSource.findOne({
          workspaceId,
          connectorId: connected.data.id,
          externalId: `feishu:docx:${provisioned.mutateDocumentToken}`,
          deletedAt: null,
        }).lean();
        expect(movedSource?.metadata).toMatchObject({
          providerParentId: `feishu:folder:${provisioned.nestedFolderToken}`,
        });

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
        const deletedSync = await runQueuedSync('delete');
        expect(deletedSync.result.sourceCount).toBe(1);
        const deletedSource = await connection.models.KnowledgeSource.findOne({
          workspaceId,
          connectorId: connected.data.id,
          externalId: `feishu:docx:${provisioned.mutateDocumentToken}`,
          deletedAt: null,
        }).lean();
        const keptSource = await connection.models.KnowledgeSource.findOne({
          workspaceId,
          connectorId: connected.data.id,
          externalId: `feishu:docx:${provisioned.keepDocumentToken}`,
          deletedAt: null,
        }).lean();
        const deleteJobs = await connection.models.KnowledgeJob.find({
          workspaceId,
          kind: 'delete',
          'inputSnapshot.sourceIds': String(deletedSource?._id ?? ''),
        }).lean();
        expect(deletedSource?.processingStatus).toBe('deleting');
        expect(keptSource?.processingStatus).not.toBe('deleting');
        expect(deleteJobs).toHaveLength(1);

        await writeB09ProviderEvidence(evidenceDir, 't01-feishu-lifecycle.json', {
          status: 'REAL_VERIFIED',
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
          productSyncProcessing: 'REAL_SYNC_APPLICATION_COMPLETED',
          productSync: {
            initial: {
              jobId: initialSync.payload.data.jobId,
              sourceCount: initialSync.result.sourceCount,
            },
            renamed: {
              jobId: renamedSync.payload.data.jobId,
              sourceCount: renamedSync.result.sourceCount,
            },
            moved: {
              jobId: movedSync.payload.data.jobId,
              sourceCount: movedSync.result.sourceCount,
            },
            deleted: {
              jobId: deletedSync.payload.data.jobId,
              sourceCount: deletedSync.result.sourceCount,
              deleteJobCount: deleteJobs.length,
            },
          },
        });
      } finally {
        const cleanup = await resources.cleanup();
        await writeB09ProviderEvidence(evidenceDir, 'cleanup.json', cleanup);
        await app?.close();
        if (connection && productWorkspaceId) {
          if (objectStore) {
            const refs = await connection.models.KnowledgeObjectRef.find({
              workspaceId: productWorkspaceId,
            }).lean();
            for (const ref of refs) {
              await objectStore
                .deleteObject(ref.objectKey, {
                  workspaceId: productWorkspaceId,
                  knowledgeSpaceId: String(ref.knowledgeSpaceId),
                  requestId: context.requestId,
                  traceId: context.traceId,
                })
                .catch(() => undefined);
            }
          }
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
