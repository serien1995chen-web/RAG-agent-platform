import { z } from 'zod';
import { ConnectorConfigSchema, ConnectorCredentialsSchema } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';
import type {
  CloudProviderClientPort,
  ProviderCatalogResult,
  ProviderContent,
} from '../../application/ingestion.ports';
import { providerConfigError, providerContractError } from '../provider-json';
import {
  FetchS11ConnectorHttpTransport,
  S11ConnectorHttpClient,
  type S11ConnectorHttpTransport,
  connectorCredentialDigest,
  parseConnectorResponse,
} from './s11-connector-http';

interface YuqueTocNode {
  uuid: string;
  title: string;
  type?: string;
  slug?: string;
  url?: string;
  children?: YuqueTocNode[];
}

const YuqueTocNodeSchema: z.ZodType<YuqueTocNode> = z.lazy(() =>
  z
    .object({
      uuid: z.string().min(1),
      title: z.string().min(1),
      type: z.string().optional(),
      slug: z.string().optional(),
      url: z.string().optional(),
      children: z.array(YuqueTocNodeSchema).optional(),
    })
    .passthrough(),
);

const TocEnvelopeSchema = z.union([
  z.array(YuqueTocNodeSchema),
  z
    .object({
      data: z.array(YuqueTocNodeSchema),
    })
    .passthrough(),
]);

const RepoSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().min(1),
    namespace: z.string().optional(),
  })
  .passthrough();

const ReposEnvelopeSchema = z.union([
  z.array(RepoSchema),
  z
    .object({
      data: z.array(RepoSchema),
    })
    .passthrough(),
]);

