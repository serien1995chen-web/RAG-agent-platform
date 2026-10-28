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
  S7SearchAccessPort,
  S7SearchAuditPort,
} from './s7-search.ports';
import type { S5ModelGatewayPort } from './s5-model-gateway.port';
import type { S8DeepSearchRepositoryPort } from './s8-image-deep.ports';

interface ChatCompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
}

interface PlannerResult extends DeepPlannerOutput {
  usage: { inputTokens: number; outputTokens: number };
}

function candidateKey(candidate: AuthorizedCandidate): string {
  return `${candidate.knowledgeSpaceId}:${candidate.segmentId}`;
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
    usage: { inputTokens: number; outputTokens: number };
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
        return {
          segment: {
            id: candidate.segment.id,
            workspaceId: candidate.segment.workspaceId,
            knowledgeSpaceId: candidate.knowledgeSpaceId,
            sourceId: candidate.sourceId,
            searchEnabled: candidate.segment.searchEnabled,
            order: candidate.segment.order,
            question: candidate.segment.question,
            answer: candidate.segment.answer,
            content: candidate.segment.content,
            metadata: candidate.segment.metadata,
            indexes: candidate.segment.indexes.map((index) => ({
              ...index,
              storageType: index.dimension === 3072 ? ('halfvec' as const) : ('vector' as const),
            })),
            indexStatus: candidate.segment.indexStatus,
            indexErrorCode: candidate.segment.indexErrorCode,
            imageBlobRefId: candidate.segment.imageBlobRefId,
            version: candidate.segment.version,
          },
          score: candidate.rerankScore ?? candidate.embeddingScore ?? candidate.score,
          citation,
        };
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
    const rounds: DeepSearchApiResponse['rounds'] = [];
    const confirmed = new Map<string, AuthorizedCandidate>();
    const degradedCodes: string[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: DeepStopReason | null = null;
    let dependencyFailed = false;
    let rerankApplied = false;

    try {
      for (let round = 1; round <= request.maxRounds; round += 1) {
        const budget = deepBudgetOf(request, usage.inputTokens + usage.outputTokens);
        if (budget.roundTokens < 1) {
          stopReason = 'token_budget';
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
        let roundCandidates = 0;
        let roundPartial = false;
        let roundUsage = { inputTokens: 0, outputTokens: 0 };
        let budgetExhausted = false;
        for (const query of planner.queries) {
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
          try {
            const result = await this.input.search.collectCandidates({
              request: this.searchRequest(request, query, remaining.roundTokens),
              knowledgeSpaceIds: request.knowledgeSpaceIds,
              mode: 'hybrid',
              context,
              limit: 20,
            });
            roundPartial ||= result.partial;
            rerankApplied ||= result.rerankApplied;
            roundUsage = {
              inputTokens: roundUsage.inputTokens + result.usage.inputTokens,
              outputTokens: roundUsage.outputTokens + result.usage.outputTokens,
            };
            degradedCodes.push(...result.degradedCodes);
            for (const candidate of result.candidates) {
              confirmed.set(candidateKey(candidate), candidate);
              roundCandidates += 1;
            }
          } catch (error) {
            degradedCodes.push(problemCode(error));
            dependencyFailed = true;
            if (confirmed.size === 0) throw error;
            break;
          }
        }
        usage = {
          inputTokens: usage.inputTokens + planner.usage.inputTokens + roundUsage.inputTokens,
          outputTokens: usage.outputTokens + planner.usage.outputTokens + roundUsage.outputTokens,
        };
        const hasNewEvidence =
          roundCandidates > 0 && [...confirmed.keys()].some((key) => !priorKeys.has(key));
        const remainingTokens = Math.max(
          0,
          request.tokenBudget - usage.inputTokens - usage.outputTokens,
        );
        rounds.push(
          deepRoundSummary({
            round,
            queries: planner.queries,
            candidateCount: roundCandidates,
            sufficient: planner.sufficient,
          }),
        );
        stopReason = budgetExhausted
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
            candidateCount: roundCandidates,
            sufficient: planner.sufficient,
            modelIds: [
              models.llm.modelId,
              models.embedding.modelId,
              ...(models.rerank ? [models.rerank.modelId] : []),
            ],
            durationMs: Date.now() - startedRound,
            inputTokens: planner.usage.inputTokens + roundUsage.inputTokens,
            outputTokens: planner.usage.outputTokens + roundUsage.outputTokens,
            stopEvidence: {
              hasNewEvidence,
              remainingTokens,
              partial: roundPartial,
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
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'deep_no_confirmed_citation' },
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
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'deep_final_acl_rejected' },
      });
    }
    const durationMs = Date.now() - startedAt;
    const partial = stopReason === 'dependency_failure' || degradedCodes.length > 0;
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
