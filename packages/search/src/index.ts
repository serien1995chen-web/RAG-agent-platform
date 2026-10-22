/**
 * @kb/search — 召回、加权融合、RRF 与 Rerank（CR-FEATURE-07，设计文档 11.x）。
 * 单路失败必须写入 stats.degraded[]，不得返回伪造的完整结果。
 */
import { SEARCH_BATCH_LIMIT, buildIndexVersion } from '@kb/contracts';
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

export { SEARCH_BATCH_LIMIT, buildIndexVersion };
export type { SearchRequest, SearchResult };
export { createSearchEngine } from './engine';
export {
  applyTokenBudget,
  dedupeCandidates,
  filterBySimilarity,
  fuseCandidates,
  mergeReranked,
  minMaxNormalize,
  truncateByLimit,
} from './fusion';
export { parseTagFilterMatch, recallCandidates } from './recall';
export { DEFAULT_RRF_K, rrfFuseWeighted } from './rrf';
export type {
  Candidate,
  RankedEntry,
  RecallOutcome,
  SearchEngineDeps,
  SearchEngineOptions,
  SearchPipelinePort,
} from './types';
