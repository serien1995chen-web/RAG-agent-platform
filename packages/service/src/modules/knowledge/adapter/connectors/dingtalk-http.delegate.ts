import { z } from 'zod';
import { createKnowledgeError } from '@kb/contracts';
import { ConnectorConfigSchema, ConnectorCredentialsSchema } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type {
  CloudProviderClientPort,
  ProviderCatalogResult,
  ProviderContent,
} from '../../application/ingestion.ports';
import { providerConfigError } from '../provider-json';
import {
  FetchS11ConnectorHttpTransport,
  S11ConnectorHttpClient,
  S11ConnectorTokenCache,
  type S11ConnectorHttpTransport,
  connectorCredentialDigest,
  isProviderStatus,
  parseConnectorResponse,
} from './s11-connector-http';

const TokenSchema = z
  .object({
    accessToken: z.string().min(1),
    expireIn: z.number().int().positive().optional(),
  })
  .passthrough();

const WorkspaceSchema = z
  .object({
    workspaceId: z.string().min(1),
    name: z.string().min(1),
  })
  .passthrough();

const WorkspaceEnvelopeSchema = z.union([
  z
    .object({
      workspaces: z.array(WorkspaceSchema),
      nextToken: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      data: z
        .object({
          workspaces: z.array(WorkspaceSchema).optional(),
          nextToken: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
]);

const NodeSchema = z
  .object({
    nodeId: z.string().min(1),
    name: z.string().min(1),
    type: z.string().optional(),
    extension: z.string().optional(),
    url: z.string().optional(),
    workspaceId: z.string().optional(),
    parentNodeId: z.string().optional(),
  })
  .passthrough();

const NodesEnvelopeSchema = z.union([
  z
    .object({
      nodes: z.array(NodeSchema),
      nextToken: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      data: z
        .object({
          nodes: z.array(NodeSchema).optional(),
          nextToken: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      result: z
        .object({
          nodes: z.array(NodeSchema).optional(),
          nextToken: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
]);

const NodeDetailSchema = z
  .object({
    nodeId: z.string().min(1),
    name: z.string().min(1),
    type: z.string().optional(),
    extension: z.string().optional(),
    url: z.string().optional(),
    workspaceId: z.string().optional(),
    parentNodeId: z.string().optional(),
  })
  .passthrough();

const NodeDetailEnvelopeSchema = z.union([
  NodeDetailSchema,
  z.object({ data: NodeDetailSchema }).passthrough(),
  z.object({ result: NodeDetailSchema }).passthrough(),
]);

const BlockSchema = z
  .object({
    blockId: z.string().optional(),
    blockType: z.string().optional(),
    text: z.string().optional(),
    markdown: z.string().optional(),
    content: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  })
  .passthrough();

const BlocksEnvelopeSchema = z.union([
  z.array(BlockSchema),
  z
    .object({
      blocks: z.array(BlockSchema).optional(),
      nextToken: z.string().optional(),
      data: z
        .object({
          blocks: z.array(BlockSchema).optional(),
          nextToken: z.string().optional(),
        })
        .passthrough()
        .optional(),
      result: z
        .object({
          blocks: z.array(BlockSchema).optional(),
          nextToken: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
]);

type Credentials = z.infer<typeof ConnectorCredentialsSchema>;
type DingtalkCredentials = Extract<Credentials, { provider: 'dingtalk' }>;

function credentialsOf(
  value: Record<string, unknown>,
  context: TenantContext,
): DingtalkCredentials {
  const parsed = ConnectorCredentialsSchema.safeParse(value);
  if (!parsed.success || parsed.data.provider !== 'dingtalk') {
    return providerConfigError('dingtalk', context, 'credentials_invalid');
  }
  return parsed.data;
}

function configOf(config: Record<string, unknown>, context: TenantContext) {
  const parsed = ConnectorConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.provider !== 'dingtalk') {
    return providerConfigError('dingtalk', context, 'config_invalid');
  }
  return parsed.data;
}

function envelopeNodes(data: unknown): {
  nodes: Array<z.infer<typeof NodeSchema>>;
  nextToken?: string;
} {
  const parsed = NodesEnvelopeSchema.parse(data) as {
    nodes?: Array<z.infer<typeof NodeSchema>>;
    nextToken?: string;
    data?: { nodes?: Array<z.infer<typeof NodeSchema>>; nextToken?: string };
    result?: { nodes?: Array<z.infer<typeof NodeSchema>>; nextToken?: string };
  };
  if (parsed.nodes) {
    return {
      nodes: parsed.nodes,
      ...(parsed.nextToken ? { nextToken: parsed.nextToken } : {}),
    };
  }
  const nested = parsed.data ?? parsed.result;
  return {
    nodes: nested?.nodes ?? [],
    ...(nested?.nextToken ? { nextToken: nested.nextToken } : {}),
  };
}

function nodeDetail(data: unknown): z.infer<typeof NodeDetailSchema> {
  const parsed = NodeDetailEnvelopeSchema.parse(data) as z.infer<typeof NodeDetailSchema> & {
    data?: z.infer<typeof NodeDetailSchema>;
    result?: z.infer<typeof NodeDetailSchema>;
  };
  return parsed.data ?? parsed.result ?? parsed;
}

function blocksOf(data: unknown) {
  const parsed = BlocksEnvelopeSchema.parse(data) as
    | Array<z.infer<typeof BlockSchema>>
    | {
        blocks?: Array<z.infer<typeof BlockSchema>>;
        data?: { blocks?: Array<z.infer<typeof BlockSchema>> };
        result?: { blocks?: Array<z.infer<typeof BlockSchema>> };
      };
  if (Array.isArray(parsed)) return parsed;
  return parsed.blocks ?? parsed.data?.blocks ?? parsed.result?.blocks ?? [];
}

function isOnlineDocument(node: { type?: string; extension?: string }): boolean {
  return (
    node.type?.toLowerCase() === 'document' ||
    node.type?.toLowerCase() === 'doc' ||
    node.extension?.toLowerCase() === 'adoc'
  );
}

function parseExternalId(
  externalId: string,
  context: TenantContext,
): { workspaceId: string; nodeId: string; documentId: string } {
  const match = /^wiki:([^/]+)\/node:([^/]+)\/doc:([^/]+)$/.exec(externalId);
  if (!match) {
    return providerConfigError('dingtalk', context, 'online_document_id_required');
  }
  return {
    workspaceId: decodeURIComponent(match[1]!),
    nodeId: decodeURIComponent(match[2]!),
    documentId: decodeURIComponent(match[3]!),
  };
}

function textOfBlocks(blocks: ReadonlyArray<z.infer<typeof BlockSchema>>): string {
  return blocks
    .map((block) => {
      if (block.markdown?.trim()) return block.markdown;
      if (block.text?.trim()) return block.text;
      if (typeof block.content === 'string') return block.content;
      if (block.content && typeof block.content === 'object') {
        const record = block.content as Record<string, unknown>;
        const text = record.text ?? record.content ?? record.value;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export class DingtalkHttpDelegate implements CloudProviderClientPort {
  private readonly client: S11ConnectorHttpClient;
  private readonly tokenCache: S11ConnectorTokenCache;

  constructor(
    private readonly input: {
      transport?: S11ConnectorHttpTransport;
      baseUrl?: string;
      sleep?: (ms: number) => Promise<void>;
      tokenCache?: S11ConnectorTokenCache;
    } = {},
  ) {
    this.tokenCache = input.tokenCache ?? new S11ConnectorTokenCache();
    this.client = new S11ConnectorHttpClient({
      provider: 'dingtalk',
      transport: input.transport ?? new FetchS11ConnectorHttpTransport(),
      sleep: input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
  }

  get evidence() {
    return this.client.evidence;
  }

  async getAccessToken(
    credentials: Record<string, unknown>,
    context: TenantContext,
  ): Promise<string> {
    const parsed = credentialsOf(credentials, context);
    const key = connectorCredentialDigest('dingtalk', context.workspaceId, parsed);
    return this.tokenCache.getOrLoad(key, async () => {
      const token = await parseConnectorResponse(
        () =>
          this.client.request(
            {
              method: 'POST',
              url: `${this.input.baseUrl ?? 'https://api.dingtalk.com'}/v1.0/oauth2/accessToken`,
              headers: {
                'content-type': 'application/json',
                accept: 'application/json',
              },
              body: {
                appKey: parsed.appKey,
                appSecret: parsed.appSecret,
              },
            },
            context,
          ),
        (data) => {
          const envelope = TokenSchema.parse(data);
          return {
            token: envelope.accessToken,
            expiresInSeconds: envelope.expireIn ?? 7_200,
          };
        },
        { provider: 'dingtalk', context },
      );
      return token.parsed;
    });
  }

  private async authorizedRequest<T>(
    input: {
      method: 'GET' | 'POST' | 'PUT';
      url: string;
      headers?: Record<string, string>;
    },
    credentials: Record<string, unknown>,
    context: TenantContext,
  ) {
    const parsed = credentialsOf(credentials, context);
    const key = connectorCredentialDigest('dingtalk', context.workspaceId, parsed);
    const token = await this.getAccessToken(credentials, context);
    try {
      return await this.client.request<T>(
        {
          ...input,
          headers: {
            'x-acs-dingtalk-access-token': token,
            accept: 'application/json',
            ...input.headers,
          },
        },
        context,
      );
    } catch (error) {
      if (!isProviderStatus(error, 401)) throw error;
      this.tokenCache.invalidate(key);
      const refreshed = await this.getAccessToken(credentials, context);
      return this.client.request<T>(
        {
          ...input,
          headers: {
            'x-acs-dingtalk-access-token': refreshed,
            accept: 'application/json',
            ...input.headers,
          },
        },
        context,
      );
    }
  }

  async listWorkspaces(input: {
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<Array<z.infer<typeof WorkspaceSchema>>> {
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: `${this.input.baseUrl ?? 'https://api.dingtalk.com'}/v2.0/wiki/workspaces`,
          },
          input.credentials,
          input.context,
        ),
      (data) => {
        const envelope = WorkspaceEnvelopeSchema.parse(data) as
          | { workspaces: Array<z.infer<typeof WorkspaceSchema>> }
          | { data: { workspaces?: Array<z.infer<typeof WorkspaceSchema>> } };
        return 'workspaces' in envelope ? envelope.workspaces : (envelope.data.workspaces ?? []);
      },
      { provider: 'dingtalk', context: input.context },
    );
    return parsed;
  }

  async listNodes(input: {
    operatorId: string;
    workspaceId: string;
    rootNodeId: string;
    cursor?: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<{ nodes: Array<z.infer<typeof NodeSchema>>; nextToken?: string }> {
    const url = new URL('/v2.0/wiki/nodes', this.input.baseUrl ?? 'https://api.dingtalk.com');
    url.searchParams.set('operatorId', input.operatorId);
    url.searchParams.set('workspaceId', input.workspaceId);
    url.searchParams.set('parentNodeId', input.rootNodeId);
    url.searchParams.set('maxResults', '100');
    if (input.cursor) url.searchParams.set('nextToken', input.cursor);
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: url.toString(),
          },
          input.credentials,
          input.context,
        ),
      envelopeNodes,
      { provider: 'dingtalk', context: input.context },
    );
    return parsed;
  }

  async getNodeDetail(input: {
    nodeId: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<z.infer<typeof NodeDetailSchema>> {
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: `${this.input.baseUrl ?? 'https://api.dingtalk.com'}/v2.0/wiki/nodes/${encodeURIComponent(input.nodeId)}`,
          },
          input.credentials,
          input.context,
        ),
      nodeDetail,
      { provider: 'dingtalk', context: input.context },
    );
    return parsed;
  }

  async readBlocks(input: {
    nodeId: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<Array<z.infer<typeof BlockSchema>>> {
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: `${this.input.baseUrl ?? 'https://api.dingtalk.com'}/v2.0/wiki/nodes/${encodeURIComponent(input.nodeId)}/blocks`,
          },
          input.credentials,
          input.context,
        ),
      blocksOf,
      { provider: 'dingtalk', context: input.context },
    );
    return parsed;
  }

  async catalog(input: {
    provider: 'feishu' | 'yuque' | 'dingtalk';
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    if (input.provider !== 'dingtalk') {
      return providerConfigError('dingtalk', input.context, 'provider_mismatch');
    }
    const config = configOf(input.config, input.context);
    const credentials = credentialsOf(input.credentials, input.context);
    if (!config.workspaceId && !input.rootId.trim()) {
      const workspaces = await this.listWorkspaces({
        credentials: input.credentials,
        context: input.context,
      });
      return {
        provider: 'dingtalk',
        items: workspaces.map((workspace) => ({
          id: `workspace:${workspace.workspaceId}`,
          name: workspace.name,
          type: 'directory',
        })),
        nextCursor: null,
      };
    }
    const workspaceId = config.workspaceId ?? input.rootId;
    const rootNodeId =
      config.rootNodeId ??
      (input.rootId.startsWith('wiki:') ? input.rootId.slice('wiki:'.length) : input.rootId);
    const page = await this.listNodes({
      operatorId: config.operatorId ?? credentials.userId,
      workspaceId,
      rootNodeId,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      credentials: input.credentials,
      context: input.context,
    });
    return {
      provider: 'dingtalk',
      items: page.nodes.map((node) => ({
        id: isOnlineDocument(node)
          ? `wiki:${workspaceId}/node:${node.nodeId}/doc:${node.nodeId}`
          : `wiki:${workspaceId}/node:${node.nodeId}`,
        name: node.name,
        type: isOnlineDocument(node) ? 'document' : 'directory',
      })),
      nextCursor: page.nextToken ?? null,
    };
  }

  async content(input: {
    provider: 'feishu' | 'yuque' | 'dingtalk';
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    if (input.provider !== 'dingtalk') {
      return providerConfigError('dingtalk', input.context, 'provider_mismatch');
    }
    configOf(input.config, input.context);
    const contents: ProviderContent[] = [];
    for (const externalId of input.externalIds) {
      const id = parseExternalId(externalId, input.context);
      const detail = await this.getNodeDetail({
        nodeId: id.nodeId,
        credentials: input.credentials,
        context: input.context,
      });
      if (!isOnlineDocument(detail)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: {
            provider: 'dingtalk',
            externalId,
            reason: 'online_document_required',
          },
        });
      }
      const blocks = await this.readBlocks({
        nodeId: id.nodeId,
        credentials: input.credentials,
        context: input.context,
      });
      const content = textOfBlocks(blocks);
      if (!content.trim()) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          retryable: true,
          details: { provider: 'dingtalk', reason: 'document_blocks_empty' },
        });
      }
      contents.push({
        externalId,
        title: detail.name,
        mimeType: 'text/markdown',
        bytes: Buffer.from(content, 'utf8'),
      });
    }
    return contents;
  }

  async probe(input: {
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<{ provider: 'dingtalk'; status: 'READY'; credentialDigest: string }> {
    const credentials = credentialsOf(input.credentials, input.context);
    await this.getAccessToken(input.credentials, input.context);
    return {
      provider: 'dingtalk',
      status: 'READY',
      credentialDigest: connectorCredentialDigest(
        'dingtalk',
        input.context.workspaceId,
        credentials,
      ),
    };
  }
}
