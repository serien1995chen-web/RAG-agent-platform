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

export { SEARCH_BATCH_LIMIT, buildIndexVersion };
export type { SearchRequest, SearchResult };
