import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const B09_FEISHU_ENV_KEYS = [
  'S11_FEISHU_APP_ID',
  'S11_FEISHU_APP_SECRET',
  'S11_FEISHU_FOLDER_TOKEN',
  'S11_FEISHU_DOC_1',
  'S11_FEISHU_DOC_2',
] as const;

export interface FeishuCallEvidence {
  operation: string;
  requestId: string | null;
  status: number;
  endpointPath: string;
  attempt: number;
  durationMs: number;
  resourceCount: number;
  contentHash: string | null;
}

export interface B09FeishuResources {
  runId: string;
  rootFolderToken: string;
  nestedFolderToken: string;
  keepDocumentToken: string;
  mutateDocumentToken: string;
  evidence: FeishuCallEvidence[];
}

interface FeishuEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
  tenant_access_token?: string;
  expire?: number;
}

export function missingFeishuEnvironment(environment: NodeJS.ProcessEnv = process.env): string[] {
  return B09_FEISHU_ENV_KEYS.filter((name) => !environment[name]?.trim());
}

export function safeSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function writeB09ProviderEvidence(
  evidenceDir: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, fileName);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

export function safeEndpointPath(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname
    .replace(
      /^(\/open-apis\/docx\/v1\/documents\/)[^/]+(\/blocks\/)[^/]+/,
      '$1:documentId$2:blockId',
    )
    .replace(/^(\/open-apis\/docx\/v1\/documents\/)[^/]+/, '$1:documentId')
    .replace(/^(\/open-apis\/drive\/v1\/files\/)[^/]+/, '$1:fileToken');
}

