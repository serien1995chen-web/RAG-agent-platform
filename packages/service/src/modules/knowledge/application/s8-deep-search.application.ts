import { randomUUID } from 'node:crypto';
import {
  DeepPlannerOutputSchema,
  DeepSearchApiRequestSchema,
  DeepSearchApiResponseSchema,
  createKnowledgeError,
  type CitationApi,
  type DeepPlannerOutput,
  type DeepSearchApiRequest,
  type DeepSearchApiResponse,
  type SearchApiRequest,
  type SearchImagePreviewApi,
} from '@kb/contracts';
import {
  deepBudgetOf,
  deepRoundSummary,
  deepStopReason,
  type AuthorizedCandidate,
  type DeepStopReason,
} from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';
import type {
  S7CandidateCollection,
  S7CitationPersistencePort,
  S7ImagePreviewPort,
  S7SearchAccessPort,
  S7SearchAuditPort,
} from './s7-search.ports';
import type { S5ModelGatewayPort } from './s5-model-gateway.port';
import type { S8DeepCostPort, S8DeepSearchRepositoryPort } from './s8-image-deep.ports';
import {
  buildPublicSearchItem,
  issueSearchImagePreviews,
  searchCandidateKey,
} from './s7-search-public-response';
import { assertSafePointsMicros, pointsFromMicros } from '../domain/s10-usage';

interface ChatCompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
}

interface PlannerResult extends DeepPlannerOutput {
  usage: { inputTokens: number; outputTokens: number };
}

function candidateKey(candidate: AuthorizedCandidate): string {
  return `${candidate.knowledgeSpaceId}:${candidate.segmentId}`;
}

function pointsToMicros(points: number): number {
  const micros = Math.round(points * 1_000_000);
  return assertSafePointsMicros(micros);
}

function maxPermissionRevision(candidates: readonly AuthorizedCandidate[]): number {
  return candidates.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.source.permissionRevision),
    0,
  );
}

function permissionRevisions(candidates: readonly AuthorizedCandidate[]) {
  const revisions = new Map<
    string,
    { knowledgeSpaceId: string; sourceId: string; revision: number }
  >();
  for (const candidate of candidates) {
    revisions.set(`${candidate.knowledgeSpaceId}:${candidate.sourceId}`, {
      knowledgeSpaceId: candidate.knowledgeSpaceId,
      sourceId: candidate.sourceId,
      revision: candidate.source.permissionRevision,
    });
  }
  return [...revisions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function citationKey(spaceId: string, segmentId: string): string {
  return `${spaceId}:${segmentId}`;
}

function problemCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
    ? String((error as { problem: { error: { code: string } } }).problem.error.code)
    : 'KNOWLEDGE_INTERNAL_ERROR';
}

function invalidOutput(context: TenantContext, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason },
  });
}

function parsePlannerOutput(data: unknown, context: TenantContext): DeepPlannerOutput {
  if (typeof data !== 'object' || data === null) {
    throw invalidOutput(context, 'deep_planner_envelope_invalid');
  }
  const content = (data as Partial<ChatCompletionEnvelope>).choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw invalidOutput(context, 'deep_planner_content_missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidOutput(context, 'deep_planner_json_invalid');
  }
  const validated = DeepPlannerOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw invalidOutput(context, 'deep_planner_schema_invalid');
  }
  return validated.data;
}

function safeEvidenceSummary(candidates: readonly AuthorizedCandidate[]): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(
      `${candidate.source.name}: ${[candidate.text || candidate.segment.content]
        .join('')
        .slice(0, 400)}`,
    );
    if (rows.length >= 20) break;
  }
  return rows.join('\n');
}

export class S8DeepSearchApplication {
  constructor(
    private readonly input: {
      access: S7SearchAccessPort;
      repository: S8DeepSearchRepositoryPort;
      gateway: S5ModelGatewayPort;
      search: {
        collectCandidates(input: {
          request: SearchApiRequest;
          knowledgeSpaceIds: readonly string[];
          mode: 'hybrid';
          context: TenantContext;
          limit?: number;
        }): Promise<S7CandidateCollection>;
      };
      authorization: {
        reauthorizeCitation(
          input: {
            knowledgeSpaceId: string;
            sourceId: string;
            segmentId: string;
          },
          context: TenantContext,
        ): Promise<AuthorizedCandidate | undefined>;
      };
      citations: S7CitationPersistencePort;
      audits: S7SearchAuditPort;
      cost?: S8DeepCostPort;
      imagePreviews?: S7ImagePreviewPort;
      now?: () => Date;
      searchIdFactory?: () => string;
    },
  ) {}

