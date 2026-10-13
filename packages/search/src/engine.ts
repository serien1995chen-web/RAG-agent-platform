import { countTokens } from '@kb/chunk';
import { ApiErrorException, SEARCH_BATCH_LIMIT, createApiError } from '@kb/contracts';
import type {
  Citation,
  CitationScore,
  DegradedInfo,
  SearchRequest,
  SearchResult,
} from '@kb/contracts';
import {
  applyTokenBudget,
  dedupeCandidates,
  filterBySimilarity,
  fuseCandidates,
  mergeReranked,
  truncateByLimit,
} from './fusion';
import { rrfFuseWeighted } from './rrf';
import { recallCandidates } from './recall';
import type {
  Candidate,
  RankedEntry,
  SearchEngineDeps,
  SearchEngineOptions,
  SearchPipelinePort,
} from './types';

function error(
  request: SearchRequest,
  code: number,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId: request.requestId, params }));
}

function emptyResult(request: SearchRequest, degraded: DegradedInfo[]): SearchResult {
  return {
    citations: [],
    stats: {
      searchMode: request.searchMode,
      usingReRank: false,
      usingSimilarityFilter: request.similarity > 0,
      embeddingTokens: 0,
      rerankInputTokens: 0,
      degraded,
      durationMs: 0,
    },
  };
}

function hasType(candidate: Candidate, type: CitationScore['type']): boolean {
  return candidate.scores.some((score) => score.type === type);
}

function datasetIdOf(candidate: Candidate): string {
  return candidate.docId.split(':')[0] ?? '';
}

function validate(request: SearchRequest): void {
  const hasText = request.textQueries.some((query) => query.trim().length > 0);
  if (!hasText && request.imageQueries.length === 0) {
    throw error(request, 501049, { reason: 'text_or_image_query_required' });
  }
  if (request.limit < 1 || request.limit > 50) {
    throw error(request, 501050, {
      field: 'limit',
      value: request.limit,
      rangeOrVersion: '1-50',
    });
  }
  if (request.similarity < 0 || request.similarity > 1) {
    throw error(request, 501050, {
      field: 'similarity',
      value: request.similarity,
      rangeOrVersion: '0-1',
    });
  }
  if (request.weights) {
    if (request.weights.embedding < 0 || request.weights.embedding > 1) {
      throw error(request, 501050, {
        field: 'weights.embedding',
        value: request.weights.embedding,
        rangeOrVersion: '0-1',
      });
    }
    if (request.weights.rerank < 0 || request.weights.rerank > 1) {
      throw error(request, 501050, {
        field: 'weights.rerank',
        value: request.weights.rerank,
        rangeOrVersion: '0-1',
      });
    }
  }
  if (request.maxTokens <= 0) {
    throw error(request, 501050, {
      field: 'maxTokens',
      value: request.maxTokens,
      rangeOrVersion: 'positive',
    });
  }
}

function toRanked(
  candidates: readonly Candidate[],
  type: RankedEntry['type'],
  weight: number,
): RankedEntry[] {
  return candidates.map((candidate, index) => ({
    id: candidate.docId,
    rank: index + 1,
    weight,
    type,
  }));
}

function toCitation(candidate: Candidate, index: number, usingReRank: boolean): Citation {
  const scores: CitationScore[] = [
    ...candidate.scores,
    { type: 'rrf', value: candidate.score, index },
  ];
  if (usingReRank) scores.push({ type: 'reRank', value: candidate.score, index });
  return {
    dataId: candidate.itemId,
    chunkIndex: 0,
    datasetId: datasetIdOf(candidate),
    collectionId: candidate.collectionId || candidate.itemId,
    collectionName: 'pending',
    sourceName: 'pending',
    sourceType: 'virtual',
    quoteText: '',
    updateTime: new Date(0).toISOString(),
    scores,
  };
}