const DocumentEnvelopeSchema = z
  .object({
    data: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        body_html: z.string().optional(),
        slug: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type Credentials = z.infer<typeof ConnectorCredentialsSchema>;
type YuqueCredentials = Extract<Credentials, { provider: 'yuque' }>;

function credentialsOf(value: Record<string, unknown>, context: TenantContext): YuqueCredentials {
  const parsed = ConnectorCredentialsSchema.safeParse(value);
  if (!parsed.success || parsed.data.provider !== 'yuque') {
    return providerConfigError('yuque', context, 'credentials_invalid');
  }
  return parsed.data;
}

function configOf(config: Record<string, unknown>, context: TenantContext): { basePath: string } {
  const parsed = ConnectorConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.provider !== 'yuque') {
    return providerConfigError('yuque', context, 'config_invalid');
  }
  return { basePath: parsed.data.basePath?.replace(/^\/+|\/+$/g, '') ?? '' };
}

function appendApiPath(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base}${pathname}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function flattenToc(
  nodes: readonly YuqueTocNode[],
  repoId: string,
): ProviderCatalogResult['items'] {
  const items: ProviderCatalogResult['items'] = [];
  for (const node of nodes) {
    const tocId = node.uuid;
    const slug = node.slug ?? node.url?.split('/').filter(Boolean).at(-1);
    const document = Boolean(slug) && node.type?.toUpperCase() !== 'TITLE';
    items.push({
      id: document ? `repo:${repoId}/toc:${tocId}/doc:${slug}` : `repo:${repoId}/toc:${tocId}`,
      name: node.title,
      type: document ? 'document' : 'directory',
    });
    if (node.children?.length) {
      items.push(...flattenToc(node.children, repoId));
    }
  }
  return items;
}

function parseCompositeId(
  externalId: string,
  context: TenantContext,
): { repoId: string; tocId: string; slug: string } {
  const match = /^repo:([^/]+)\/toc:([^/]+)\/doc:([^/]+)$/.exec(externalId);
  if (!match) {
    return providerConfigError('yuque', context, 'composite_external_id_required');
  }
  return {
    repoId: decodeURIComponent(match[1]!),
    tocId: decodeURIComponent(match[2]!),
    slug: decodeURIComponent(match[3]!),
  };
}

export class YuqueHttpDelegate implements CloudProviderClientPort {
  private readonly client: S11ConnectorHttpClient;

  constructor(
    private readonly input: {
      transport?: S11ConnectorHttpTransport;
      baseUrl?: string;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.client = new S11ConnectorHttpClient({
      provider: 'yuque',
      transport: input.transport ?? new FetchS11ConnectorHttpTransport(),
      sleep: input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
  }

  get evidence() {
    return this.client.evidence;
  }

  private get baseUrl(): string {
    return this.input.baseUrl ?? 'https://www.yuque.com';
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
    return this.client.request<T>(
      {
        ...input,
        headers: {
          'X-Auth-Token': parsed.token,
          accept: 'application/json',
          ...input.headers,
        },
      },
      context,
    );
  }

  async listRepos(input: {
    userId: string;
    offset?: number;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<Array<z.infer<typeof RepoSchema>>> {
    const url = new URL(`/api/v2/groups/${encodeURIComponent(input.userId)}/repos`, this.baseUrl);
    url.searchParams.set('offset', String(input.offset ?? 0));
    url.searchParams.set('limit', '100');
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
      (data) => {
        const value = ReposEnvelopeSchema.parse(data);
        return Array.isArray(value) ? value : value.data;
      },
      { provider: 'yuque', context: input.context },
    );
    return parsed;
  }

  async listToc(input: {
    repoId: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<Array<YuqueTocNode>> {
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: appendApiPath(
              this.baseUrl,
              `/api/v2/repos/${encodeURIComponent(input.repoId)}/toc`,
            ),
          },
          input.credentials,
          input.context,
        ),
      (data) => {
        const value = TocEnvelopeSchema.parse(data);
        return Array.isArray(value) ? value : value.data;
      },
      { provider: 'yuque', context: input.context },
    );
    return parsed;
  }

  async readDocument(input: {
    repoId: string;
    slug: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<{ title: string; content: string }> {
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: appendApiPath(
              this.baseUrl,
              `/api/v2/repos/${encodeURIComponent(input.repoId)}/docs/${encodeURIComponent(input.slug)}`,
            ),
          },
          input.credentials,
          input.context,
        ),
      (data) => {
        const envelope = DocumentEnvelopeSchema.parse(data);
        const content = envelope.data.body ?? envelope.data.body_html;
        if (!content?.trim()) {
          providerContractError('yuque', input.context, 'yuque_document_content_missing');
        }
        return {
          title: envelope.data.title ?? input.slug,
          content,
        };
      },
      { provider: 'yuque', context: input.context },
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
    if (input.provider !== 'yuque') {
      return providerConfigError('yuque', input.context, 'provider_mismatch');
    }
    configOf(input.config, input.context);
    const credentials = credentialsOf(input.credentials, input.context);
    if (input.rootId.startsWith('group:')) {
      const groupId = input.rootId.slice('group:'.length);
      const offset = input.cursor ? Number(input.cursor) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        return providerConfigError('yuque', input.context, 'offset_cursor_invalid');
      }
      const repos = await this.listRepos({
        userId: groupId || credentials.userId,
        offset,
        credentials: input.credentials,
        context: input.context,
      });
      return {
        provider: 'yuque',
        items: repos.map((repo) => ({
          id: `repo:${String(repo.id)}`,
          name: repo.name,
          type: 'directory',
        })),
        nextCursor: repos.length === 100 ? String(offset + 100) : null,
      };
    }
    const repoId = input.rootId.startsWith('repo:')
      ? input.rootId.slice('repo:'.length)
      : input.rootId;
    if (!repoId.trim()) {
      return providerConfigError('yuque', input.context, 'repo_id_required');
    }
    const toc = await this.listToc({
      repoId,
      credentials: input.credentials,
      context: input.context,
    });
    return {
      provider: 'yuque',
      items: flattenToc(toc, repoId),
      nextCursor: null,
    };
  }

  async content(input: {
    provider: 'feishu' | 'yuque' | 'dingtalk';
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    if (input.provider !== 'yuque') {
      return providerConfigError('yuque', input.context, 'provider_mismatch');
    }
    configOf(input.config, input.context);
    const contents: ProviderContent[] = [];
    for (const externalId of input.externalIds) {
      const id = parseCompositeId(externalId, input.context);
      const document = await this.readDocument({
        repoId: id.repoId,
        slug: id.slug,
        credentials: input.credentials,
        context: input.context,
      });
      contents.push({
        externalId,
        title: document.title,
        mimeType: 'text/markdown',
        bytes: Buffer.from(document.content, 'utf8'),
      });
    }
    return contents;
  }

  async probe(input: {
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<{ provider: 'yuque'; status: 'READY'; credentialDigest: string }> {
    const credentials = credentialsOf(input.credentials, input.context);
    await this.listRepos({
      userId: credentials.userId,
      offset: 0,
      credentials: input.credentials,
      context: input.context,
    });
    return {
      provider: 'yuque',
      status: 'READY',
      credentialDigest: connectorCredentialDigest('yuque', input.context.workspaceId, credentials),
    };
  }
}
