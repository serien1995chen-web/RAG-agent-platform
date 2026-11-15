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
  fullTraversalCompleted: boolean;
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

function changeSetHashOf(input: {
  provider: CloudProvider;
  externalRootId: string;
  documents: ProviderContent[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: input.provider,
        externalRootId: input.externalRootId,
        documents: input.documents
          .map((document) => ({
            externalId: document.externalId,
            title: document.title,
            mimeType: document.mimeType,
            providerParentId: document.providerParentId ?? null,
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

  private async traverseCatalog(input: {
    provider: CloudProvider;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    context: TenantContext;
  }): Promise<{
    documents: Array<{ externalId: string; providerParentId: string | null }>;
    cursor: Record<string, unknown>;
  }> {
    const pending = [input.rootId];
    const visitedDirectories = new Set<string>();
    const documentParents = new Map<string, string | null>();
    let visitedPages = 0;
    while (pending.length > 0) {
      const directoryId = pending.shift()!;
      if (visitedDirectories.has(directoryId)) continue;
      visitedDirectories.add(directoryId);
      let pageCursor: string | undefined;
      const pageCursors = new Set<string>();
      while (true) {
        visitedPages += 1;
        if (visitedPages > 1_000) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: input.provider, reason: 'sync_page_limit', maxPages: 1_000 },
          });
        }
        const page = await this.input.gateway.catalog({
          provider: input.provider,
          config: input.config,
          credentials: input.credentials,
          rootId: directoryId,
          ...(pageCursor ? { cursor: pageCursor } : {}),
          context: input.context,
        });
        if (page.items.length > 200) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: input.provider, pageSize: page.items.length, max: 200 },
          });
        }
        for (const item of page.items) {
          if (item.type === 'directory') {
            if (!visitedDirectories.has(item.id)) pending.push(item.id);
          } else {
            documentParents.set(item.id, directoryId === input.rootId ? null : directoryId);
          }
        }
        if (!page.nextCursor) break;
        if (pageCursors.has(page.nextCursor)) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_CURSOR_INVALID',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: input.provider, reason: 'catalog_cursor_cycle' },
          });
        }
        pageCursors.add(page.nextCursor);
        pageCursor = page.nextCursor;
      }
    }
    const documents = [...documentParents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([externalId, providerParentId]) => ({ externalId, providerParentId }));
    return {
      documents,
      cursor: {
        mode: 'full',
        rootId: input.rootId,
        observedDocuments: documents.length,
        visitedDirectories: visitedDirectories.size,
      },
    };
  }

  async discover(
    input: { jobId: string; connectorId: string; full: boolean },
    context: TenantContext,
  ): Promise<S6ConnectorSyncResult> {
    const connector = await this.input.connectors.get(input.connectorId, context);
    const provider = providerOf(connector.provider, context);
    const externalRootId = rootIdOf(provider, connector.config, context);
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
    const traversal = await this.traverseCatalog({
      provider,
      config: connector.config,
      credentials,
      rootId: externalRootId,
      context,
    });
    const externalIds = traversal.documents.map((entry) => entry.externalId);
    const rawDocuments =
      traversal.documents.length === 0
        ? []
        : await this.input.gateway.content({
            provider,
            config: connector.config,
            credentials,
            externalIds,
            context,
          });
    const parentById = new Map(
      traversal.documents.map((entry) => [entry.externalId, entry.providerParentId]),
    );
    const documents = rawDocuments.map((document) => ({
      ...document,
      providerParentId: parentById.get(document.externalId) ?? null,
    }));
    const changeSetHash = changeSetHashOf({
      provider,
      externalRootId,
      documents,
    });
    const materialized: IngestionContentResult[] = [];
    try {
      for (const document of documents) {
        const material = await this.input.content.materializeProviderContent({
          kind: provider,
          knowledgeSpaceId: connector.knowledgeSpaceId,
          directoryId: null,
          connectorId: input.connectorId,
          content: document,
          context,
        });
        material.source.metadata = {
          ...material.source.metadata,
          providerParentId: document.providerParentId ?? null,
        };
        materialized.push(material);
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
          cursor: traversal.cursor,
          fullTraversalCompleted: true,
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