export function createSearchEngine(
  deps: SearchEngineDeps,
  options: SearchEngineOptions = {},
): SearchPipelinePort {
  const search = async (
    request: SearchRequest,
    context: { requestId: string; tenant: { teamId: string; tmbId: string } },
  ): Promise<SearchResult> => {
    const startedAt = Date.now();
    validate(request);
    const outcome = await recallCandidates(request, deps, context);
    const vectorItems = outcome.items.filter((candidate) => hasType(candidate, 'embedding'));
    const fullTextItems = outcome.items.filter((candidate) => hasType(candidate, 'fullText'));
    const weight = request.weights?.embedding ?? 0.5;

    let candidates =
      request.searchMode === 'mixedRecall'
        ? fuseCandidates(vectorItems, fullTextItems, weight)
        : request.searchMode === 'fullTextRecall'
          ? fullTextItems
          : vectorItems;

    const rankedLists: RankedEntry[][] = [];
    if (request.searchMode !== 'fullTextRecall') {
      rankedLists.push(toRanked(vectorItems, 'embedding', weight));
    }
    if (request.searchMode !== 'embedding') {
      rankedLists.push(toRanked(fullTextItems, 'fullText', 1 - weight));
    }
    const fused = rrfFuseWeighted(rankedLists);
    candidates = candidates
      .map((candidate) => ({
        ...candidate,
        score: fused.get(candidate.docId)?.rrf ?? candidate.score,
      }))
      .sort((a, b) => b.score - a.score);

    const degraded: DegradedInfo[] = [...outcome.degraded];
    let usingReRank = false;
    let rerankInputTokens = 0;
    if (request.models.rerankModel) {
      if (!deps.rerank) {
        degraded.push({ stage: 'rerank', reason: 'rerank_not_configured' });
      } else {
        try {
          const rerankItems = candidates.map((candidate) => ({
            id: candidate.docId,
            score: candidate.score,
          }));
          rerankInputTokens = countTokens(rerankItems.map((item) => item.id).join(' '));
          const reranked = await deps.rerank.rerank(
            {
              model: request.models.rerankModel,
              items: rerankItems,
              options: { timeoutMs: request.budgets?.rerankTimeoutMs ?? 10_000 },
            },
            context,
          );
          candidates = mergeReranked(candidates, reranked, request.weights?.rerank ?? 0.5).items;
          usingReRank = true;
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : String(caught);
          if ((options.rerankFailureMode ?? 'fallback') === 'strict') {
            throw error(request, 501064, {
              model: request.models.rerankModel,
              reason,
              requestId: request.requestId,
            });
          }
          degraded.push({ stage: 'rerank', reason });
        }
      }
    }

    if (deps.resolveTexts) {
      const texts = await deps.resolveTexts(candidates, context);
      candidates = candidates.map((candidate) => ({
        ...candidate,
        text: texts.get(candidate.docId) ?? candidate.text,
      }));
    }

    candidates = dedupeCandidates(candidates, (candidate) =>
      candidate.text.length > 0 ? candidate.text : candidate.docId,
    );
    if (request.similarity > 0) {
      candidates = filterBySimilarity(candidates, request.similarity);
    }
    candidates = applyTokenBudget(candidates, request.maxTokens, countTokens);
    candidates = truncateByLimit(candidates, request.limit);

    return {
      citations: candidates.map((candidate, index) => toCitation(candidate, index, usingReRank)),
      stats: {
        searchMode: request.searchMode,
        usingReRank,
        usingSimilarityFilter: request.similarity > 0,
        embeddingTokens: countTokens(request.textQueries.join(' ')),
        rerankInputTokens,
        degraded,
        durationMs: Date.now() - startedAt,
      },
    };
  };

  return {
    search,
    searchBatch: async (requests, context) => {
      if (requests.length > SEARCH_BATCH_LIMIT) {
        throw new ApiErrorException(
          createApiError({
            code: 501050,
            requestId: context.requestId,
            params: { field: 'requests', value: requests.length, rangeOrVersion: '1-10' },
          }),
        );
      }
      return Promise.all(
        requests.map(async (request) => {
          try {
            return await search(request, context);
          } catch (caught) {
            return emptyResult(request, [
              {
                stage: 'request',
                reason: caught instanceof Error ? caught.message : String(caught),
              },
            ]);
          }
        }),
      );
    },
  };
}
