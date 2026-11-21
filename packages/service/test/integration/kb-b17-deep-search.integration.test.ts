import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError, type CitationApi } from '@kb/contracts';
import type { AuthorizedCandidate } from '@kb/search';
import { S8DeepSearchApplication } from '../../src/modules/knowledge/application/s8-deep-search.application';
import { S5ModelTransportError } from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const workspaceId = 'ws_b17_deep';
const memberId = 'mem_b17_deep';
const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';
const sourceA = '65f1e5b2a1c9d4b7e8f05678';
const sourceB = '65f1e5b2a1c9d4b7e8f05679';
const segmentA = '65f1e5b2a1c9d4b7e8f20001';
const segmentB = '65f1e5b2a1c9d4b7e8f20002';

const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: 'req_b17_deep',
  traceId: '0123456789abcdef0123456789abcdef',
  scopes: ['knowledge:search'],
  isWorkspaceOwner: true,
};

function candidate(input: {
  spaceId: string;
  sourceId: string;
  segmentId: string;
  title: string;
  text: string;
  score?: number;
  permissionRevision?: number;
}): AuthorizedCandidate {
  return {
    docId: `${input.spaceId}:${input.segmentId}`,
    segmentId: input.segmentId,
    sourceId: input.sourceId,
    knowledgeSpaceId: input.spaceId,
    score: input.score ?? 0.9,
    embeddingScore: input.score ?? 0.9,
    scores: [{ type: 'embedding', value: input.score ?? 0.9, index: 0 }],
    text: input.text,
    segment: {
      id: input.segmentId,
      workspaceId,
      knowledgeSpaceId: input.spaceId,
      sourceId: input.sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: input.title,
      answer: '',
      content: input.text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: input.sourceId,
      workspaceId,
      knowledgeSpaceId: input.spaceId,
      name: input.title,
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: input.permissionRevision ?? 3,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

const candidateA = candidate({
  spaceId: spaceA,
  sourceId: sourceA,
  segmentId: segmentA,
  title: 'Refund policy',
  text: 'Refunds take five business days and require manager approval above the threshold.',
});
const candidateB = candidate({
  spaceId: spaceB,
  sourceId: sourceB,
  segmentId: segmentB,
  title: 'Escalation ownership',
  text: 'Escalation ownership belongs to the support operations lead.',
  score: 0.84,
});

type PlannerResponse =
  | {
      content: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | Error;

interface DeepHarnessOptions {
  planner?: PlannerResponse[];
  search?: AuthorizedCandidate[][];
  searchPartial?: boolean[];
  revoked?: Set<string>;
  onPlanner?: (round: number, messages: Array<{ role: string; content: string }>) => void;
}

function key(candidateValue: AuthorizedCandidate): string {
  return `${candidateValue.knowledgeSpaceId}:${candidateValue.segmentId}`;
}

function citation(candidateValue: AuthorizedCandidate): CitationApi {
  return {
    citationId: `cit_b17_${candidateValue.segmentId.slice(-6)}`,
    segmentId: candidateValue.segmentId,
    sourceId: candidateValue.sourceId,
    title: candidateValue.source.name,
    sourceUrl: null,
    segmentRange: { start: 0, end: candidateValue.text.length },
    score: candidateValue.score,
    version: candidateValue.segment.version,
  };
}

function deepHarness(options: DeepHarnessOptions = {}) {
  const sequence: string[] = [];
  const plannerMessages: Array<Array<{ role: string; content: string }>> = [];
  const searchCalls: Array<{
    query: string;
    tokenBudget: number;
    knowledgeSpaceIds: readonly string[];
  }> = [];
  const roundAudits: Array<Record<string, unknown>> = [];
  const failedAudits: Array<Record<string, unknown>> = [];
  const plannerResponses = [...(options.planner ?? [])];
  const searchResponses = [...(options.search ?? [])];
  const searchPartial = [...(options.searchPartial ?? [])];
  const revoked = options.revoked ?? new Set<string>();
  let plannerRound = 0;

  const issue = vi.fn(async (input: { candidates: readonly AuthorizedCandidate[] }) => {
    return new Map(input.candidates.map((item) => [key(item), citation(item)]));
  });

  const instance = new S8DeepSearchApplication({
    access: {
      assertSearchScope() {},
      async getAuthorizedSpace(requestedSpaceId) {
        if (![spaceA, spaceB].includes(requestedSpaceId)) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: context.requestId,
            traceId: context.traceId,
          });
        }
        return {
          spaceId: requestedSpaceId,
          workspaceId,
          sourcePermissionEnabled: true,
        };
      },
    },
    repository: {
      async resolveModels() {
        return {
          llm: {
            modelId: 'mock-b17-llm',
            displayName: 'B17 LLM',
            type: 'llm',
            capabilities: ['chat'],
            dimension: null,
            authorized: true,
          },
          embedding: {
            modelId: 'mock-b17-embedding',
            displayName: 'B17 Embedding',
            type: 'embedding',
            capabilities: ['text-embedding', 'dimension:768'],
            dimension: 768,
            authorized: true,
          },
        };
      },
      async appendRound(input) {
        roundAudits.push(input as unknown as Record<string, unknown>);
      },
    },
    gateway: {
      async invoke(input) {
        plannerRound += 1;
        sequence.push(`planner:${plannerRound}`);
        plannerMessages.push(input.messages);
        options.onPlanner?.(plannerRound, input.messages);
        const response =
          plannerResponses.shift() ??
          ({
            content: JSON.stringify({ queries: ['return evidence'], sufficient: true }),
          } as const);
        if (response instanceof Error) throw response;
        return {
          data: {
            choices: [{ message: { content: response.content } }],
          },
          actualModelId: 'mock-b17-llm',
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: {
            inputTokens: response.inputTokens ?? 20,
            outputTokens: response.outputTokens ?? 5,
            quantity: (response.inputTokens ?? 20) + (response.outputTokens ?? 5),
          },
        };
      },
    },
    search: {
      async collectCandidates(input) {
        sequence.push(`search:${input.request.query}`);
        searchCalls.push({
          query: input.request.query,
          tokenBudget: input.request.tokenBudget,
          knowledgeSpaceIds: input.knowledgeSpaceIds,
        });
        return {
          candidates: searchResponses.shift() ?? [candidateA],
          partial: searchPartial.shift() ?? false,
          degradedCodes: [],
          rerankApplied: true,
          usage: { inputTokens: 7, outputTokens: 0 },
        };
      },
    },
    authorization: {
      async reauthorizeCitation(input) {
        sequence.push(`reauth:${input.segmentId}`);
        if (revoked.has(`${input.knowledgeSpaceId}:${input.segmentId}`)) return undefined;
        if (input.segmentId === segmentB) return candidateB;
        return candidateA;
      },
    },
    citations: { issueWithAudit: issue, findCurrent: async () => null },
    audits: {
      async appendSearch(input) {
        failedAudits.push(input as unknown as Record<string, unknown>);
      },
    },
    searchIdFactory: () => 'search_b17_integration',
  });

  return {
    instance,
    issue,
    sequence,
    plannerMessages,
    searchCalls,
    roundAudits,
    failedAudits,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeSpaceId: spaceA,
    knowledgeSpaceIds: [spaceA],
    query: 'Compare refund handling and escalation ownership.',
    tokenBudget: 12_000,
    roundTokenBudget: 5_000,
    maxRounds: 3,
    stopWhenNoNewEvidence: true,
    similarity: 0.2,
    embeddingWeight: 0.5,
    usingRerank: false,
    rerankWeight: 0.5,
    ...overrides,
  };
}

describe('L1-B17-SEARCH-008 Deep RAG application closure', () => {
  it('L1-B17-SEARCH-008-P01 continues from confirmed evidence and deduplicates citations', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({
            queries: ['refund handling policy', 'refund escalation owner'],
            sufficient: false,
          }),
        },
        {
          content: JSON.stringify({
            queries: ['policy exception approval'],
            sufficient: true,
          }),
        },
      ],
      search: [[candidateA], [candidateA, candidateB]],
    });
    const result = await harness.instance.search(request(), context);

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.queries).toEqual([
      'refund handling policy',
      'refund escalation owner',
    ]);
    expect(result.rounds[1]?.queries).toEqual(['policy exception approval']);
    expect(harness.plannerMessages[1]?.at(-1)?.content).toContain('Refund policy');
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.citation.citationId)).size).toBe(2);
    expect(result.stopReason).toBe('sufficient');
    expect(harness.issue).toHaveBeenCalledTimes(1);
  });

  it('L1-B17-SEARCH-008-P03 preserves Space identity and partial semantics across multiple Spaces', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({
            queries: ['refund policy', 'escalation ownership'],
            sufficient: true,
          }),
        },
      ],
      search: [[candidateA, candidateB, candidateA]],
      searchPartial: [true],
    });
    const result = await harness.instance.search(
      request({ knowledgeSpaceIds: [spaceA, spaceB] }),
      context,
    );

    expect(result.items.map((item) => item.segment.knowledgeSpaceId).sort()).toEqual(
      [spaceA, spaceB].sort(),
    );
    expect(result.partial).toBe(true);
    expect(result.degraded).toContain('KNOWLEDGE_PARTIAL_SUCCESS');
    expect(harness.searchCalls.every((call) => call.knowledgeSpaceIds.length === 2)).toBe(true);
  });

  it('L1-B17-SEARCH-008-P04 reports per-round token, AI Points and ACL revision evidence', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund handling policy'], sufficient: true }),
          inputTokens: 42,
          outputTokens: 9,
        },
      ],
    });
    const result = await harness.instance.search(request(), context);

    expect(result.rounds[0]).toMatchObject({
      inputTokens: 49,
      outputTokens: 9,
      aiPoints: expect.any(Number),
      permissionRevision: expect.any(Number),
    });
    expect(result.usage).toMatchObject({
      aiPoints: expect.any(Number),
      aiPointsMicros: expect.any(Number),
      costBudgetPoints: expect.any(Number),
      remainingAiPoints: expect.any(Number),
    });
    expect(harness.roundAudits[0]).toMatchObject({
      stopEvidence: expect.objectContaining({
        permissionRevision: expect.any(Number),
        pricingVersion: expect.any(String),
      }),
    });
  });

  it('L1-B17-SEARCH-008-N02 converts malformed planner output into a stable model-output error', async () => {
    const harness = deepHarness({
      planner: [{ content: 'not-json' }],
    });
    await expect(harness.instance.search(request(), context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
    expect(harness.issue).not.toHaveBeenCalled();
    expect(harness.failedAudits).toHaveLength(1);
  });

  it('L1-B17-SEARCH-008-N02 rejects every unsupported planner envelope or query boundary', async () => {
    const contents = [
      'not-json',
      '{}',
      JSON.stringify({ queries: [], sufficient: false }),
      JSON.stringify({
        queries: ['one', 'two', 'three', 'four', 'five', 'six'],
        sufficient: false,
      }),
      JSON.stringify({ queries: ['   '], sufficient: false }),
      JSON.stringify({ queries: ['valid'], sufficient: 'false' }),
      JSON.stringify({ queries: ['x'.repeat(20_001)], sufficient: false }),
    ];
    for (const content of contents) {
      const harness = deepHarness({ planner: [{ content }] });
      await expect(
        harness.instance.search(request(), context),
        content.slice(0, 80),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
      });
      expect(harness.issue).not.toHaveBeenCalled();
    }
  });

  it('L1-B17-SEARCH-008-N03 does not issue duplicate queries or search the same evidence repeatedly', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({
            queries: ['refund policy', 'refund policy', 'esc escalation owner'],
            sufficient: false,
          }),
        },
        {
          content: JSON.stringify({ queries: ['refund policy'], sufficient: true }),
        },
      ],
      search: [[candidateA], [candidateA], [candidateA], [candidateA]],
    });
    const result = await harness.instance.search(request(), context);
    expect(harness.searchCalls.map((call) => call.query)).toEqual([
      'refund policy',
      'esc escalation owner',
    ]);
    expect(result.items).toHaveLength(1);
  });

  it('L1-B17-SEARCH-008-N04 returns an explainable empty result instead of a fabricated failure', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['no matching policy'], sufficient: true }),
        },
      ],
      search: [[]],
    });
    const result = await harness.instance.search(request(), context);
    expect(result.items).toEqual([]);
    expect(result.rounds).toHaveLength(1);
    expect(['no_new_evidence', 'round_limit', 'sufficient']).toContain(result.stopReason);
    expect(harness.issue).not.toHaveBeenCalled();
  });

  it('L1-B17-SEARCH-008-N06 stops before the planner when the AI Points budget is exhausted', async () => {
    const harness = deepHarness();
    await expect(
      harness.instance.search(
        request({
          costBudgetPoints: 0.01,
          tokenBudget: 12_000,
        }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_QUOTA_EXCEEDED',
        },
      },
    });
    expect(harness.plannerMessages).toHaveLength(0);
  });

  it('L1-B17-SEARCH-008-A02 reauthorizes confirmed evidence before it enters the next planner round', async () => {
    const revoked = new Set<string>();
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund policy'], sufficient: false }),
        },
        {
          content: JSON.stringify({ queries: ['escalation owner'], sufficient: true }),
        },
      ],
      search: [[candidateA], [candidateA]],
      revoked,
      onPlanner(round) {
        if (round === 2) revoked.add(key(candidateA));
      },
    });
    await harness.instance.search(request({ maxRounds: 2 }), context).catch(() => undefined);

    const plannerTwoSequence = harness.sequence.indexOf('planner:2');
    const reauthBeforePlanner = harness.sequence
      .slice(0, plannerTwoSequence)
      .some((entry) => entry === `reauth:${segmentA}`);
    expect(reauthBeforePlanner).toBe(true);
    expect(harness.plannerMessages[1]?.at(-1)?.content).not.toContain('Refund policy');
    expect(harness.plannerMessages[1]?.at(-1)?.content).not.toContain(
      'Refunds take five business days',
    );
  });

  it('L1-B17-SEARCH-008-A04 keeps only final-authorized citations in a mixed ACL round', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({
            queries: ['refund and escalation'],
            sufficient: true,
          }),
        },
      ],
      search: [[candidateA, candidateB]],
      revoked: new Set([key(candidateB)]),
    });
    const result = await harness.instance.search(
      request({ knowledgeSpaceIds: [spaceA, spaceB] }),
      context,
    );
    expect(result.items.map((item) => item.segment.knowledgeSpaceId)).toEqual([spaceA]);
    expect(result.degraded).toContain('deep_final_acl_rejected');
    expect(result.partial).toBe(true);
  });

  it('L1-B17-SEARCH-008-S01 leaves business data untouched and only emits round, audit and citation ports', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund policy'], sufficient: true }),
        },
      ],
    });
    await harness.instance.search(request(), context);
    expect(harness.roundAudits).toHaveLength(1);
    expect(harness.issue).toHaveBeenCalledTimes(1);
    expect(harness.failedAudits).toEqual([]);
  });

  it('L1-B17-SEARCH-008-F01 preserves the provider error when the first planner call fails', async () => {
    const harness = deepHarness({
      planner: [new S5ModelTransportError('timeout', null)],
    });
    await expect(harness.instance.search(request(), context)).rejects.toBeInstanceOf(
      S5ModelTransportError,
    );
    expect(harness.issue).not.toHaveBeenCalled();
    expect(harness.failedAudits).toHaveLength(1);
    expect(harness.failedAudits[0]).toMatchObject({ outcome: 'failed', resultCount: 0 });
  });

  it('L1-B17-SEARCH-008-F02 returns confirmed citations as partial after a later dependency failure', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund policy'], sufficient: false }),
        },
        new S5ModelTransportError('server_error', 503),
      ],
    });
    const result = await harness.instance.search(request(), context);
    expect(result.partial).toBe(true);
    expect(result.stopReason).toBe('dependency_failure');
    expect(result.items).toHaveLength(1);
    expect(result.rounds).toHaveLength(1);
  });

  it('L1-B17-SEARCH-008-N07 preserves timeout, auth, rate-limit and server failure classes', async () => {
    const failures = [
      createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
      createKnowledgeError({
        code: 'KNOWLEDGE_AUTH_REQUIRED',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
      createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
      createKnowledgeError({
        code: 'KNOWLEDGE_RATE_LIMITED',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
      createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
      createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
      }),
    ];
    for (const failure of failures) {
      const harness = deepHarness({ planner: [failure] });
      await expect(harness.instance.search(request(), context)).rejects.toMatchObject({
        problem: { error: { code: failure.problem.error.code } },
      });
      expect(harness.issue).not.toHaveBeenCalled();
    }
  });

  it('L1-B17-SEARCH-008-F05 maps exhausted search budget to quota/empty semantics before another provider call', async () => {
    const harness = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['first query', 'second query'], sufficient: false }),
          inputTokens: 495,
          outputTokens: 5,
        },
      ],
    });
    await expect(
      harness.instance.search(
        request({
          tokenBudget: 500,
          roundTokenBudget: 500,
          maxRounds: 1,
        }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_QUOTA_EXCEEDED' } },
    });
    expect(harness.searchCalls).toHaveLength(0);
  });

  it('L1-B17-SEARCH-008-C01 isolates concurrent budgets, evidence and stop reasons', async () => {
    const low = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund low'], sufficient: false }),
          inputTokens: 50,
          outputTokens: 5,
        },
      ],
    });
    const high = deepHarness({
      planner: [
        {
          content: JSON.stringify({ queries: ['refund high'], sufficient: true }),
          inputTokens: 20,
          outputTokens: 5,
        },
      ],
    });
    const [lowResult, highResult] = await Promise.all([
      low.instance.search(request({ tokenBudget: 6_000, maxRounds: 1 }), context),
      high.instance.search(request({ tokenBudget: 12_000 }), {
        ...context,
        requestId: 'req_b17_deep_high',
      }),
    ]);
    expect(lowResult.stopReason).toBe('round_limit');
    expect(highResult.stopReason).toBe('sufficient');
    expect(low.searchCalls.map((call) => call.query)).toEqual(['refund low']);
    expect(high.searchCalls.map((call) => call.query)).toEqual(['refund high']);
  });
});
