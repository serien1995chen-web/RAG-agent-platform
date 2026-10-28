import { countTokens } from '@kb/chunk';
import {
  SEARCH_BATCH_LIMIT,
  createKnowledgeError,
  type Citation,
  type CitationScore,
  type DegradedInfo,
  type KnowledgeApiError,
  type KnowledgeErrorCode,
  type SearchRequest,
} from '@kb/contracts';
import {
  applyTokenBudget,
  compareCandidates,
  dedupeCandidates,
  filterBySimilarity,
  mergeChannelCandidates,
  mergeRerankRankedLists,
  stableSortCandidates,
  truncateByLimit,
} from './fusion';
import { rrfFuseWeighted } from './rrf';
import { recallCandidates } from './recall';
import type {
  AuthorizedCandidate,
  AuthorizedSegmentSnapshot,
  AuthorizedSourceSnapshot,
  Candidate,
  ChannelFailure,
  RankedEntry,
  SearchEngineDeps,
  SearchEngineContext,
  SearchEngineOptions,
  SearchPipelinePort,
  SearchPipelineResult,
} from './types';

const ERROR_PRIORITY: readonly ChannelFailure['status'][] = [504, 429, 503, 502, 500];

function error(
  request: SearchRequest,
  code: KnowledgeErrorCode,
  params: Record<string, unknown>,
): KnowledgeApiError {
  return createKnowledgeError({
    code,
    requestId: request.requestId,
    traceId: request.requestId,
    details: params,
  });
}

function emptyResult(request: SearchRequest, degraded: DegradedInfo[] = []): SearchPipelineResult {
  return {
    citations: [],
    authorizedCandidates: [],
    failedChannels: [],
    status: 200,
    stats: {
      searchMode: request.searchMode,
      usingReRank: false,
      usingSimilarityFilter: request.similarity > 0,
      embeddingTokens: 0,
      rerankInputTokens: 0,
      degraded,
      durationMs: 0,
      partial: false,
      rerankApplied: false,
    },
  };
}

function validate(request: SearchRequest): void {
  const hasText = request.textQueries.some((query) => query.trim().length > 0);
  if (!hasText) {
    throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'query',
      reason: 'text_query_required',
    });
  }
  if (request.imageQueries.length > 0) {
    throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'imageQueries',
      reason: 'image_search_not_supported_in_s7',
    });
  }
  if (request.limit < 1 || request.limit > 50) {
    throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'limit',
      value: request.limit,
      rangeOrVersion: '1-50',
    });
  }
  if (request.similarity < 0 || request.similarity > 1) {
    throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'similarity',
      value: request.similarity,
      rangeOrVersion: '0-1',
    });
  }
  if (request.maxTokens < 1 || request.maxTokens > 20_000) {
    throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'maxTokens',
      value: request.maxTokens,
      rangeOrVersion: '1-20000',
    });
  }
  if (request.weights) {
    if (request.weights.embedding < 0 || request.weights.embedding > 1) {
      throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'weights.embedding',
        value: request.weights.embedding,
        rangeOrVersion: '0-1',
      });
    }
    if (request.weights.rerank < 0 || request.weights.rerank > 1) {
      throw error(request, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'weights.rerank',
        value: request.weights.rerank,
        rangeOrVersion: '0-1',
      });
    }
  }
}

function failureCode(status: ChannelFailure['status']): KnowledgeErrorCode {
  if (status === 504) return 'KNOWLEDGE_DEPENDENCY_TIMEOUT';
  if (status === 429) return 'KNOWLEDGE_RATE_LIMITED';
  if (status === 503) return 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE';
  if (status === 502) return 'KNOWLEDGE_MODEL_FAILED';
  return 'KNOWLEDGE_INTERNAL_ERROR';
}

function throwAllChannelsFailed(
  request: SearchRequest,
  failures: readonly ChannelFailure[],
): never {
  const selected = [...failures].sort(
    (left, right) => ERROR_PRIORITY.indexOf(left.status) - ERROR_PRIORITY.indexOf(right.status),
  )[0];
  throw error(request, failureCode(selected?.status ?? 500), {
    failedChannels: failures.map((failure) => failure.channel),
    dependency: 'search_recall',
  });
}

