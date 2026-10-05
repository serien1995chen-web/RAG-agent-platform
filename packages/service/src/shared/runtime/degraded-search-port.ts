import type { SearchRequest, SearchResult } from '@kb/contracts';
import type { DatasetSearchPort } from '../../ports/capabilities';

/**
 * 骨架期检索 Adapter 占位（设计文档 11.0 降级规则）：
 * 尚未接入向量/全文 Adapter 时返回空 citations，但必须在 stats.degraded[] 显式记录每一路失败，
 * 禁止把未执行检索伪装成完整结果。接入真实 Adapter 后删除本实现。
 */
export function createDegradedDatasetSearchPort(
  reason = 'adapter_not_configured',
): DatasetSearchPort {
  const build = (request: SearchRequest): SearchResult => ({
    citations: [],
    stats: {
      searchMode: request.searchMode,
      usingReRank: false,
      usingSimilarityFilter: request.similarity > 0,
      embeddingTokens: 0,
      rerankInputTokens: 0,
      degraded: [
        { stage: 'vector', reason },
        { stage: 'fullText', reason },
      ],
      durationMs: 0,
    },
  });
  return {
    search: async (request) => build(request),
    searchBatch: async (requests) => requests.map((request) => build(request)),
  };
}
