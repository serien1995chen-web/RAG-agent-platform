import { createHash, randomUUID } from 'node:crypto';
import {
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchApiResponseSchema,
  buildIndexVersion,
  createKnowledgeError,
  toPipelineSearchRequest,
  type CitationApi,
  type KnowledgeErrorCode,
  type KnowledgeProblem,
  type MultiSpaceSearchApiRequest,
  type SearchApiMode,
  type SearchApiRequest,
  type SearchApiResponse,
  type SearchImagePreviewApi,
} from '@kb/contracts';
import {
  compileSearchFilter,
  createSearchEngine,
  finalizeSearchCandidates,
  mergeMultiSpaceCitations,
  type AuthorizedCandidate,
  type ChannelFailure,
  type SearchEngineDeps,
  type SearchFilterSummary,
  type SearchQueryExpansionResult,
} from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';
import type {
  S7AuthorizedSpace,
  S7CandidateCollection,
  S7SearchPersistenceMode,
  S7SearchApplicationDependencies,
} from './s7-search.ports';
import { preservesQueryOptimizationFacts } from './s7-query-facts';
import {
  buildPublicSearchItem,
  issueSearchImagePreviews,
  searchCandidateKey,
} from './s7-search-public-response';

interface SpaceExecution {
  candidates: AuthorizedCandidate[];
  degradedCodes: string[];
  failedChannels: ChannelFailure[];
  partial: boolean;
  rerankApplied: boolean;
  filterSummary?: SearchFilterSummary;
  queryExpansions: SearchQueryExpansionResult[];
  usage: { inputTokens: number; outputTokens: number };
}

function citationKey(knowledgeSpaceId: string, segmentId: string): string {
  return `${knowledgeSpaceId}:${segmentId}`;
}

function issueDetails(error: unknown): Array<{ path: string; message: string }> {
  if (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues?: unknown[] }).issues)
  ) {
    return (error as { issues: Array<{ path?: unknown[]; message?: unknown }> }).issues.map(
      (issue) => ({
        path: Array.isArray(issue.path) ? issue.path.join('.') : '',
        message: typeof issue.message === 'string' ? issue.message : 'invalid',
      }),
    );
  }
  return [];
}

function validationError(context: TenantContext, error: unknown) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { issues: issueDetails(error) },
  });
}

function problemOf(error: unknown): KnowledgeProblem | undefined {
  return typeof error === 'object' && error !== null && 'problem' in error
    ? (error as { problem?: KnowledgeProblem }).problem
    : undefined;
}

