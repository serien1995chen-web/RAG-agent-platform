import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  ConnectorView,
  IngestionContentResult,
  ProviderCatalogResult,
  ProviderContent,
} from './ingestion.ports';
import type { S6ConnectorSyncPort, S6ConnectorSyncResult } from './s06-processing-ports';

type CloudProvider = 'feishu' | 'yuque' | 'dingtalk';

interface ConnectorCursorView {
  cursor: Record<string, unknown>;
  cursorVersion: number;
  syncRunId: string | null;
  lastChangeSetHash: string;
}

interface ConnectorSyncConnectorPort {
  get(connectorId: string, context: TenantContext): Promise<ConnectorView>;
  decryptCredentials(connectorId: string, context: TenantContext): Promise<Record<string, unknown>>;
  getSyncCursor(
    connectorId: string,
    externalRootId: string,
    context: TenantContext,
  ): Promise<ConnectorCursorView | null>;
  completeSync(
    input: {
      connectorId: string;
      success: boolean;
      errorCode?: string;
    },
    context: TenantContext,
  ): Promise<void>;
}

interface ConnectorSyncGatewayPort {
  catalog(input: {
    provider: CloudProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult>;
  content(input: {
    provider: CloudProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]>;
}

interface ConnectorSyncContentPort {
  materializeProviderContent(input: {
    kind: CloudProvider;
    knowledgeSpaceId: string;
    directoryId: null;
    connectorId: string;
    content: ProviderContent;
    context: TenantContext;
  }): Promise<IngestionContentResult>;
  compensate(objectKey: string, knowledgeSpaceId: string, context: TenantContext): Promise<void>;
}

export interface ConnectorChangeSetApplyInput {
  connectorId: string;
  knowledgeSpaceId: string;
  externalRootId: string;
  provider: CloudProvider;
  syncRunId: string;
  expectedCursorVersion: number;
  changeSetHash: string;
  cursor: Record<string, unknown>;
  sources: IngestionContentResult[];
}

export interface ConnectorChangeSetApplyResult extends S6ConnectorSyncResult {
  obsoleteObjectKeys: string[];
}

interface ConnectorSyncImportPort {
  replayConnectorSync(
    input: {
      connectorId: string;
      knowledgeSpaceId: string;
      syncRunId: string;
    },
    context: TenantContext,
  ): Promise<S6ConnectorSyncResult | null>;
  applyConnectorChangeSet(
    input: ConnectorChangeSetApplyInput,
    context: TenantContext,
  ): Promise<ConnectorChangeSetApplyResult>;
}

function providerOf(value: string, context: TenantContext): CloudProvider {
  if (value === 'feishu' || value === 'yuque' || value === 'dingtalk') return value;
  throw createKnowledgeError({
    code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider: value, operation: 'sync' },
  });
}

function rootIdOf(
  provider: CloudProvider,
  config: Record<string, unknown>,
  context: TenantContext,
): string {
  const candidate =
    provider === 'feishu'
      ? config.folderToken
      : provider === 'yuque'
        ? (config.repoId ?? config.rootId ?? config.groupId)
        : (config.rootId ?? config.wikiRootId ?? config.spaceId);
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  throw createKnowledgeError({
    code: 'KNOWLEDGE_PROVIDER_CONFIG_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { provider, field: 'syncRootId' },
  });
}

function pageCursorOf(cursor: ConnectorCursorView | null): string | undefined {
  const page = cursor?.cursor.page;
  return typeof page === 'string' && page.trim() ? page : undefined;
}

function changeSetHashOf(input: {
  provider: CloudProvider;
  externalRootId: string;
  cursor?: string;
  documents: ProviderContent[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: input.provider,
        externalRootId: input.externalRootId,
        cursor: input.cursor ?? null,
        documents: input.documents
          .map((document) => ({
            externalId: document.externalId,
            title: document.title,
            mimeType: document.mimeType,
            bytesHash: createHash('sha256').update(document.bytes).digest('hex'),
          }))
          .sort((left, right) => left.externalId.localeCompare(right.externalId)),
      }),
    )
    .digest('hex');
}

export class KnowledgeConnectorSyncApplication implements S6ConnectorSyncPort {
  constructor(
    private readonly input: {
      connectors: ConnectorSyncConnectorPort;
      gateway: ConnectorSyncGatewayPort;
      content: ConnectorSyncContentPort;
      imports: ConnectorSyncImportPort;
    },
  ) {}

  async discover(
    input: { jobId: string; connectorId: string; full: boolean },
    context: TenantContext,
  ): Promise<S6ConnectorSyncResult> {
    const connector = await this.input.connectors.get(input.connectorId, context);
    const provider = providerOf(connector.provider, context);
    const externalRootId = rootIdOf(provider, connector.config, context);
    const cursor = await this.input.connectors.getSyncCursor(
      input.connectorId,
      externalRootId,
      context,
    );
    const replay = await this.input.imports.replayConnectorSync(
      {
        connectorId: input.connectorId,
        knowledgeSpaceId: connector.knowledgeSpaceId,
        syncRunId: input.jobId,
      },
      context,
    );
    if (replay) return replay;

    const credentials = await this.input.connectors.decryptCredentials(input.connectorId, context);
    const pageCursor = input.full ? undefined : pageCursorOf(cursor);
    const page = await this.input.gateway.catalog({
      provider,
      config: connector.config,
      credentials,
      rootId: externalRootId,
      ...(pageCursor ? { cursor: pageCursor } : {}),
      context,
    });
    if (page.items.length > 200) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { provider, pageSize: page.items.length, max: 200 },
      });
    }
    const externalIds = [
      ...new Set(
        page.items
          .filter((item) => item.type === 'document')
          .map((item) => item.id)
          .filter(Boolean),
      ),
    ];
    const documents =
      externalIds.length === 0
        ? []
        : await this.input.gateway.content({
            provider,
            config: connector.config,
            credentials,
            externalIds,
            context,
          });
    const changeSetHash = changeSetHashOf({
      provider,
      externalRootId,
      ...(pageCursor ? { cursor: pageCursor } : {}),
      documents,
    });
    const materialized: IngestionContentResult[] = [];
    try {
      for (const document of documents) {
        materialized.push(
          await this.input.content.materializeProviderContent({
            kind: provider,
            knowledgeSpaceId: connector.knowledgeSpaceId,
            directoryId: null,
            connectorId: input.connectorId,
            content: document,
            context,
          }),
        );
      }
      const applied = await this.input.imports.applyConnectorChangeSet(
        {
          connectorId: input.connectorId,
          knowledgeSpaceId: connector.knowledgeSpaceId,
          externalRootId,
          provider,
          syncRunId: input.jobId,
          expectedCursorVersion: connector.cursorVersion,
          changeSetHash,
          cursor: { page: page.nextCursor ?? null },
          sources: materialized,
        },
        context,
      );
      for (const objectKey of applied.obsoleteObjectKeys) {
        await this.input.content.compensate(objectKey, connector.knowledgeSpaceId, context);
      }
      return applied;
    } catch (error) {
      for (const material of materialized) {
        if (!material.createdObjectKey) continue;
        await this.input.content
          .compensate(material.createdObjectKey, connector.knowledgeSpaceId, context)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async complete(
    input: { connectorId: string; success: boolean; errorCode?: string },
    context: TenantContext,
  ): Promise<void> {
    await this.input.connectors.completeSync(input, context);
  }
}
