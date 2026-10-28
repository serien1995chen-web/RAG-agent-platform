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
export { createSearchEngine, finalizeSearchCandidates } from './engine';
export {
  applyTokenBudget,
  compareCandidates,
  dedupeCandidates,
  filterBySimilarity,
  fuseCandidates,
  mergeChannelCandidates,
  mergeReranked,
  mergeRerankRankedLists,
  minMaxNormalize,
  stableSortCandidates,
  trimCandidateText,
  truncateByLimit,
} from './fusion';
export {
  assertSafeTagRegex,
  compileDirectorySubtree,
  compileSearchFilter,
  evaluateTagCondition,
  evaluateTagConditions,
  normalizedDedupeText,
} from './filter';
export type {
  CompiledSearchFilter,
  FilterTagDefinition,
  FilterTagValue,
  SearchFilterSummary,
  SourceFilterFacts,
  TagType,
} from './filter';
export { mergeMultiSpaceCitations } from './multi';
export type { MultiSpaceMergeResult, MultiSpaceSearchSlice } from './multi';
export { recallCandidates } from './recall';
export {
  IMAGE_BLOCK_MIXED_WEIGHT,
  IMAGE_CAPTION_WEIGHT,
  IMAGE_VECTOR_WEIGHT,
  TEXT_BLOCK_WEIGHT,
  fuseImageChannels,
  fuseTextAndImageBlocks,
} from './image';
export { DEFAULT_RRF_K, rrfFuseWeighted } from './rrf';
export { deepBudgetOf, deepRoundSummary, deepStopReason } from './deep';
export type { DeepBudgetState, DeepStopInput, DeepStopReason } from './deep';
export type {
  Candidate,
  AuthorizedCandidate,
  AuthorizedSegmentSnapshot,
  AuthorizedSourceSnapshot,
  ChannelFailure,
  ChannelFailureKind,
  ChannelOutcome,
  SearchCandidateHydratorPort,
  RankedEntry,
  RecallOutcome,
  SearchEngineDeps,
  SearchEngineContext,
  SearchEngineOptions,
  SearchHydrationResult,
  SearchPipelineResult,
  SearchPipelinePort,
} from './types';