  private parse(body: unknown, context: TenantContext): DeepSearchApiRequest {
    const parsed = DeepSearchApiRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }
    return parsed.data;
  }

  private async initialCostBudget(
    request: DeepSearchApiRequest,
    context: TenantContext,
  ): Promise<{ budgetMicros: number; availableMicros: number }> {
    const availableMicros = this.input.cost
      ? await this.input.cost.availablePointsMicros(context)
      : 0;
    const requestedMicros =
      request.costBudgetPoints === undefined
        ? availableMicros
        : pointsToMicros(request.costBudgetPoints);
    return {
      budgetMicros: Math.min(requestedMicros, availableMicros),
      availableMicros,
    };
  }

  private plannerCostMicros(remainingTokens: number): number {
    if (!this.input.cost) return 0;
    const outputTokens = Math.min(4_096, Math.max(1, remainingTokens));
    return this.input.cost.llmPointsMicros(Math.max(1, remainingTokens), outputTokens);
  }

  private searchCostMicros(query: string, remainingTokens: number, usingRerank: boolean): number {
    if (!this.input.cost) return 0;
    const embeddingTokens = Math.min(
      remainingTokens,
      Math.max(1, Math.ceil([...query].length / 4)),
    );
    const rerankTokens = usingRerank ? Math.max(1, remainingTokens) : 0;
    return (
      this.input.cost.embeddingPointsMicros(embeddingTokens) +
      this.input.cost.rerankPointsMicros(rerankTokens)
    );
  }

  private actualPlannerCostMicros(planner: PlannerResult): number {
    return (
      this.input.cost?.llmPointsMicros(planner.usage.inputTokens, planner.usage.outputTokens) ?? 0
    );
  }

  private actualSearchCostMicros(result: S7CandidateCollection): number {
    if (!this.input.cost) return 0;
    const embeddingTokens =
      result.usage.embeddingInputTokens ??
      Math.max(0, result.usage.inputTokens - (result.usage.rerankInputTokens ?? 0));
    return (
      this.input.cost.embeddingPointsMicros(embeddingTokens) +
      this.input.cost.rerankPointsMicros(result.usage.rerankInputTokens ?? 0) +
      this.input.cost.llmPointsMicros(
        result.usage.llmInputTokens ?? 0,
        result.usage.llmOutputTokens ?? result.usage.outputTokens,
      )
    );
  }

  private costQuotaError(
    context: TenantContext,
    reason: 'cost_budget_exhausted',
    input: {
      costBudgetMicros: number;
      committedCostMicros: number;
      estimatedCostMicros: number;
    },
  ) {
    return createKnowledgeError({
      code: 'KNOWLEDGE_QUOTA_EXCEEDED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        reason,
        costBudgetPoints: pointsFromMicros(input.costBudgetMicros),
        usedAiPoints: pointsFromMicros(input.committedCostMicros),
        estimatedAiPoints: pointsFromMicros(input.estimatedCostMicros),
      },
    });
  }

  private async refreshConfirmed(
    confirmed: Map<string, AuthorizedCandidate>,
    context: TenantContext,
  ): Promise<{ rejected: number }> {
    let rejected = 0;
    for (const [key, candidate] of confirmed) {
      const authorized = await this.input.authorization.reauthorizeCitation(
        {
          knowledgeSpaceId: candidate.knowledgeSpaceId,
          sourceId: candidate.sourceId,
          segmentId: candidate.segmentId,
        },
        context,
      );
      if (authorized) confirmed.set(key, authorized);
      else {
        confirmed.delete(key);
        rejected += 1;
      }
    }
    return { rejected };
  }

  private async plan(input: {
    request: DeepSearchApiRequest;
    modelId: string;
    round: number;
    searchId: string;
    confirmed: readonly AuthorizedCandidate[];
    remainingTokens: number;
    context: TenantContext;
  }): Promise<PlannerResult> {
    if (input.remainingTokens < 1) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_QUOTA_EXCEEDED',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { reason: 'deep_token_budget_exhausted' },
      });
    }
    const evidence = safeEvidenceSummary(input.confirmed);
    const result = await this.input.gateway.invoke<ChatCompletionEnvelope>({
      kind: 'llm',
      modelId: input.modelId,
      messages: [
        {
          role: 'system',
          content:
            'Return only a JSON object with queries (1-5 concise search queries) and sufficient boolean.',
        },
        {
          role: 'user',
          content: [
            `Question: ${input.request.query}`,
            `Round: ${input.round} of ${input.request.maxRounds}`,
            `Confirmed evidence count: ${new Set(input.confirmed.map(candidateKey)).size}`,
            evidence ? `Evidence summary:\n${evidence}` : 'Evidence summary: none',
          ].join('\n\n'),
        },
      ],
      maxOutputTokens: Math.max(1, Math.min(4_096, input.remainingTokens)),
      workspaceId: input.context.workspaceId,
      knowledgeSpaceId: input.request.knowledgeSpaceId,
      resourceType: 'space',
      resourceId: input.request.knowledgeSpaceId,
      operation: 's8.deep.planner',
      audit: {
        promptVersion: 's8.deep.planner.v1',
        mediaItemCount: 0,
        totalBytes: Buffer.byteLength(`${evidence}\n${input.request.query}`, 'utf8'),
      },
      requestId: `${input.searchId}:round:${input.round}`,
      traceId: input.context.traceId,
      context: input.context,
    });
    return {
      ...parsePlannerOutput(result.data, input.context),
      usage: result.usage,
    };
  }

  private searchRequest(
    request: DeepSearchApiRequest,
    query: string,
    tokenBudget: number,
  ): SearchApiRequest {
    return {
      knowledgeSpaceId: request.knowledgeSpaceId,
      query,
      tokenBudget,
      similarity: request.similarity,
      embeddingWeight: request.embeddingWeight,
      usingRerank: request.usingRerank,
      queryOptimizationEnabled: false,
      rerankWeight: request.rerankWeight,
      ...(request.filters ? { filters: request.filters } : {}),
    };
  }

  private response(input: {
    searchId: string;
    candidates: readonly AuthorizedCandidate[];
    citations: ReadonlyMap<string, CitationApi>;
    rounds: DeepSearchApiResponse['rounds'];
    stopReason: DeepStopReason;
    partial: boolean;
    durationMs: number;
    degradedCodes: readonly string[];
    rerankApplied: boolean;
    usage: DeepSearchApiResponse['usage'];
    imagePreviews?: ReadonlyMap<string, SearchImagePreviewApi>;
  }): DeepSearchApiResponse {
    return DeepSearchApiResponseSchema.parse({
      searchId: input.searchId,
      mode: 'multi_space',
      items: input.candidates.map((candidate) => {
        const citation = input.citations.get(
          citationKey(candidate.knowledgeSpaceId, candidate.segmentId),
        );
        if (!citation) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: input.searchId,
            traceId: input.searchId,
            details: { reason: 'deep_citation_missing' },
          });
        }
        const imagePreview = input.imagePreviews?.get(searchCandidateKey(candidate));
        return buildPublicSearchItem({
          candidate,
          citation,
          ...(imagePreview ? { imagePreview } : {}),
        });
      }),
      partial: input.partial,
      durationMs: input.durationMs,
      degraded: [...new Set(input.degradedCodes)],
      rerankApplied: input.rerankApplied,
      rounds: input.rounds,
      stopReason: input.stopReason,
      usage: input.usage,
    });
  }

  async search(body: unknown, context: TenantContext): Promise<DeepSearchApiResponse> {
    const request = this.parse(body, context);
    this.input.access.assertSearchScope(context);
    await Promise.all(
      [...new Set(request.knowledgeSpaceIds)].map((spaceId) =>
        this.input.access.getAuthorizedSpace(spaceId, context),
      ),
    );
    if (request.tokenBudget < 500) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_QUOTA_EXCEEDED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'deep_initial_budget_unavailable', tokenBudget: request.tokenBudget },
      });
    }
    const startedAt = Date.now();
    const searchId = this.input.searchIdFactory?.() ?? `search_${randomUUID()}`;
    const models = await this.input.repository.resolveModels(
      request.knowledgeSpaceId,
      request.usingRerank,
      context,
    );
    const costBudget = await this.initialCostBudget(request, context);
    const rounds: DeepSearchApiResponse['rounds'] = [];
    const confirmed = new Map<string, AuthorizedCandidate>();
    const degradedCodes: string[] = [];
    const executedQueries = new Set<string>();
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      aiPoints: 0,
      aiPointsMicros: 0,
      costBudgetPoints: pointsFromMicros(costBudget.budgetMicros),
      remainingAiPoints: pointsFromMicros(costBudget.budgetMicros),
    };
    let spentCostMicros = 0;
    let stopReason: DeepStopReason | null = null;
    let dependencyFailed = false;
    let searchPartial = false;
    let aclRevokedAll = false;
    let rerankApplied = false;
    const recordTerminalAudit = (
      outcome: 'succeeded' | 'failed',
      partial: boolean,
      resultCount: number,
      failureCode?: string,
    ) =>
      this.input.audits.appendSearch(
        {
          searchId,
          searchMode: 'deep',
          spaceId: request.knowledgeSpaceId,
          outcome,
          partial,
          resultCount,
          degradedCodes,
          durationMs: Date.now() - startedAt,
          ...(failureCode ? { failureCode } : {}),
        },
        context,
      );

    try {
      for (let round = 1; round <= request.maxRounds; round += 1) {
        if (confirmed.size > 0) {
          const refreshed = await this.refreshConfirmed(confirmed, context);
          if (refreshed.rejected > 0) {
            degradedCodes.push('deep_round_acl_rejected');
          }
          if (confirmed.size === 0) {
            aclRevokedAll = true;
            stopReason = 'no_new_evidence';
            break;
          }
        }
        const budget = deepBudgetOf(request, usage.inputTokens + usage.outputTokens);
        if (budget.roundTokens < 1) {
          stopReason = 'token_budget';
          break;
        }
        const plannerEstimate = this.plannerCostMicros(budget.roundTokens);
        if (spentCostMicros + plannerEstimate > costBudget.budgetMicros) {
          if (confirmed.size === 0) {
            throw this.costQuotaError(context, 'cost_budget_exhausted', {
              costBudgetMicros: costBudget.budgetMicros,
              committedCostMicros: spentCostMicros,
              estimatedCostMicros: plannerEstimate,
            });
          }
          stopReason = 'cost_budget';
          break;
        }
        const startedRound = Date.now();
        let planner: PlannerResult;
        try {
          planner = await this.plan({
            request,
            modelId: models.llm.modelId,
            round,
            searchId,
            confirmed: [...confirmed.values()],
            remainingTokens: budget.roundTokens,
            context,
          });
        } catch (error) {
          if (confirmed.size === 0) throw error;
          degradedCodes.push('deep_planner_failed');
          dependencyFailed = true;
          stopReason = 'dependency_failure';
          break;
        }

        const priorKeys = new Set(confirmed.keys());
        let roundHits = 0;
        let newEvidenceCount = 0;
        let roundPartial = false;
        let roundUsage = { inputTokens: 0, outputTokens: 0 };
        let roundCostMicros = this.actualPlannerCostMicros(planner);
        let roundReservedCostMicros = plannerEstimate;
        let budgetExhausted = false;
        let costBudgetExhausted = false;
        for (const query of planner.queries) {
          const normalizedQuery = query.trim();
          const queryKey = normalizedQuery.replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
          if (executedQueries.has(queryKey)) continue;
          executedQueries.add(queryKey);
          const remaining = deepBudgetOf(
            request,
            usage.inputTokens +
              usage.outputTokens +
              planner.usage.inputTokens +
              planner.usage.outputTokens +
              roundUsage.inputTokens +
              roundUsage.outputTokens,
          );
          if (remaining.roundTokens < 1) {
            budgetExhausted = true;
            break;
          }
          const estimatedSearchCost = this.searchCostMicros(
            normalizedQuery,
            remaining.roundTokens,
            request.usingRerank,
          );
          if (spentCostMicros + roundCostMicros + estimatedSearchCost > costBudget.budgetMicros) {
            costBudgetExhausted = true;
            break;
          }
          try {
            const result = await this.input.search.collectCandidates({
              request: this.searchRequest(request, normalizedQuery, remaining.roundTokens),
              knowledgeSpaceIds: request.knowledgeSpaceIds,
              mode: 'hybrid',
              context,
              limit: 20,
            });
            roundPartial ||= result.partial;
            searchPartial ||= result.partial;
            rerankApplied ||= result.rerankApplied;
            roundUsage = {
              inputTokens: roundUsage.inputTokens + result.usage.inputTokens,
              outputTokens: roundUsage.outputTokens + result.usage.outputTokens,
            };
            roundCostMicros += this.actualSearchCostMicros(result);
            roundReservedCostMicros += estimatedSearchCost;
            degradedCodes.push(...result.degradedCodes);
            for (const candidate of result.candidates) {
              const key = candidateKey(candidate);
              roundHits += 1;
              if (!confirmed.has(key)) {
                confirmed.set(key, candidate);
                if (!priorKeys.has(key)) newEvidenceCount += 1;
              }
            }
          } catch (error) {
            degradedCodes.push(problemCode(error));
            dependencyFailed = true;
            if (confirmed.size === 0) throw error;
            break;
          }
        }
        if (roundPartial) degradedCodes.push('KNOWLEDGE_PARTIAL_SUCCESS');
        spentCostMicros += roundCostMicros;
        usage = {
          inputTokens: usage.inputTokens + planner.usage.inputTokens + roundUsage.inputTokens,
          outputTokens: usage.outputTokens + planner.usage.outputTokens + roundUsage.outputTokens,
          aiPointsMicros: spentCostMicros,
          aiPoints: pointsFromMicros(spentCostMicros),
          costBudgetPoints: pointsFromMicros(costBudget.budgetMicros),
          remainingAiPoints: pointsFromMicros(
            Math.max(0, costBudget.budgetMicros - spentCostMicros),
          ),
        };
        const hasNewEvidence = newEvidenceCount > 0;
        const remainingTokens = Math.max(
          0,
          request.tokenBudget - usage.inputTokens - usage.outputTokens,
        );
        const revisions = permissionRevisions([...confirmed.values()]);
        rounds.push(
          deepRoundSummary({
            round,
            queries: planner.queries,
            candidateCount: roundHits,
            sufficient: planner.sufficient,
            inputTokens: planner.usage.inputTokens + roundUsage.inputTokens,
            outputTokens: planner.usage.outputTokens + roundUsage.outputTokens,
            aiPoints: pointsFromMicros(roundCostMicros),
            permissionRevision: maxPermissionRevision([...confirmed.values()]),
          }),
        );
        stopReason = costBudgetExhausted
          ? 'cost_budget'
          : budgetExhausted
            ? 'token_budget'
            : deepStopReason({
                round,
                maxRounds: request.maxRounds,
                sufficient: planner.sufficient,
                hasNewEvidence,
                stopWhenNoNewEvidence: request.stopWhenNoNewEvidence,
                remainingTokens,
                dependencyFailed,
                hasEvidence: confirmed.size > 0,
              });
        await this.input.repository.appendRound(
          {
            searchId,
            spaceId: request.knowledgeSpaceId,
            round,
            queries: planner.queries,
            candidateCount: roundHits,
            sufficient: planner.sufficient,
            modelIds: [
              models.llm.modelId,
              models.embedding.modelId,
              ...(models.rerank ? [models.rerank.modelId] : []),
            ],
            durationMs: Date.now() - startedRound,
            inputTokens: planner.usage.inputTokens + roundUsage.inputTokens,
            outputTokens: planner.usage.outputTokens + roundUsage.outputTokens,
            aiPointsMicros: roundCostMicros,
            pricingVersion: this.input.cost?.pricingVersion ?? 'unpriced-test',
            permissionRevision: maxPermissionRevision([...confirmed.values()]),
            permissionRevisions: revisions,
            reservedAiPointsMicros: roundReservedCostMicros,
            stopEvidence: {
              hasNewEvidence,
              newEvidenceCount,
              remainingTokens,
              partial: roundPartial,
              reservedAiPoints: pointsFromMicros(roundReservedCostMicros),
              actualAiPoints: pointsFromMicros(roundCostMicros),
            },
          },
          context,
        );
        if (stopReason) break;
      }
    } catch (error) {
      await this.input.audits.appendSearch(
        {
          searchId,
          searchMode: 'deep',
          spaceId: request.knowledgeSpaceId,
          outcome: 'failed',
          partial: false,
          resultCount: 0,
          degradedCodes,
          durationMs: Date.now() - startedAt,
          failureCode: problemCode(error),
        },
        context,
      );
      throw error;
    }

    if (!stopReason) stopReason = 'round_limit';
    if (confirmed.size === 0) {
      if (aclRevokedAll) {
        await recordTerminalAudit('failed', false, 0, 'KNOWLEDGE_FORBIDDEN');
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'deep_round_acl_rejected' },
        });
      }
      if (stopReason === 'token_budget' || stopReason === 'cost_budget') {
        await recordTerminalAudit('failed', false, 0, 'KNOWLEDGE_QUOTA_EXCEEDED');
        throw createKnowledgeError({
          code: 'KNOWLEDGE_QUOTA_EXCEEDED',
          requestId: context.requestId,
          traceId: context.traceId,
          details: {
            reason:
              stopReason === 'cost_budget'
                ? 'cost_budget_exhausted'
                : 'deep_token_budget_exhausted',
            costBudgetPoints: usage.costBudgetPoints,
            usedAiPoints: usage.aiPoints,
          },
        });
      }
      await recordTerminalAudit('succeeded', searchPartial, 0);
      return this.response({
        searchId,
        candidates: [],
        citations: new Map(),
        rounds,
        stopReason: stopReason === 'sufficient' ? 'no_new_evidence' : stopReason,
        partial: searchPartial,
        durationMs: Date.now() - startedAt,
        degradedCodes,
        rerankApplied,
        usage,
      });
    }
    const current: AuthorizedCandidate[] = [];
    for (const candidate of confirmed.values()) {
      const authorized = await this.input.authorization.reauthorizeCitation(
        {
          knowledgeSpaceId: candidate.knowledgeSpaceId,
          sourceId: candidate.sourceId,
          segmentId: candidate.segmentId,
        },
        context,
      );
      if (authorized) current.push(authorized);
      else degradedCodes.push('deep_final_acl_rejected');
    }
    if (current.length === 0) {
      await recordTerminalAudit('failed', false, 0, 'KNOWLEDGE_FORBIDDEN');
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'deep_final_acl_rejected' },
      });
    }
    const imagePreviews = await issueSearchImagePreviews({
      candidates: current,
      previews: this.input.imagePreviews,
      context,
    });
    degradedCodes.push(...imagePreviews.degradedCodes);
    const durationMs = Date.now() - startedAt;
    const partial =
      stopReason === 'dependency_failure' ||
      stopReason === 'token_budget' ||
      stopReason === 'cost_budget' ||
      degradedCodes.length > 0 ||
      searchPartial;
    const citations = await this.input.citations.issueWithAudit(
      {
        searchId,
        searchMode: 'deep',
        spaceId: request.knowledgeSpaceId,
        candidates: current,
        partial,
        durationMs,
        degradedCodes,
        now: this.input.now?.() ?? new Date(),
        deadlineAt: startedAt + 120_000,
      },
      context,
    );
    return this.response({
      searchId,
      candidates: current,
      citations,
      rounds,
      stopReason,
      partial,
      durationMs,
      degradedCodes,
      rerankApplied,
      usage,
      imagePreviews: imagePreviews.items,
    });
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId !== 'API-SEARCH-DEEP') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { operationId: input.operationId, application: 's8-deep-search' },
      });
    }
    const data = await this.search(input.body, input.context);
    return { status: data.partial ? 207 : 200, data };
  }
}
