'use client';

import type { KnowledgeProblem } from '@kb/contracts';

export interface S09SynonymLastError {
  code: string;
  message: string;
  rowNumber?: number;
}

export interface S09SynonymConfigData {
  knowledgeSpaceId: string;
  fileName: string;
  sizeBytes: number;
  activeFileVersion: number;
  enabled: boolean;
  schemaVersion: 2;
  status: 'active' | 'disabled' | 'rebuilding' | 'failed';
  mappingCount: number;
  termCount: number;
  version: number;
  updatedAt: string;
  lastError: S09SynonymLastError | null;
}

export interface S09SynonymMappingData {
  logicalMappingId: string;
  fileVersion: number;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonymTerms: string[];
  normalizedSynonymTerms: string[];
  fingerprint: string;
}

export interface S09SynonymMappingListData {
  items: S09SynonymMappingData[];
  nextCursor: string | null;
  hasMore: boolean;
  fileVersion: number;
}

export interface S09SynonymJobData {
  jobId: string;
  status: string;
  progress?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  version?: number;
}

export class S09SynonymRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: KnowledgeProblem,
  ) {
    super(problem.error.message);
    this.name = 'S09SynonymRequestError';
  }
}

export interface S09SynonymClientOptions {
  baseUrl?: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  idempotencyKeyFactory?: () => string;
}

export class S09SynonymClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly keyFactory: () => string;

  constructor(private readonly options: S09SynonymClientOptions) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.keyFactory = options.idempotencyKeyFactory ?? (() => crypto.randomUUID());
  }

  private url(spaceId: string, suffix = ''): string {
    return `${this.baseUrl}/v1/knowledge/spaces/${encodeURIComponent(spaceId)}/synonyms${suffix}`;
  }

  private headers(json = false, idempotencyKey?: string): Record<string, string> {
    return {
      accept: 'application/json',
      'X-Workspace-Id': this.options.workspaceId,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };
  }

  private async json<T>(response: Response): Promise<T> {
    const payload = (await response.json()) as { success: true; data: T } | KnowledgeProblem;
    if (!response.ok || !payload.success) {
      throw new S09SynonymRequestError(response.status, payload as KnowledgeProblem);
    }
    return payload.data;
  }

  async get(spaceId: string): Promise<S09SynonymConfigData> {
    return this.json(
      await this.fetchImpl(this.url(spaceId), {
        method: 'GET',
        credentials: 'same-origin',
        headers: this.headers(),
      }),
    );
  }

  async upload(
    spaceId: string,
    file: File,
    input: { enabled: boolean; idempotencyKey?: string },
  ): Promise<S09SynonymConfigData> {
    const form = new FormData();
    form.set('file', file);
    form.set('enabled', String(input.enabled));
    return this.json(
      await this.fetchImpl(this.url(spaceId, '/files'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.headers(false, input.idempotencyKey ?? this.keyFactory()),
        body: form,
      }),
    );
  }

  async update(
    spaceId: string,
    file: File,
    input: { enabled: boolean; expectedFileVersion: number; idempotencyKey?: string },
  ): Promise<S09SynonymConfigData> {
    const form = new FormData();
    form.set('file', file);
    form.set('enabled', String(input.enabled));
    form.set('expectedFileVersion', String(input.expectedFileVersion));
    return this.json(
      await this.fetchImpl(this.url(spaceId, '/files'), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: this.headers(false, input.idempotencyKey ?? this.keyFactory()),
        body: form,
      }),
    );
  }

  async toggle(
    spaceId: string,
    input: { enabled: boolean; version: number; idempotencyKey?: string },
  ): Promise<S09SynonymConfigData> {
    return this.json(
      await this.fetchImpl(this.url(spaceId), {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: this.headers(true, input.idempotencyKey ?? this.keyFactory()),
        body: JSON.stringify({ enabled: input.enabled, version: input.version }),
      }),
    );
  }

  async delete(
    spaceId: string,
    input: { version: number; idempotencyKey?: string },
  ): Promise<{ id: string; status: string; jobId: string | null }> {
    return this.json(
      await this.fetchImpl(this.url(spaceId), {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: this.headers(true, input.idempotencyKey ?? this.keyFactory()),
        body: JSON.stringify({ version: input.version }),
      }),
    );
  }

  async download(spaceId: string, fileVersion: number): Promise<Blob> {
    const response = await this.fetchImpl(this.url(spaceId, `/files/${fileVersion}`), {
      method: 'GET',
      credentials: 'same-origin',
      headers: this.headers(),
    });
    if (!response.ok) {
      await this.json<never>(response);
    }
    return response.blob();
  }

  async mappings(
    spaceId: string,
    input: { cursor?: string; limit?: number; search?: string } = {},
  ): Promise<S09SynonymMappingListData> {
    const params = new URLSearchParams();
    if (input.cursor) params.set('cursor', input.cursor);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.search?.trim()) params.set('search', input.search.trim());
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.json(
      await this.fetchImpl(this.url(spaceId, `/mappings${suffix}`), {
        method: 'GET',
        credentials: 'same-origin',
        headers: this.headers(),
      }),
    );
  }

  async rebuild(
    spaceId: string,
    input: { version: number; idempotencyKey?: string },
  ): Promise<S09SynonymJobData> {
    return this.json(
      await this.fetchImpl(this.url(spaceId, '/rebuild'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.headers(true, input.idempotencyKey ?? this.keyFactory()),
        body: JSON.stringify({ version: input.version }),
      }),
    );
  }
}