function statusOf(error: unknown): 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504 {
  const code = problemOf(error)?.error.code;
  if (code === 'KNOWLEDGE_VALIDATION_FAILED') return 400;
  if (code === 'KNOWLEDGE_AUTH_REQUIRED') return 401;
  if (code === 'KNOWLEDGE_FORBIDDEN') return 403;
  if (code === 'KNOWLEDGE_NOT_FOUND') return 404;
  if (code === 'KNOWLEDGE_RATE_LIMITED' || code === 'KNOWLEDGE_QUOTA_EXCEEDED') return 429;
  if (code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') return 504;
  if (code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE') return 503;
  if (
    code === 'KNOWLEDGE_MODEL_FAILED' ||
    code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID' ||
    code === 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID'
  ) {
    return 502;
  }
  return 500;
}

function failureOf(error: unknown, mode: SearchApiMode): ChannelFailure {
  const observedStatus = statusOf(error);
  const status: ChannelFailure['status'] =
    observedStatus === 429 ||
    observedStatus === 502 ||
    observedStatus === 503 ||
    observedStatus === 504
      ? observedStatus
      : 500;
  const channel: ChannelFailure['channel'] = mode === 'fulltext' ? 'fullText' : 'embedding';
  return {
    channel,
    kind:
      status === 504
        ? 'timeout'
        : status === 429
          ? 'rate_limit'
          : status === 503
            ? 'unavailable'
            : status === 502
              ? 'model'
              : 'internal',
    degradedCode: channel === 'fullText' ? 'fulltext_recall_failed' : 'vector_recall_failed',
    status,
  };
}

function codeForStatus(status: number): KnowledgeErrorCode {
  if (status === 504) return 'KNOWLEDGE_DEPENDENCY_TIMEOUT';
  if (status === 429) return 'KNOWLEDGE_RATE_LIMITED';
  if (status === 503) return 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE';
  if (status === 502) return 'KNOWLEDGE_MODEL_FAILED';
  return 'KNOWLEDGE_INTERNAL_ERROR';
}

function highestPriorityStatus(statuses: readonly number[]): number {
  return (
    [504, 429, 503, 502, 500].find((status) => statuses.includes(status)) ?? Math.max(...statuses)
  );
}

function searchTimeout(context: TenantContext, timeoutMs: number) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { dependency: 'search', timeoutMs },
  });
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  context: TenantContext,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        onTimeout?.();
        reject(searchTimeout(context, timeoutMs));
      },
      Math.max(1, timeoutMs),
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function chatContent(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

export class S7SearchApplication {
  constructor(private readonly input: S7SearchApplicationDependencies) {}

  private now(): Date {
    return this.input.now?.() ?? new Date();
  }

  private searchId(): string {
    return this.input.searchIdFactory?.() ?? `search_${randomUUID()}`;
  }

  private parseSingle(
    body: unknown,
    mode: SearchApiMode,
    context: TenantContext,
  ): SearchApiRequest {
    const parsed = SearchApiRequestSchema.safeParse(body);
    if (!parsed.success) throw validationError(context, parsed.error);
    if (parsed.data.searchMode !== undefined && parsed.data.searchMode !== mode) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          field: 'searchMode',
          expected: mode,
          actual: parsed.data.searchMode,
        },
      });
    }
    return parsed.data;
  }

  private parseMulti(body: unknown, context: TenantContext): MultiSpaceSearchApiRequest {
    const parsed = MultiSpaceSearchApiRequestSchema.safeParse(body);
    if (!parsed.success) throw validationError(context, parsed.error);
    return parsed.data;
  }

  private async executeSpace(
    request: SearchApiRequest | MultiSpaceSearchApiRequest,
    space: S7AuthorizedSpace,
    mode: SearchApiMode,
    context: TenantContext,
    finalization: 'complete' | 'defer',
  ): Promise<SpaceExecution> {
    const filterFacts = await this.input.filters.listFilterFacts(
      space.spaceId,
      request.filters?.sourceIds,
      context,
    );
    const compiled = compileSearchFilter(
      request.filters,
      filterFacts.facts,
      filterFacts.definitions,
      { requestId: context.requestId, traceId: context.traceId },
    );
    if (compiled.emptyMatch) {
      return {
        candidates: [],
        degradedCodes: [],
        failedChannels: [],
        partial: false,
        rerankApplied: false,
        filterSummary: compiled.summary,
        queryExpansions: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    const models = await this.input.models.resolveModels(
      space.spaceId,
      request.usingRerank,
      context,
      request.rerankModelId,
    );
    const queryExpansion = this.queryExpansionFor(
      [space.spaceId],
      context,
      request,
      models.llm?.modelId,
    );
    const pipeline = this.input.pipeline.create({
      space,
      models,
      usingRerank: request.usingRerank,
      context,
      ...(queryExpansion ? { queryExpansion } : {}),
    });
    const internalRequest = toPipelineSearchRequest(request, {
      requestId: context.requestId,
      workspaceId: context.workspaceId,
      memberId: context.memberId,
      models: {
        embeddingModel: models.embedding.modelId,
        ...(request.usingRerank
          ? { rerankModel: models.rerank?.modelId ?? 'rerank-not-configured' }
          : {}),
      },
      mode,
      limit: 10,
      knowledgeSpaceIds: [space.spaceId],
      indexVersion: buildIndexVersion(models.embedding.modelId, models.embedding.dimension, 'v1'),
    });
    internalRequest.sourceIds = compiled.allowedSourceIds;
    const result = await createSearchEngine(pipeline, { finalization }).search(
      internalRequest,
      context,
    );
    return {
      candidates: result.authorizedCandidates,
      degradedCodes: [
        ...result.stats.degraded.map((entry) => entry.reason),
        ...(result.queryExpansions.some(
          (entry) => entry.fallbackReason === 'query_optimization_failed',
        )
          ? ['query_optimization_failed']
          : []),
      ],
      failedChannels: result.failedChannels,
      partial: result.stats.partial ?? false,
      rerankApplied: result.stats.rerankApplied ?? false,
      filterSummary: compiled.summary,
      queryExpansions: result.queryExpansions,
      usage: result.modelUsage,
    };
  }

  private queryExpansionFor(
    spaceIds: readonly string[],
    context: TenantContext,
    request: SearchApiRequest | MultiSpaceSearchApiRequest,
    boundLlmModelId?: string,
  ): SearchEngineDeps['queryExpansion'] | undefined {
    if (!this.input.synonymExpansion && !request.queryOptimizationEnabled) return undefined;
    const cache = new Map<string, Promise<SearchQueryExpansionResult>>();
    return {
      expand: (query) => {
        const cached = cache.get(query);
        if (cached) return cached;
        const pending = (async () => {
          let optimizedQuery = query;
          let optimizationFailed = false;
          if (request.queryOptimizationEnabled) {
            const modelId = request.queryOptimizationModelId ?? boundLlmModelId;
            if (!modelId || !this.input.modelGateway) {
              optimizationFailed = true;
            } else {
              try {
                const result = await this.input.modelGateway.invoke<{
                  choices: Array<{ message: { content: string } }>;
                }>({
                  kind: 'llm',
                  modelId,
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Rewrite the user question into a concise standalone search query. Return only the rewritten query, without explanation or quotation marks.',
                    },
                    {
                      role: 'user',
                      content: [
                        request.queryOptimizationPrompt
                          ? `Background:\n${request.queryOptimizationPrompt}`
                          : '',
                        `Question:\n${query}`,
                      ]
                        .filter(Boolean)
                        .join('\n\n'),
                    },
                  ],
                  maxOutputTokens: 512,
                  workspaceId: context.workspaceId,
                  knowledgeSpaceId: spaceIds[0] ?? null,
                  requestId: context.requestId,
                  traceId: context.traceId,
                  context,
                  operation: 'search:query_optimization',
                  resourceType: 'space',
                  ...(spaceIds[0] ? { resourceId: spaceIds[0] } : {}),
                  audit: { promptVersion: 'query-optimization@1' },
                });
                const generated = chatContent(result.data)
                  .replace(/^```(?:text)?\s*/i, '')
                  .replace(/\s*```$/i, '')
                  .trim();
                if (
                  !generated ||
                  generated.length > 20_000 ||
                  !preservesQueryOptimizationFacts({
                    query,
                    ...(request.queryOptimizationPrompt
                      ? { background: request.queryOptimizationPrompt }
                      : {}),
                    rewritten: generated,
                  })
                ) {
                  optimizationFailed = true;
                } else {
                  optimizedQuery = generated;
                }
              } catch {
                optimizationFailed = true;
              }
            }
          }
          if (this.input.synonymExpansion) {
            try {
              const expanded = await this.input.synonymExpansion.expand(
                { query: optimizedQuery, spaceIds },
                context,
              );
              return {
                ...expanded.result,
                originalQuery: query,
                ...(optimizationFailed
                  ? { fallbackReason: 'query_optimization_failed' as const }
                  : {}),
              };
            } catch {
              optimizationFailed = true;
            }
          }
          return {
            originalQuery: query,
            expandedQuery: optimizedQuery,
            hits: [],
            normalizedStandardTerms: [],
            appliedMappingIds: [],
            fallbackReason: optimizationFailed ? ('query_optimization_failed' as const) : null,
          };
        })();
        cache.set(query, pending);
        return pending;
      },
    };
  }

  private safeQueryExpansionSummary(
    expansions: readonly SearchQueryExpansionResult[],
  ): Record<string, unknown> {
    const deduped = [
      ...new Map(
        expansions.map((expansion) => [
          `${expansion.originalQuery}\0${expansion.expandedQuery}\0${expansion.fallbackReason ?? ''}`,
          expansion,
        ]),
      ).values(),
    ];
    const spaces = new Map<string, { fileVersion: number; mappingIds: Set<string> }>();
    for (const expansion of deduped) {
      for (const hit of expansion.hits) {
        const known = spaces.get(hit.knowledgeSpaceId) ?? {
          fileVersion: hit.fileVersion,
          mappingIds: new Set<string>(),
        };
        known.fileVersion = Math.max(known.fileVersion, hit.fileVersion);
        known.mappingIds.add(hit.logicalMappingId);
        spaces.set(hit.knowledgeSpaceId, known);
      }
    }
    return {
      queryCount: deduped.length,
      hitCount: deduped.reduce((total, expansion) => total + expansion.hits.length, 0),
      fallbackReasons: [
        ...new Set(
          deduped
            .map((expansion) => expansion.fallbackReason)
            .filter((reason): reason is NonNullable<typeof reason> => reason !== null),
        ),
      ].sort(),
      queryHashes: deduped.map((expansion) => ({
        original: createHash('sha256').update(expansion.originalQuery, 'utf8').digest('hex'),
        expanded: createHash('sha256').update(expansion.expandedQuery, 'utf8').digest('hex'),
        originalCodePoints: [...expansion.originalQuery].length,
        expandedCodePoints: [...expansion.expandedQuery].length,
      })),
      spaces: [...spaces.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([knowledgeSpaceId, value]) => ({
          knowledgeSpaceId,
          fileVersion: value.fileVersion,
          mappingIds: [...value.mappingIds].sort(),
        })),
    };
  }

  private response(input: {
    searchId: string;
    mode: SearchApiResponse['mode'];
    candidates: readonly AuthorizedCandidate[];
    citations: ReadonlyMap<string, CitationApi>;
    partial: boolean;
    durationMs: number;
    degradedCodes: readonly string[];
    rerankApplied: boolean;
    imagePreviews?: ReadonlyMap<string, SearchImagePreviewApi>;
  }): SearchApiResponse {
    const items = input.candidates.map((candidate, index) => {
      const citation = input.citations.get(
        citationKey(candidate.knowledgeSpaceId, candidate.segmentId),
      );
      if (!citation) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: input.searchId,
          traceId: input.searchId,
          details: { reason: 'citation_missing', index },
        });
      }
      const imagePreview = input.imagePreviews?.get(searchCandidateKey(candidate));
      return buildPublicSearchItem({
        candidate,
        citation,
        ...(imagePreview ? { imagePreview } : {}),
      });
    });
    return SearchApiResponseSchema.parse({
      searchId: input.searchId,
      mode: input.mode,
      items,
      partial: input.partial,
      durationMs: input.durationMs,
      degraded: [...new Set(input.degradedCodes)],
      rerankApplied: input.rerankApplied,
    });
  }

  private async persist(
    input: {
      searchId: string;
      mode: S7SearchPersistenceMode;
      spaceId: string;
      candidates: readonly AuthorizedCandidate[];
      partial: boolean;
      durationMs: number;
      degradedCodes: string[];
      filterSummary?: SearchFilterSummary;
      queryExpansions?: readonly SearchQueryExpansionResult[];
      deadlineAt?: number;
      signal?: AbortSignal;
    },
    context: TenantContext,
  ): Promise<ReadonlyMap<string, CitationApi>> {
    return this.input.citations.issueWithAudit(
      {
        ...input,
        searchMode: input.mode,
        now: this.now(),
        queryExpansions: input.queryExpansions ?? [],
        queryExpansionSummary: this.safeQueryExpansionSummary(input.queryExpansions ?? []),
      },
      context,
    );
  }

  private async persistWithDeadline(
    input: {
      searchId: string;
      mode: S7SearchPersistenceMode;
      spaceId: string;
      candidates: readonly AuthorizedCandidate[];
      partial: boolean;
      durationMs: number;
      degradedCodes: string[];
      filterSummary?: SearchFilterSummary;
      queryExpansions?: readonly SearchQueryExpansionResult[];
      deadlineAt: number;
    },
    context: TenantContext,
  ): Promise<ReadonlyMap<string, CitationApi>> {
    const abort = new AbortController();
    const timeoutMs = Math.max(1, input.deadlineAt - Date.now());
    return withDeadline(
      this.persist(
        {
          ...input,
          signal: abort.signal,
        },
        context,
      ),
      timeoutMs,
      context,
      () => abort.abort(searchTimeout(context, timeoutMs)),
    );
  }

  private async auditFailure(
    input: {
      searchId: string;
      mode: S7SearchPersistenceMode;
      spaceId: string;
      durationMs: number;
      degradedCodes: string[];
      failureCode?: string;
    },
    context: TenantContext,
  ): Promise<void> {
    await this.input.audits.appendSearch(
      {
        ...input,
        searchMode: input.mode,
        outcome: 'failed',
        partial: false,
        resultCount: 0,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      },
      context,
    );
  }

  async searchSemantic(body: unknown, context: TenantContext): Promise<SearchApiResponse> {
    return this.searchSingle('semantic', body, context);
  }

  async searchFulltext(body: unknown, context: TenantContext): Promise<SearchApiResponse> {
    return this.searchSingle('fulltext', body, context);
  }

  async searchHybrid(body: unknown, context: TenantContext): Promise<SearchApiResponse> {
    return this.searchSingle('hybrid', body, context);
  }

  async searchSingle(
    mode: SearchApiMode,
    body: unknown,
    context: TenantContext,
  ): Promise<SearchApiResponse> {
    this.input.access.assertSearchScope(context);
    const request = this.parseSingle(body, mode, context);
    const searchId = this.searchId();
    const startedAt = Date.now();
    const timeoutMs = this.input.totalTimeoutMs?.single ?? 30_000;
    try {
      const space = await withDeadline(
        this.input.access.getAuthorizedSpace(request.knowledgeSpaceId, context),
        timeoutMs,
        context,
      );
      const executionBudgetMs = timeoutMs - (Date.now() - startedAt);
      if (executionBudgetMs < 1) throw searchTimeout(context, timeoutMs);
      const execution = await withDeadline(
        this.executeSpace(request, space, mode, context, 'complete'),
        executionBudgetMs,
        context,
      );
      const imagePreviews = await issueSearchImagePreviews({
        candidates: execution.candidates,
        previews: this.input.imagePreviews,
        context,
      });
      const degradedCodes = [
        ...new Set([...execution.degradedCodes, ...imagePreviews.degradedCodes]),
      ];
      const partial = degradedCodes.some(
        (code) =>
          code === 'vector_recall_failed' ||
          code === 'fulltext_recall_failed' ||
          code.startsWith('space_'),
      );
      const durationMs = Date.now() - startedAt;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs < 1) throw searchTimeout(context, timeoutMs);
      const citations = await this.persistWithDeadline(
        {
          searchId,
          mode,
          spaceId: space.spaceId,
          candidates: execution.candidates,
          partial,
          durationMs,
          degradedCodes,
          queryExpansions: execution.queryExpansions,
          deadlineAt: startedAt + timeoutMs,
          ...(execution.filterSummary ? { filterSummary: execution.filterSummary } : {}),
        },
        context,
      );
      return this.response({
        searchId,
        mode,
        candidates: execution.candidates,
        citations,
        partial,
        durationMs,
        degradedCodes,
        rerankApplied: execution.rerankApplied,
        imagePreviews: imagePreviews.items,
      });
    } catch (error) {
      await this.auditFailure(
        {
          searchId,
          mode,
          spaceId: request.knowledgeSpaceId,
          durationMs: Date.now() - startedAt,
          degradedCodes: [],
          failureCode: problemOf(error)?.error.code ?? 'KNOWLEDGE_INTERNAL_ERROR',
        },
        context,
      );
      throw error;
    }
  }

  async searchMultiSpace(body: unknown, context: TenantContext): Promise<SearchApiResponse> {
    this.input.access.assertSearchScope(context);
    const request = this.parseMulti(body, context);
    const mode = request.searchMode ?? 'hybrid';
    const knowledgeSpaceIds = [...new Set(request.knowledgeSpaceIds)];
    const searchId = this.searchId();
    const startedAt = Date.now();
    const timeoutMs = this.input.totalTimeoutMs?.multi ?? 60_000;
    try {
      const spaces = await withDeadline(
        Promise.all(
          knowledgeSpaceIds.map((spaceId) =>
            this.input.access.getAuthorizedSpace(spaceId, context),
          ),
        ),
        timeoutMs,
        context,
      );
      const searchBudgetMs = timeoutMs - (Date.now() - startedAt);
      if (searchBudgetMs < 1) throw searchTimeout(context, timeoutMs);
      const outcomes = await withDeadline(
        Promise.all(
          spaces.map(
            async (
              space,
            ): Promise<{
              space: S7AuthorizedSpace;
              execution?: SpaceExecution;
              error?: unknown;
            }> => {
              try {
                return {
                  space,
                  execution: await this.executeSpace(request, space, mode, context, 'defer'),
                };
              } catch (error) {
                if (statusOf(error) === 400) throw error;
                return { space, error };
              }
            },
          ),
        ),
        searchBudgetMs,
        context,
      );
      const succeeded = outcomes.filter(
        (entry): entry is { space: S7AuthorizedSpace; execution: SpaceExecution } =>
          entry.execution !== undefined,
      );
      const failed = outcomes.filter(
        (entry): entry is { space: S7AuthorizedSpace; error: unknown } => entry.error !== undefined,
      );
      if (succeeded.length === 0) {
        const status = highestPriorityStatus(failed.map((entry) => statusOf(entry.error)));
        throw createKnowledgeError({
          code: codeForStatus(status),
          requestId: context.requestId,
          traceId: context.traceId,
          details: { failedSpaceCount: failed.length },
        });
      }
      const slices = outcomes.map((entry) => {
        if (entry.execution !== undefined) {
          return {
            knowledgeSpaceId: entry.space.spaceId,
            candidates: entry.execution.candidates,
            partial: entry.execution.partial,
            failedChannels: entry.execution.failedChannels,
          };
        }
        const failure = failureOf(entry.error, mode);
        return {
          knowledgeSpaceId: entry.space.spaceId,
          failure,
        };
      });
      const merged = mergeMultiSpaceCitations(slices);
      let internalRequest: ReturnType<typeof toPipelineSearchRequest>;
      try {
        internalRequest = toPipelineSearchRequest(request, {
          requestId: context.requestId,
          workspaceId: context.workspaceId,
          memberId: context.memberId,
          models: { embeddingModel: 'multi-space' },
          mode,
          limit: 10,
          knowledgeSpaceIds,
        });
      } catch (error) {
        throw validationError(context, error);
      }
      const rerankApplied = succeeded.some((entry) => entry.execution.rerankApplied);
      const finalized = finalizeSearchCandidates(internalRequest, merged.candidates, rerankApplied);
      const imagePreviews = await issueSearchImagePreviews({
        candidates: finalized.items,
        previews: this.input.imagePreviews,
        context,
      });
      const degradedCodes = [
        ...new Set([
          ...succeeded.flatMap((entry) => entry.execution.degradedCodes),
          ...merged.degraded.map((entry) => entry.reason),
          ...imagePreviews.degradedCodes,
        ]),
      ];
      const partial = merged.partial;
      const queryExpansions = succeeded.flatMap((entry) => entry.execution.queryExpansions);
      const durationMs = Date.now() - startedAt;
      const filterSummary = succeeded.find((entry) => entry.execution.filterSummary)?.execution
        .filterSummary;
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs < 1) throw searchTimeout(context, timeoutMs);
      const citations = await this.persistWithDeadline(
        {
          searchId,
          mode: 'multi_space',
          spaceId: request.knowledgeSpaceId,
          candidates: finalized.items,
          partial,
          durationMs,
          degradedCodes,
          queryExpansions,
          deadlineAt: startedAt + timeoutMs,
          ...(filterSummary ? { filterSummary } : {}),
        },
        context,
      );
      return this.response({
        searchId,
        mode: 'multi_space',
        candidates: finalized.items,
        citations,
        partial,
        durationMs,
        degradedCodes,
        rerankApplied,
        imagePreviews: imagePreviews.items,
      });
    } catch (error) {
      await this.auditFailure(
        {
          searchId,
          mode: 'multi_space',
          spaceId: request.knowledgeSpaceId,
          durationMs: Date.now() - startedAt,
          degradedCodes: [],
          failureCode: problemOf(error)?.error.code ?? 'KNOWLEDGE_INTERNAL_ERROR',
        },
        context,
      );
      throw error;
    }
  }

  async collectCandidates(input: {
    request: SearchApiRequest | MultiSpaceSearchApiRequest;
    knowledgeSpaceIds: readonly string[];
    mode: SearchApiMode;
    context: TenantContext;
    limit?: number;
  }): Promise<S7CandidateCollection> {
    this.input.access.assertSearchScope(input.context);
    const knowledgeSpaceIds = [...new Set(input.knowledgeSpaceIds)];
    if (knowledgeSpaceIds.length < 1 || knowledgeSpaceIds.length > 20) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { field: 'knowledgeSpaceIds', min: 1, max: 20 },
      });
    }
    const spaces = await Promise.all(
      knowledgeSpaceIds.map((spaceId) =>
        this.input.access.getAuthorizedSpace(spaceId, input.context),
      ),
    );
    const outcomes = await Promise.all(
      spaces.map(async (space) => {
        try {
          return {
            space,
            execution: await this.executeSpace(
              input.request,
              space,
              input.mode,
              input.context,
              'defer',
            ),
          };
        } catch (error) {
          if (statusOf(error) === 400) throw error;
          return { space, error };
        }
      }),
    );
    const succeeded = outcomes.filter(
      (
        entry,
      ): entry is {
        space: S7AuthorizedSpace;
        execution: SpaceExecution;
      } => entry.execution !== undefined,
    );
    const failed = outcomes.filter(
      (entry): entry is { space: S7AuthorizedSpace; error: unknown } => entry.error !== undefined,
    );
    if (succeeded.length === 0) {
      const status = highestPriorityStatus(failed.map((entry) => statusOf(entry.error)));
      throw createKnowledgeError({
        code: codeForStatus(status),
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { failedSpaceCount: failed.length },
      });
    }
    const slices = outcomes.map((entry) =>
      entry.execution
        ? {
            knowledgeSpaceId: entry.space.spaceId,
            candidates: entry.execution.candidates,
            partial: entry.execution.partial,
            failedChannels: entry.execution.failedChannels,
          }
        : {
            knowledgeSpaceId: entry.space.spaceId,
            failure: failureOf(entry.error, input.mode),
          },
    );
    const merged = mergeMultiSpaceCitations(slices);
    const internalRequest = toPipelineSearchRequest(input.request, {
      requestId: input.context.requestId,
      workspaceId: input.context.workspaceId,
      memberId: input.context.memberId,
      models: { embeddingModel: 'multi-space' },
      mode: input.mode,
      limit: input.limit ?? 10,
      knowledgeSpaceIds,
    });
    const rerankApplied = succeeded.some((entry) => entry.execution.rerankApplied);
    const finalized = finalizeSearchCandidates(internalRequest, merged.candidates, rerankApplied);
    return {
      candidates: finalized.items,
      partial: merged.partial,
      degradedCodes: [
        ...succeeded.flatMap((entry) => entry.execution.degradedCodes),
        ...merged.degraded.map((entry) => entry.reason),
      ],
      rerankApplied,
      queryExpansions: succeeded.flatMap((entry) => entry.execution.queryExpansions),
      usage: succeeded.reduce(
        (total, entry) => ({
          inputTokens: total.inputTokens + entry.execution.usage.inputTokens,
          outputTokens: total.outputTokens + entry.execution.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
      ...(succeeded.find((entry) => entry.execution.filterSummary)
        ? {
            filterSummary: succeeded.find((entry) => entry.execution.filterSummary)!.execution
              .filterSummary!,
          }
        : {}),
    };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-SEARCH-SEMANTIC') {
      const data = await this.searchSemantic(input.body, input.context);
      return { status: data.partial ? 207 : 200, data };
    }
    if (input.operationId === 'API-SEARCH-FULLTEXT') {
      const data = await this.searchFulltext(input.body, input.context);
      return { status: data.partial ? 207 : 200, data };
    }
    if (input.operationId === 'API-SEARCH-HYBRID') {
      const data = await this.searchHybrid(input.body, input.context);
      return { status: data.partial ? 207 : 200, data };
    }
    if (input.operationId === 'API-SEARCH-MULTI') {
      const data = await this.searchMultiSpace(input.body, input.context);
      return {
        status: data.partial ? 207 : 200,
        data,
      };
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, application: 's7-search' },
    });
  }
}
