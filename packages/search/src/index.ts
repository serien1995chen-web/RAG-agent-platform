/**
 * @kb/search — 召回、加权融合、RRF 与 Rerank（CR-FEATURE-07，设计文档 11.x）。
 * 单路失败必须写入 stats.degraded[]，不得返回伪造的完整结果。
 */
import {
  ApiErrorException,
  SEARCH_BATCH_LIMIT,
  buildIndexVersion,
  createSkeletonError,
} from '@kb/contracts';
import type { SearchRequest, SearchResult } from '@kb/contracts';

export const PACKAGE_NAME = '@kb/search' as const;

export interface RankedItem {
  id: string;
  rank: number;
}

/** 设计文档 11.4.1 的 RRF 常数 k。 */
export const RRF_K = 60;

export function rrfFuse(
  rankedLists: readonly (readonly RankedItem[])[],
  k: number = RRF_K,
): Record<string, number> {
  const fused: Record<string, number> = {};
  for (const list of rankedLists) {
    for (const item of list) {
      fused[item.id] = (fused[item.id] ?? 0) + 1 / (k + item.rank);
    }
  }
  return fused;
}

export interface SearchEnginePort {
  search(request: SearchRequest): Promise<SearchResult>;
  searchBatch(requests: readonly SearchRequest[]): Promise<SearchResult[]>;
}

export function createDefaultSearchEngine(): SearchEnginePort {
  const reject = () =>
    Promise.reject(new ApiErrorException(createSkeletonError({ operation: 'search' }, 'search')));
  return { search: reject, searchBatch: reject };
}

/**
 * 骨架期显式降级引擎：尚未接入向量/全文 Adapter 时返回空 citations，
 * 但必须在 stats.degraded[] 记录每一路失败，禁止伪装成完整结果。
 */
export function createDegradedSearchEngine(reason = 'adapter_not_configured'): SearchEnginePort {
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
    searchBatch: async (requests) => requests.map(build),
  };
}

export { SEARCH_BATCH_LIMIT, buildIndexVersion };
export type { SearchRequest, SearchResult };
