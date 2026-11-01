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
  S11ConnectorTokenCache,
  type S11ConnectorHttpTransport,
  connectorCredentialDigest,
  isProviderStatus,
  parseConnectorResponse,
} from './s11-connector-http';

const TokenSchema = z
  .object({
    code: z.number().int().optional(),
    tenant_access_token: z.string().min(1).optional(),
    expire: z.number().int().positive().optional(),
    data: z
      .object({
        tenant_access_token: z.string().min(1).optional(),
        expire: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const FileSchema = z
  .object({
    token: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    parent_token: z.string().optional(),
  })
  .passthrough();

const FilesEnvelopeSchema = z
  .object({
    code: z.number().int().default(0),
    data: z
      .object({
        files: z.array(FileSchema),
        next_page_token: z.string().optional(),
        has_more: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const MetaSchema = z
  .object({
    doc_token: z.string().min(1),
    title: z.string().optional(),
    owner_id: z.string().optional(),
  })
  .passthrough();

const MetaEnvelopeSchema = z
  .object({
    code: z.number().int().default(0),
    data: z
      .object({
        metas: z.array(MetaSchema).optional(),
        items: z.array(MetaSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const DocumentSchema = z
  .object({
    code: z.number().int().default(0),
    data: z
      .object({
        document: z
          .object({
            document_id: z.string().optional(),
            title: z.string().optional(),
            revision_id: z.number().int().optional(),
          })
          .passthrough()
          .optional(),
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type Credentials = z.infer<typeof ConnectorCredentialsSchema>;
type FeishuCredentials = Extract<Credentials, { provider: 'feishu' }>;

function feishuCredentials(
  value: Record<string, unknown>,
  context: TenantContext,
): FeishuCredentials {
  const parsed = ConnectorCredentialsSchema.safeParse(value);
  if (!parsed.success || parsed.data.provider !== 'feishu') {
    return providerConfigError('feishu', context, 'credentials_invalid');
  }
  return parsed.data;
}

function feishuFolderToken(config: Record<string, unknown>, context: TenantContext): string {
  const parsed = ConnectorConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.provider !== 'feishu') {
    return providerConfigError('feishu', context, 'config_invalid');
  }
  return parsed.data.folderToken;
}

function documentToken(externalId: string): string {
  if (externalId.startsWith('feishu:docx:')) return externalId.slice('feishu:docx:'.length);
  if (externalId.startsWith('feishu:doc:')) return externalId.slice('feishu:doc:'.length);
  return externalId;
}

function isFeishuDocument(type: string): boolean {
  return type === 'docx' || type === 'doc';
}

export class FeishuHttpDelegate implements CloudProviderClientPort {
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
      provider: 'feishu',
      transport: input.transport ?? new FetchS11ConnectorHttpTransport(),
      sleep: input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
  }

  get evidence() {
    return this.client.evidence;
  }

  async getTenantAccessToken(
    credentials: Record<string, unknown>,
    context: TenantContext,
  ): Promise<string> {
    const parsed = feishuCredentials(credentials, context);
    const key = connectorCredentialDigest('feishu', context.workspaceId, parsed);
    return this.tokenCache.getOrLoad(key, async () => {
      const { parsed: token } = await parseConnectorResponse(
        () =>
          this.client.request(
            {
              method: 'POST',
              url: `${this.input.baseUrl ?? 'https://open.feishu.cn'}/open-apis/auth/v3/tenant_access_token/internal`,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                accept: 'application/json',
              },
              body: {
                app_id: parsed.appId,
                app_secret: parsed.appSecret,
              },
            },
            context,
          ),
        (data) => {
          const envelope = TokenSchema.parse(data);
          const accessToken = envelope.tenant_access_token ?? envelope.data?.tenant_access_token;
          if (!accessToken) {
            providerContractError('feishu', context, 'tenant_access_token_missing');
          }
          return {
            token: accessToken,
            expiresInSeconds: envelope.expire ?? envelope.data?.expire ?? 7_200,
          };
        },
        { provider: 'feishu', context },
      );
      return token;
    });
  }

  private async authorizedRequest<T>(
    input: Omit<Parameters<S11ConnectorHttpClient['request']>[0], 'headers'> & {
      headers?: Record<string, string>;
    },
    credentials: Record<string, unknown>,
    context: TenantContext,
  ) {
    const parsed = feishuCredentials(credentials, context);
    const key = connectorCredentialDigest('feishu', context.workspaceId, parsed);
    const token = await this.getTenantAccessToken(credentials, context);
    try {
      return await this.client.request<T>(
        {
          ...input,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...input.headers,
          },
        },
        context,
      );
    } catch (error) {
      if (!isProviderStatus(error, 401)) throw error;
      this.tokenCache.invalidate(key);
      const refreshed = await this.getTenantAccessToken(credentials, context);
      return this.client.request<T>(
        {
          ...input,
          headers: {
            authorization: `Bearer ${refreshed}`,
            accept: 'application/json',
            ...input.headers,
          },
        },
        context,
      );
    }
  }

  async listFiles(input: {
    folderToken: string;
    cursor?: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<z.infer<typeof FilesEnvelopeSchema>['data']> {
    const url = new URL(
      '/open-apis/drive/v1/files',
      this.input.baseUrl ?? 'https://open.feishu.cn',
    );
    url.searchParams.set('folder_token', input.folderToken);
    url.searchParams.set('page_size', '200');
    if (input.cursor) url.searchParams.set('page_token', input.cursor);
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
      (data) => FilesEnvelopeSchema.parse(data).data,
      { provider: 'feishu', context: input.context },
    );
    return parsed;
  }

  async readMetas(input: {
    tokens: readonly string[];
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<Array<z.infer<typeof MetaSchema>>> {
    if (input.tokens.length === 0) return [];
    const { parsed } = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'POST',
            url: `${this.input.baseUrl ?? 'https://open.feishu.cn'}/open-apis/drive/v1/metas/batch_query`,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: {
              request_docs: input.tokens.map((token) => ({
                doc_token: token,
                doc_type: 'docx',
              })),
            },
          },
          input.credentials,
          input.context,
        ),
      (data) => {
        const envelope = MetaEnvelopeSchema.parse(data);
        return envelope.data?.metas ?? envelope.data?.items ?? [];
      },
      { provider: 'feishu', context: input.context },
    );
    return parsed;
  }

  async readDocument(input: {
    documentId: string;
    credentials: Record<string, unknown>;
    context: TenantContext;
  }): Promise<{ content: string; title: string }> {
    const token = documentToken(input.documentId);
    const rawUrl = `${this.input.baseUrl ?? 'https://open.feishu.cn'}/open-apis/docx/v1/documents/${encodeURIComponent(token)}/raw_content`;
    const raw = await parseConnectorResponse(
      () =>
        this.authorizedRequest(
          {
            method: 'GET',
            url: rawUrl,
          },
          input.credentials,
          input.context,
        ),
      (data) => {
        const parsed = DocumentSchema.parse(data);
        if (!parsed.data?.content) {
          providerContractError('feishu', input.context, 'document_content_missing');
        }
        return parsed.data.content;
      },
      { provider: 'feishu', context: input.context },
    );
    let title = token;
    try {
      const detail = await parseConnectorResponse(
        () =>
          this.authorizedRequest(
            {
              method: 'GET',
              url: `${this.input.baseUrl ?? 'https://open.feishu.cn'}/open-apis/docx/v1/documents/${encodeURIComponent(token)}`,
            },
            input.credentials,
            input.context,
          ),
        (data) => DocumentSchema.parse(data).data?.document?.title ?? token,
        { provider: 'feishu', context: input.context },
      );
      title = detail.parsed;
    } catch {
      // The raw content call is authoritative; a title lookup cannot erase it.
    }
    return { content: raw.parsed, title };
  }

  async catalog(input: {
    provider: 'feishu' | 'yuque' | 'dingtalk';
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    rootId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    if (input.provider !== 'feishu') {
      return providerConfigError('feishu', input.context, 'provider_mismatch');
    }
    const folderToken = feishuFolderToken(input.config, input.context);
    const page = await this.listFiles({
      folderToken,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      credentials: input.credentials,
      context: input.context,
    });
    const documents = page.files.filter((file) => isFeishuDocument(file.type));
    let metas = new Map<string, z.infer<typeof MetaSchema>>();
    if (documents.length > 0) {
      try {
        const result = await this.readMetas({
          tokens: documents.map((document) => document.token),
          credentials: input.credentials,
          context: input.context,
        });
        metas = new Map(result.map((meta) => [meta.doc_token, meta]));
      } catch {
        metas = new Map();
      }
    }
    return {
      provider: 'feishu',
      items: page.files.map((file) => ({
        id: isFeishuDocument(file.type)
          ? `feishu:${file.type}:${file.token}`
          : `feishu:folder:${file.token}`,
        name: metas.get(file.token)?.title ?? file.name,
        type: isFeishuDocument(file.type) ? 'document' : 'directory',
      })),
      nextCursor: page.has_more === true ? (page.next_page_token ?? null) : null,
    };
  }

  async content(input: {
    provider: 'feishu' | 'yuque' | 'dingtalk';
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    externalIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    if (input.provider !== 'feishu') {
      return providerConfigError('feishu', input.context, 'provider_mismatch');
    }
    const contents: ProviderContent[] = [];
    for (const externalId of input.externalIds) {
      const document = await this.readDocument({
        documentId: externalId,
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
  }): Promise<{ provider: 'feishu'; status: 'READY'; credentialDigest: string }> {
    await this.getTenantAccessToken(input.credentials, input.context);
    return {
      provider: 'feishu',
      status: 'READY',
      credentialDigest: connectorCredentialDigest(
        'feishu',
        input.context.workspaceId,
        feishuCredentials(input.credentials, input.context),
      ),
    };
  }
}