function requiredEnv(name: (typeof B09_FEISHU_ENV_KEYS)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing Feishu environment: ${name}`);
  return value;
}

export class B09FeishuResourceManager {
  readonly evidence: FeishuCallEvidence[] = [];
  private tenantToken: string | null = null;
  private rootFolderToken: string | null = null;
  private nestedFolderToken: string | null = null;
  private keepDocumentToken: string | null = null;
  private mutateDocumentToken: string | null = null;

  constructor(
    readonly runId = `codex-b09-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    private readonly baseUrl = process.env.S11_FEISHU_BASE_URL?.trim() || 'https://open.feishu.cn',
  ) {}

  async provision(): Promise<B09FeishuResources> {
    await this.loadToken();
    const configuredFolderToken = requiredEnv('S11_FEISHU_FOLDER_TOKEN');
    this.rootFolderToken = await this.createFolder(this.runId, configuredFolderToken);
    try {
      this.nestedFolderToken = await this.createFolder(
        `${this.runId}-nested`,
        this.rootFolderToken,
      );
      this.keepDocumentToken = await this.createDocument(
        this.rootFolderToken,
        `${this.runId}-keep`,
        'B09 keep document fixture',
      );
      this.mutateDocumentToken = await this.createDocument(
        this.rootFolderToken,
        `${this.runId}-mutate`,
        'B09 mutate document fixture',
      );
      return {
        runId: this.runId,
        rootFolderToken: this.rootFolderToken,
        nestedFolderToken: this.nestedFolderToken,
        keepDocumentToken: this.keepDocumentToken,
        mutateDocumentToken: this.mutateDocumentToken,
        evidence: this.evidence,
      };
    } catch (error) {
      await this.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async renameMutateDocument(name: string): Promise<void> {
    this.mutateDocumentToken = await this.renameDocument(
      this.requireToken(this.mutateDocumentToken, 'mutateDocumentToken'),
      name,
    );
  }

  async moveMutateDocument(): Promise<void> {
    await this.moveDocument(
      this.requireToken(this.mutateDocumentToken, 'mutateDocumentToken'),
      this.requireToken(this.nestedFolderToken, 'nestedFolderToken'),
    );
  }

  async deleteMutateDocument(): Promise<void> {
    const token = this.requireToken(this.mutateDocumentToken, 'mutateDocumentToken');
    await this.deleteFile(token, 'docx');
    this.mutateDocumentToken = null;
  }

  async cleanup(): Promise<{ complete: boolean; failures: string[] }> {
    const failures: string[] = [];
    for (const [kind, token] of [
      ['mutateDocument', this.mutateDocumentToken],
      ['keepDocument', this.keepDocumentToken],
      ['nestedFolder', this.nestedFolderToken],
      ['rootFolder', this.rootFolderToken],
    ] as const) {
      if (!token) continue;
      try {
        await this.deleteFile(token, kind.includes('Document') ? 'docx' : 'folder');
      } catch {
        failures.push(kind);
      }
    }
    this.mutateDocumentToken = null;
    this.keepDocumentToken = null;
    this.nestedFolderToken = null;
    this.rootFolderToken = null;
    return { complete: failures.length === 0, failures };
  }

  private requireToken(value: string | null, field: string): string {
    if (!value) throw new Error(`${field} was not provisioned`);
    return value;
  }

  private async loadToken(): Promise<void> {
    if (this.tenantToken) return;
    const url = `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
    const response = await this.request<FeishuEnvelope<unknown>>(url, {
      method: 'POST',
      operation: 'tenant_access_token',
      body: {
        app_id: requiredEnv('S11_FEISHU_APP_ID'),
        app_secret: requiredEnv('S11_FEISHU_APP_SECRET'),
      },
    });
    const token = response.tenant_access_token;
    if (!token) throw new Error('Feishu tenant access token missing');
    this.tenantToken = token;
  }

  private async createFolder(name: string, parentToken: string): Promise<string> {
    const payload = await this.request<FeishuEnvelope<{ token: string }>>(
      `${this.baseUrl}/open-apis/drive/v1/files/create_folder`,
      {
        method: 'POST',
        operation: 'create_folder',
        body: { name, folder_token: parentToken },
      },
    );
    if (!payload.data?.token) throw new Error('Feishu create_folder returned no token');
    return payload.data.token;
  }

  private async createDocument(
    folderToken: string,
    title: string,
    content: string,
  ): Promise<string> {
    const payload = await this.request<
      FeishuEnvelope<{
        document?: { document_id?: string; token?: string };
        document_id?: string;
        token?: string;
      }>
    >(`${this.baseUrl}/open-apis/docx/v1/documents`, {
      method: 'POST',
      operation: 'create_document',
      body: { folder_token: folderToken, title },
    });
    const token =
      payload.data?.document?.document_id ??
      payload.data?.document?.token ??
      payload.data?.document_id ??
      payload.data?.token;
    if (!token) throw new Error('Feishu create document returned no token');

    await this.request(
      `${this.baseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(token)}/blocks/${encodeURIComponent(token)}/children`,
      {
        method: 'POST',
        operation: 'create_document_content',
        body: {
          children: [
            {
              block_type: 2,
              text: {
                elements: [{ text_run: { content } }],
              },
            },
          ],
          index: 0,
        },
      },
    );
    return token;
  }

  private async renameDocument(token: string, name: string): Promise<string> {
    await this.request(
      `${this.baseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(token)}/blocks/${encodeURIComponent(token)}?document_revision_id=-1`,
      {
        method: 'PATCH',
        operation: 'rename_document',
        body: {
          update_text_elements: {
            elements: [{ text_run: { content: name } }],
          },
        },
      },
    );
    return token;
  }

  private async moveDocument(token: string, folderToken: string): Promise<void> {
    await this.request(
      `${this.baseUrl}/open-apis/drive/v1/files/${encodeURIComponent(token)}/move`,
      {
        method: 'POST',
        operation: 'move_document',
        body: { type: 'docx', folder_token: folderToken },
      },
    );
  }

  private async deleteFile(token: string, type: 'docx' | 'folder'): Promise<void> {
    await this.request(
      `${this.baseUrl}/open-apis/drive/v1/files/${encodeURIComponent(token)}?type=${type}`,
      { method: 'DELETE', operation: `delete_${type}` },
      true,
    );
  }

  private async request<T = FeishuEnvelope<unknown>>(
    url: string,
    input: {
      method: 'POST' | 'PATCH' | 'DELETE';
      operation: string;
      body?: Record<string, unknown>;
    },
    allowEmpty = false,
  ): Promise<T> {
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${this.tenantToken ?? ''}`,
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json',
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    this.evidence.push({
      operation: input.operation,
      requestId: response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid') ?? null,
      status: response.status,
      endpointPath: safeEndpointPath(url),
      attempt: 1,
      durationMs: Date.now() - startedAt,
      resourceCount: 1,
      contentHash: text ? safeSha256(text) : null,
    });
    if (!response.ok) {
      let providerCode: unknown = null;
      let providerMessage = '';
      let providerError = '';
      try {
        const payload = JSON.parse(text) as {
          code?: unknown;
          msg?: unknown;
          error?: unknown;
        };
        providerCode = payload.code ?? null;
        providerMessage =
          typeof payload.msg === 'string' ? payload.msg.replace(/\s+/g, ' ').slice(0, 160) : '';
        if (payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
          const safeError = {
            ...(payload.error as Record<string, unknown>),
          };
          delete safeError.log_id;
          delete safeError.troubleshooter;
          providerError = JSON.stringify(safeError).replace(/\s+/g, ' ').slice(0, 400);
        }
      } catch {
        // Preserve the status-only error when the provider did not return JSON.
      }
      throw new Error(
        `Feishu ${input.operation} failed with status ${response.status} code=${String(providerCode)} msg=${providerMessage} error=${providerError}`,
      );
    }
    if (allowEmpty && !text) return {} as T;
    const payload = JSON.parse(text) as FeishuEnvelope<T> & T;
    if (payload.code !== undefined && payload.code !== 0) {
      throw new Error(
        `Feishu ${input.operation} business error ${payload.code} msg=${payload.msg ?? ''}`,
      );
    }
    return payload;
  }
}
