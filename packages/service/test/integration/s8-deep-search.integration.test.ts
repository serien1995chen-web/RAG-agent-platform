import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedCandidate } from '@kb/search';
import { S8DeepSearchApplication } from '../../src/modules/knowledge/application/s8-deep-search.application';
import { S5ModelTransportError } from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-s8-deep',
  memberId: 'mem-s8-deep',
  requestId: 'req-s8-deep',
  traceId: 'trace-s8-deep',
  scopes: ['knowledge:search'],
};
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f05678';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';

function authorized(): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId,
    knowledgeSpaceId: spaceId,
    score: 1,
    embeddingScore: 1,
    scores: [{ type: 'embedding', value: 1, index: 0 }],
    text: 'Refunds take five business days.',
    segment: {
      id: segmentId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: 'Refund timing',
      answer: '',
      content: 'Refunds take five business days.',
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: sourceId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      name: 'Support policy',
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 0,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function application(options: { failRound?: number; finalAclRevoked?: boolean } = {}) {
  let plannerCalls = 0;
  const issue = vi.fn(
    async (input: { candidates: readonly AuthorizedCandidate[] }) =>
      new Map(
        input.candidates.map((candidate) => [
          `${candidate.knowledgeSpaceId}:${candidate.segmentId}`,
          {
            citationId: 'cit_00000000-0000-4000-8000-000000000001',
            segmentId: candidate.segmentId,
            sourceId: candidate.sourceId,
            title: candidate.source.name,
            sourceUrl: null,
            segmentRange: { start: 0, end: candidate.text.length },
            score: candidate.score,
            version: candidate.segment.version,
          },
        ]),
      ),
  );
  const appendRound = vi.fn(async () => undefined);
  const instance = new S8DeepSearchApplication({
    access: {
      assertSearchScope() {},
      async getAuthorizedSpace() {
        return {
          spaceId,
          workspaceId: context.workspaceId,
          sourcePermissionEnabled: true,
        };
      },
    },
    repository: {
      resolveModels: async () => ({
        llm: {
          modelId: 'mock-llm',
          displayName: 'LLM',
          type: 'llm',
          capabilities: ['chat'],
          dimension: null,
          authorized: true,
        },
        embedding: {
          modelId: 'mock-embedding-768',
          displayName: 'Embedding',
          type: 'embedding',
          capabilities: ['text-embedding', 'dimension:768'],
          dimension: 768,
          authorized: true,
        },
      }),
      appendRound,
    },
    gateway: {
      invoke: async () => {
        plannerCalls += 1;
        if (options.failRound === plannerCalls) {
          throw new S5ModelTransportError('timeout', null);
        }
        return {
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    queries: ['refund timing'],
                    sufficient: false,
                  }),
                },
              },
            ],
          },
          actualModelId: 'mock-llm',
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 10, outputTokens: 2, quantity: 12 },
        };
      },
    },
    search: {
      collectCandidates: async () => ({
        candidates: [authorized()],
        partial: false,
        degradedCodes: [],
        rerankApplied: false,
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    },
    authorization: {
      reauthorizeCitation: async () => (options.finalAclRevoked ? undefined : authorized()),
    },
    citations: { issueWithAudit: issue, findCurrent: async () => null },
    audits: { appendSearch: async () => undefined },
    searchIdFactory: () => 'search_deep_fixture',
  });
  return { instance, issue, appendRound };
}

describe('TEST-SEARCH-008-BLOCK / TEST-X-DEEP-BUDGET deep search', () => {
  it('runs bounded rounds and persists citations once', async () => {
    const { instance, issue, appendRound } = application();
    const result = await instance.search(
      {
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'compare refund policy',
        tokenBudget: 12_000,
        maxRounds: 3,
        roundTokenBudget: 5_000,
        stopWhenNoNewEvidence: false,
      },
      context,
    );
    expect(result.mode).toBe('multi_space');
    expect(result.rounds).toHaveLength(3);
    expect(result.stopReason).toBe('round_limit');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(appendRound).toHaveBeenCalledTimes(3);
  });

  it('returns 207 dependency_failure after confirmed evidence', async () => {
    const { instance } = application({ failRound: 2 });
    const result = await instance.search(
      {
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'compare refund policy',
        tokenBudget: 12_000,
        maxRounds: 3,
        roundTokenBudget: 5_000,
        stopWhenNoNewEvidence: true,
      },
      context,
    );
    expect(result.stopReason).toBe('dependency_failure');
    expect(result.partial).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  it('does not persist or return citations when final ACL is revoked', async () => {
    const { instance, issue } = application({ finalAclRevoked: true });
    await expect(
      instance.search(
        {
          knowledgeSpaceId: spaceId,
          knowledgeSpaceIds: [spaceId],
          query: 'compare refund policy',
          tokenBudget: 12_000,
          maxRounds: 1,
          roundTokenBudget: 5_000,
          stopWhenNoNewEvidence: true,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(issue).not.toHaveBeenCalled();
  });
});
