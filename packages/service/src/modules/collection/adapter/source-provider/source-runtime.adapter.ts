import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import { DEFAULT_CHUNK_POLICY, chunkText, type ChunkItem, type ChunkPolicy } from '@kb/chunk';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ApiDatasetHttpClient } from './api-dataset-provider';
import type { FileParserLike } from './file-provider';

/**
 * Rev2 内部来源运行时适配器（不修改 A 的 provider 算法）：
 * - `@kb/parse` 文件解析适配器；
 * - API Dataset HTTP client；
 * 由 Runtime 注入到 SourceProviderRegistry。
 */

/** 以 @kb/parse 默认解析器满足 FileParserLike，供给 file Provider。 */
export function createParseRuntimeAdapter(): FileParserLike {
  const parser = createDefaultDocumentParser();
  return { parse: (request) => parser.parse(request) };
}

/** 基于 fetch 的 API Dataset 文本读取客户端。 */
export function createApiDatasetClient(): ApiDatasetHttpClient {
  return {
    async get(url: string, options: { timeout: number; responseType: 'text' }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.text();
        return { status: response.status, data };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface ApiDatasetRuntimeClient {
  getCatalog(input: {
    datasetId: string;
    apiConfig: unknown;
    parentId?: string;
  }): Promise<unknown[]>;
  getPathNames(input: { datasetId: string; apiConfig: unknown; nodeId: string }): Promise<string>;
  list(input: {
    datasetId: string;
    apiConfig: unknown;
    parentId?: string;
    keyword?: string;
  }): Promise<{ list: unknown[]; isImported: boolean }>;
  listExistId(input: { datasetId: string; apiConfigId: string }): Promise<unknown[]>;
}

/**
 * API Dataset 运行时客户端（Rev2 §4.3.2）：基于 source-runtime HTTP client 访问配置的
 * API Dataset 端点。未配置时由调用方 501017 处理；Provider 失败映射 501039。
 */
export function createApiDatasetRuntimeClient(deps: {
  configured: boolean;
  baseUrl?: string;
  client: ApiDatasetHttpClient;
}): ApiDatasetRuntimeClient {
  const endpoint = (deps.baseUrl ?? '').replace(/\/$/, '');
  const fetchJson = async (path: string, query: Record<string, unknown>): Promise<unknown> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await deps.client.get(`${endpoint}${path}${suffix}`, {
      timeout: 10_000,
      responseType: 'text',
    });
    if (response.status >= 400) {
      throw new ApiErrorException(
        createApiError({
          code: 501039,
          requestId: 'api-dataset',
          params: { status: response.status },
        }),
      );
    }
    return JSON.parse(response.data);
  };
  return {
    async getCatalog(input) {
      const data = (await fetchJson('/catalog', {
        datasetId: input.datasetId,
        parentId: input.parentId,
      })) as { nodes?: unknown[] };
      return data.nodes ?? (Array.isArray(data) ? data : []);
    },
    async getPathNames(input) {
      const data = (await fetchJson('/path-names', {
        datasetId: input.datasetId,
        nodeId: input.nodeId,
      })) as { path?: string } | string;
      return typeof data === 'string' ? data : (data.path ?? '');
    },
    async list(input) {
      const data = (await fetchJson('/list', {
        datasetId: input.datasetId,
        parentId: input.parentId,
        keyword: input.keyword,
      })) as { list?: unknown[]; isImported?: boolean };
      return { list: data.list ?? [], isImported: data.isImported ?? false };
    },
    async listExistId(input) {
      const data = (await fetchJson('/list-exist-id', {
        datasetId: input.datasetId,
        apiConfigId: input.apiConfigId,
      })) as unknown[] | { fileIds?: unknown[] };
      return Array.isArray(data) ? data : (data.fileIds ?? []);
    },
  };
}

/** 真实 previewChunks：@kb/parse 解析字节 + @kb/chunk 按 ChunkPolicy 确定性切分。 */
export async function parseAndChunkPreview(input: {
  bytes: Uint8Array;
  extension: string;
  teamId: string;
  datasetId: string;
  fileRef: string;
  timeoutMs: number;
  policy?: Partial<ChunkPolicy>;
}): Promise<{ rawText: string; chunks: ChunkItem[] }> {
  const parser = createDefaultDocumentParser();
  const parseRequest: DocumentParseContext = {
    teamId: input.teamId,
    datasetId: input.datasetId,
    fileRef: input.fileRef,
    extension: input.extension,
    timeoutMs: input.timeoutMs,
    bytes: input.bytes,
  };
  const parsed = await parser.parse(parseRequest);
  const policy: ChunkPolicy = { ...DEFAULT_CHUNK_POLICY, ...(input.policy ?? {}) };
  const output = chunkText({ text: parsed.rawText, policy });
  return { rawText: parsed.rawText, chunks: output.chunks };
}
