import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import { DEFAULT_CHUNK_POLICY, chunkText, type ChunkItem, type ChunkPolicy } from '@kb/chunk';
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
