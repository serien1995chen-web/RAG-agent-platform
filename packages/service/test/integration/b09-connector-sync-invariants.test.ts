import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeConnectorSyncApplication } from '../../src/modules/knowledge/application/s06-connector-sync.application';
import type { ConnectorChangeSetApplyInput } from '../../src/modules/knowledge/application/s06-connector-sync.application';
import type {
  ConnectorView,
  IngestionContentResult,
  ProviderCatalogResult,
  ProviderContent,
} from '../../src/modules/knowledge/application/ingestion.ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b09_sync_invariant',
  memberId: 'mem_b09_sync_invariant',
  requestId: 'req_b09_sync_invariant',
  traceId: 'trace_b09_sync_invariant',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

function objectId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 24);
}

function sourceOf(content: ProviderContent, connectorId: string): IngestionContentResult {
  return {
    source: {
      id: objectId(),
      kind: 'feishu',
      name: content.title,
      directoryId: null,
      blobRefId: null,
      externalId: content.externalId,
      connectorId,
      mimeType: content.mimeType,
      sizeBytes: content.bytes.byteLength,
      contentHash: createHash('sha256').update(content.bytes).digest('hex'),
      parseProvider: 'liteparse',
      metadata: {},
    },
    createdObjectKey: null,
  };
}

describe('L1-B09 connector sync invariants', () => {
  it('L1-B09-ING-007-P02/S01 completes recursive traversal before committing the cursor', async () => {
    const connectorId = objectId();
    const connector: ConnectorView = {
      id: connectorId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: objectId(),
      provider: 'feishu',
      name: 'B09 nested Feishu',
      status: 'active',
      syncEnabled: true,
      syncIntervalMinutes: 60,
      nextSyncAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      cursorVersion: 1,
      version: 1,
      config: { provider: 'feishu', folderToken: 'root-folder' },
      credentialMetadata: {
        provider: 'feishu',
        schemaVersion: 1,
        keyVersion: 1,
        configured: true,
        redactedFields: ['appSecret'],
      },
    };
    const catalogCalls: string[] = [];
    const contentCalls: string[][] = [];
    const apply = vi.fn(async (input: ConnectorChangeSetApplyInput) => ({
      sourceIds: input.sources.map((material: IngestionContentResult) => material.source.id),
      sourceVersions: Object.fromEntries(
        input.sources.map((material: IngestionContentResult) => [material.source.id, 1]),
      ),
      cursorVersion: input.expectedCursorVersion + 1,
      sourceCount: input.sources.length,
      changeSetHash: input.changeSetHash,
      replayed: false,
      obsoleteObjectKeys: [],
    }));
    const application = new KnowledgeConnectorSyncApplication({
      connectors: {
        async get() {
          return connector;
        },
        async decryptCredentials() {
          return {
            provider: 'feishu',
            appId: 'safe-app',
            appSecret: 'safe-secret',
          };
        },
        async getSyncCursor() {
          return {
            cursor: {},
            cursorVersion: 1,
            syncRunId: null,
            lastChangeSetHash: '',
          };
        },
        async completeSync() {
          return undefined;
        },
      },
      gateway: {
        async catalog(input): Promise<ProviderCatalogResult> {
          catalogCalls.push(input.rootId);
          if (input.rootId === 'root-folder') {
            return {
              provider: 'feishu',
              items: [
                { id: 'folder:nested', name: 'Nested', type: 'directory' },
                { id: 'feishu:docx:root', name: 'Root', type: 'document' },
              ],
              nextCursor: null,
            };
          }
          if (input.rootId === 'folder:nested') {
            return {
              provider: 'feishu',
              items: [
                {
                  id: 'feishu:docx:nested',
                  name: 'Nested document',
                  type: 'document',
                },
              ],
              nextCursor: null,
            };
          }
          return { provider: 'feishu', items: [], nextCursor: null };
        },
        async content(input): Promise<ProviderContent[]> {
          contentCalls.push([...input.externalIds]);
          return input.externalIds.map((externalId) => ({
            externalId,
            title: externalId,
            mimeType: 'text/markdown',
            bytes: Buffer.from(`body:${externalId}`),
          }));
        },
      },
      content: {
        async materializeProviderContent(input) {
          return sourceOf(input.content, connectorId);
        },
        async compensate() {
          return undefined;
        },
      },
      imports: {
        async replayConnectorSync() {
          return null;
        },
        applyConnectorChangeSet: apply,
      },
    });

    const result = await application.discover(
      { jobId: objectId(), connectorId, full: true },
      context,
    );

    expect(catalogCalls).toEqual(expect.arrayContaining(['root-folder', 'folder:nested']));
    expect(contentCalls.flat()).toEqual(
      expect.arrayContaining(['feishu:docx:root', 'feishu:docx:nested']),
    );
    expect(result.sourceCount).toBe(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0].sources).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          externalId: 'feishu:docx:nested',
          metadata: expect.objectContaining({
            providerParentId: 'folder:nested',
          }),
        }),
      }),
    );
  });
});