function stableChannelSort(candidates: readonly Candidate[], channel: 'embedding' | 'fullText') {
  return [...candidates]
    .filter((candidate) =>
      channel === 'embedding'
        ? candidate.embeddingScore !== undefined
        : candidate.fullTextScore !== undefined,
    )
    .sort((left, right) => {
      const leftScore =
        channel === 'embedding' ? (left.embeddingScore ?? 0) : (left.fullTextScore ?? 0);
      const rightScore =
        channel === 'embedding' ? (right.embeddingScore ?? 0) : (right.fullTextScore ?? 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return compareCandidates({ ...left, score: 0 }, { ...right, score: 0 });
    });
}

function rankedList(
  candidates: readonly Candidate[],
  channel: RankedEntry['type'],
  weight: number,
): RankedEntry[] {
  return candidates.map((candidate, index) => ({
    id: candidate.docId,
    rank: index + 1,
    weight,
    type: channel,
  }));
}

function syntheticSegment(candidate: Candidate, workspaceId: string): AuthorizedSegmentSnapshot {
  const id = candidate.segmentId ?? candidate.docId;
  return {
    id,
    workspaceId,
    knowledgeSpaceId: candidate.knowledgeSpaceId,
    sourceId: candidate.sourceId ?? 'legacy-source',
    sourceVersion: candidate.segment?.sourceVersion ?? 1,
    order: 0,
    searchEnabled: true,
    question: '',
    answer: '',
    content: candidate.text,
    metadata: {},
    indexes: [],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    version: 1,
  };
}

function syntheticSource(candidate: Candidate, workspaceId: string): AuthorizedSourceSnapshot {
  return {
    id: candidate.sourceId ?? 'legacy-source',
    workspaceId,
    knowledgeSpaceId: candidate.knowledgeSpaceId,
    name: candidate.segmentId ?? candidate.docId,
    originalUrl: null,
    sourceVersion: 1,
    permissionRevision: 0,
    searchEnabled: true,
    deletedAt: null,
  };
}

function visibleTextOf(candidate: Candidate): string {
  if (candidate.text) return candidate.text;
  return [candidate.segment?.question, candidate.segment?.answer, candidate.segment?.content]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

async function hydrateCandidates(
  items: readonly Candidate[],
  deps: SearchEngineDeps,
  context: SearchEngineContext,
): Promise<AuthorizedCandidate[]> {
  if (deps.hydrator) {
    const hydrated = await deps.hydrator.hydrate(items, context);
    return mergeChannelCandidates(hydrated.items);
  }
  const texts = deps.resolveTexts ? await deps.resolveTexts(items, context) : new Map();
  return items.map((candidate) => {
    const segment = syntheticSegment(
      { ...candidate, text: texts.get(candidate.docId) ?? candidate.text },
      context.workspaceId,
    );
    const source = syntheticSource(candidate, context.workspaceId);
    return {
      ...candidate,
      segmentId: segment.id,
      sourceId: source.id,
      text: texts.get(candidate.docId) ?? candidate.text,
      segment,
      source,
    } as AuthorizedCandidate;
  });
}

function toCitation(
  candidate: AuthorizedCandidate,
  index: number,
  rerankApplied: boolean,
): Citation {
  const text = candidate.text;
  const scores: CitationScore[] = [
    ...candidate.scores,
    { type: 'rrf', value: candidate.score, index },
  ];
  if (rerankApplied && candidate.rerankScore !== undefined) {
    scores.push({ type: 'reRank', value: candidate.rerankScore, index });
  }
  return {
    citationId: `provisional:${candidate.knowledgeSpaceId}:${candidate.segmentId}:${index}`,
    segmentId: candidate.segmentId,
    sourceId: candidate.sourceId,
    knowledgeSpaceId: candidate.knowledgeSpaceId,
    title: candidate.source.name,
    sourceUrl: candidate.source.originalUrl,
    quoteText: [...text]
      .slice(candidate.citationRange?.start ?? 0, candidate.citationRange?.end ?? [...text].length)
      .join(''),
    updateTime: candidate.segment.updatedAt ?? new Date(0).toISOString(),
    scores,
  };
}

export function finalizeSearchCandidates(
  request: SearchRequest,
  candidates: readonly AuthorizedCandidate[],
  rerankApplied: boolean,
): { items: AuthorizedCandidate[]; usingSimilarityFilter: boolean } {
  const usingSimilarityFilter =
    request.similarity > 0 && (rerankApplied || request.searchMode === 'embedding');
  let items = dedupeCandidates(candidates, (candidate) => {
    return [
      candidate.segment?.question ?? '',
      candidate.segment?.answer ?? '',
      candidate.segment?.content ?? candidate.text,
      candidate.imageIdentity ?? '',
    ].join('\n');
  });
  items = stableSortCandidates(items);
  if (usingSimilarityFilter) {
    items = filterBySimilarity(items, request.similarity, (candidate) =>
      rerankApplied ? candidate.rerankScore : candidate.embeddingScore,
    );
  }
  items = applyTokenBudget(items, request.maxTokens, countTokens);
  items = stableSortCandidates(items);
  items = truncateByLimit(items, request.limit);
  return { items, usingSimilarityFilter };
}

function assertValidRerankOutput(
  request: SearchRequest,
  output: unknown,
): Array<{ id: string; score: number }> {
  if (
    !Array.isArray(output) ||
    output.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { id?: unknown }).id !== 'string' ||
        typeof (item as { score?: unknown }).score !== 'number' ||
        !Number.isFinite((item as { score: number }).score),
    )
  ) {
    throw error(request, 'KNOWLEDGE_MODEL_OUTPUT_INVALID', {
      field: 'rerankOutput',
    });
  }
  return output as Array<{ id: string; score: number }>;
}

export function createSearchEngine(
  deps: SearchEngineDeps,
  options: SearchEngineOptions = {},
): SearchPipelinePort {
  const search = async (
    request: SearchRequest,
    context: SearchEngineContext,
  ): Promise<SearchPipelineResult> => {
    const startedAt = Date.now();
    validate(request);
    const recall = await recallCandidates(request, deps, context);
    const attempted = recall.outcomes.filter((outcome) => outcome.attempted);
    const failures = attempted.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
    const successful = attempted.filter((outcome) => outcome.succeeded);
    if (attempted.length > 0 && successful.length === 0) {
      throwAllChannelsFailed(request, failures);
    }

    const hydrated = await hydrateCandidates(recall.items, deps, context);
    const merged = mergeChannelCandidates(hydrated);
    const vectorItems = stableChannelSort(merged, 'embedding');
    const fullTextItems = stableChannelSort(merged, 'fullText');
    const embeddingWeight = request.weights?.embedding ?? 0.5;
    const rankedLists: RankedEntry[][] = [];
    if (request.searchMode === 'embedding') {
      rankedLists.push(rankedList(vectorItems, 'embedding', 1));
    } else if (request.searchMode === 'fullTextRecall') {
      rankedLists.push(rankedList(fullTextItems, 'fullText', 1));
    } else {
      rankedLists.push(rankedList(vectorItems, 'embedding', embeddingWeight));
      rankedLists.push(rankedList(fullTextItems, 'fullText', 1 - embeddingWeight));
    }
    const fused = rrfFuseWeighted(rankedLists);
    let candidates = merged
      .filter((candidate) => fused.has(candidate.docId))
      .map((candidate) => ({ ...candidate, score: fused.get(candidate.docId)?.rrf ?? 0 }));
    candidates = stableSortCandidates(candidates);

    const degraded: DegradedInfo[] = [...recall.degraded];
    let rerankApplied = false;
    let rerankInputTokens = 0;
    if (request.models.rerankModel && candidates.length > 0) {
      const rerankItems = candidates.slice(0, 100).map((candidate) => ({
        id: candidate.docId,
        text: visibleTextOf(candidate),
        score: candidate.score,
      }));
      rerankInputTokens = countTokens(rerankItems.map((item) => item.text).join(' '));
      if (!deps.rerank) {
        degraded.push({ stage: 'rerank', reason: 'rerank_not_configured' });
      } else {
        try {
          const output = await deps.rerank.rerank(
            {
              model: request.models.rerankModel,
              query: request.textQueries[0] ?? '',
              items: rerankItems,
              options: { timeoutMs: request.budgets?.rerankTimeoutMs ?? 10_000 },
            },
            context,
          );
          const validated = assertValidRerankOutput(request, output);
          const mergedRerank = mergeRerankRankedLists(
            candidates,
            validated,
            request.weights?.rerank ?? 0.5,
          );
          candidates = mergedRerank.items as AuthorizedCandidate[];
          rerankApplied = mergedRerank.appliedIds.size > 0;
        } catch (caught) {
          if (
            typeof caught === 'object' &&
            caught !== null &&
            'problem' in caught &&
            (caught as KnowledgeApiError).problem.error.code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID'
          ) {
            throw caught;
          }
          if ((options.rerankFailureMode ?? 'fallback') === 'strict') {
            throw error(request, 'KNOWLEDGE_MODEL_FAILED', {
              model: request.models.rerankModel,
              reason: 'rerank_failed',
              requestId: request.requestId,
            });
          }
          candidates = stableSortCandidates(candidates);
          degraded.push({ stage: 'rerank', reason: 'rerank_failed' });
        }
      }
    }

    const partial = failures.length > 0 && successful.length > 0;
    const finalization = options.finalization ?? 'complete';
    const finalized =
      finalization === 'defer'
        ? {
            items: candidates,
            usingSimilarityFilter:
              request.similarity > 0 && (rerankApplied || request.searchMode === 'embedding'),
          }
        : finalizeSearchCandidates(request, candidates, rerankApplied);

    return {
      citations: finalized.items.map((candidate, index) =>
        toCitation(candidate, index, rerankApplied),
      ),
      authorizedCandidates: finalized.items,
      failedChannels: failures,
      status: partial ? 207 : 200,
      stats: {
        searchMode: request.searchMode,
        usingReRank: rerankApplied,
        usingSimilarityFilter: finalized.usingSimilarityFilter,
        embeddingTokens: countTokens(request.textQueries.join(' ')),
        rerankInputTokens,
        degraded,
        durationMs: Date.now() - startedAt,
        partial,
        rerankApplied,
      },
    };
  };

  return {
    search,
    searchBatch: async (requests, context) => {
      if (requests.length > SEARCH_BATCH_LIMIT) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          requestId: context.requestId,
          traceId: context.requestId,
          details: { field: 'requests', value: requests.length, rangeOrVersion: '1-10' },
        });
      }
      return Promise.all(
        requests.map(async (request) => {
          try {
            return await search(request, context);
          } catch (caught) {
            return emptyResult(request, [
              {
                stage: 'request',
                reason:
                  typeof caught === 'object' && caught !== null && 'problem' in caught
                    ? (caught as KnowledgeApiError).problem.error.code
                    : 'KNOWLEDGE_INTERNAL_ERROR',
              },
            ]);
          }
        }),
      );
    },
  };
}
