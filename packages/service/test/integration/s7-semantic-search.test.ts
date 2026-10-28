import { createKnowledgeError, type CitationApi } from '@kb/contracts';
import type { AuthorizedCandidate, Candidate, SearchEngineDeps } from '@kb/search';
import { describe, expect, it } from 'vitest';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import type {
  S7SearchApplicationDependencies,
  S7SearchPipelineFactoryInput,
} from '../../src/modules/knowledge/application/s7-search.ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const workspaceId = 'ws_s7_search';
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const otherSpaceId = '65f1e5b2a1c9d4b7e8f01235';
const sourceId = '65f1e5b2a1c9d4b7e8f10001';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';
const context: TenantContext = {
  workspaceId,
  memberId: 'mem_s7_search',
  requestId: 'req_s7_search',
  traceId: 'trace_s7_search',
  scopes: ['knowledge:search'],
};

function candidate(text = 'Refunds are processed within five business days.'): AuthorizedCandidate {
  return {
    docId: `${spaceId}:${segmentId}`,
    segmentId,
    sourceId,
    knowledgeSpaceId: spaceId,
    score: 0.9,
    embeddingScore: 0.9,
    scores: [{ type: 'embedding', value: 0.9, index: 0 }],
    text,
    segment: {
      id: segmentId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: text,
      answer: '',
      content: text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 2,
    },
    source: {
      id: sourceId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      name: 'Support playbook',
      originalUrl: 'https://example.invalid/support',
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function citation(input: { candidate: AuthorizedCandidate; searchId: string }): CitationApi {
  return {
    citationId: `cit_00000000-0000-4000-8000-${input.searchId.slice(-12).padStart(12, '0')}`,
    segmentId: input.candidate.segmentId,
    sourceId: input.candidate.sourceId,
    title: input.candidate.source.name,
    sourceUrl: input.candidate.source.originalUrl,
    segmentRange: input.candidate.citationRange ?? {
      start: 0,
      end: [...input.candidate.text].length,
    },
    score: input.candidate.score,
    version: input.candidate.segment.version,
  };
}

function fixture(
  options: {
    vectorError?: unknown;
    fullTextError?: unknown;
    text?: string;
    emptySources?: boolean;
    failVectorForSpace?: string;
    failFullTextForSpace?: string;
    vectorDelayMs?: number;
    totalTimeoutMs?: number;
    citationDelayMs?: number;
  } = {},
) {
  const audits: Array<Record<string, unknown>> = [];
  let pipelineCreations = 0;
  let modelResolutions = 0;
  let citationAttempts = 0;
  let citationCommits = 0;
  const authorization = {
    async hydrate(items: readonly Candidate[]) {
      return {
        items: items.map((item) => {
          const snapshot = candidate(options.text);
          return {
            ...snapshot,
            ...item,
            segmentId: item.segmentId ?? segmentId,
            sourceId: item.sourceId ?? sourceId,
            text: options.text ?? snapshot.text,
            segment: {
              ...snapshot.segment,
              id: item.segmentId ?? segmentId,
              knowledgeSpaceId: item.knowledgeSpaceId,
            },
            source: {
              ...snapshot.source,
              knowledgeSpaceId: item.knowledgeSpaceId,
            },
          } as AuthorizedCandidate;
        }),
        rejected: 0,
      };
    },
    async reauthorizeCitation() {
      return candidate(options.text);
    },
  };
  const dependencies: S7SearchApplicationDependencies = {
    access: {
      assertSearchScope(ctx) {
        if (!ctx.scopes.includes('knowledge:search')) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_FORBIDDEN',
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            details: {},
          });
        }
      },
      async getAuthorizedSpace(id) {
        if (id !== spaceId && id !== otherSpaceId) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: context.requestId,
            traceId: context.traceId,
            details: {},
          });
        }
        return {
          spaceId: id,
          workspaceId,
          sourcePermissionEnabled: true,
        };
      },
    },
    models: {
      async resolveModels() {
        modelResolutions += 1;
        return { embedding: { modelId: 'mock-embedding-1536', dimension: 1536 } };
      },
    },
    filters: {
      async listFilterFacts() {
        if (options.emptySources) return { facts: [], definitions: [] };
        return {
          facts: [
            {
              sourceId,
              knowledgeSpaceId: spaceId,
              directoryId: null,
              directoryPath: [],
              createdAt: new Date('2026-01-01T00:00:00Z'),
              tagValues: [],
            },
          ],
          definitions: [],
        };
      },
    },
    fullText: {
      async search(input) {
        if (options.fullTextError || options.failFullTextForSpace === input.knowledgeSpaceId) {
          throw (
            options.fullTextError ??
            createKnowledgeError({
              code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
              requestId: context.requestId,
              traceId: context.traceId,
              details: {},
            })
          );
        }
        return [{ segmentId, sourceId, score: 0.8 }];
      },
    },
    authorization,
    pipeline: {
      create(input: S7SearchPipelineFactoryInput): SearchEngineDeps {
        pipelineCreations += 1;
        return {
          vectors: {
            async embRecall() {
              if (options.vectorDelayMs) {
                await new Promise((resolve) => setTimeout(resolve, options.vectorDelayMs));
              }
              if (options.vectorError || options.failVectorForSpace === input.space.spaceId) {
                throw (
                  options.vectorError ??
                  createKnowledgeError({
                    code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
                    requestId: context.requestId,
                    traceId: context.traceId,
                    details: {},
                  })
                );
              }
              return [
                {
                  segmentId,
                  sourceId,
                  indexId: '65f1e5b2a1c9d4b7e8f30001',
                  score: 0.9,
                },
              ];
            },
          },
          embedding: {
            async embed({ texts }) {
              return texts.map(() => [1]);
            },
          },
          fullText: {
            async search(searchRequest) {
              if (
                options.fullTextError ||
                options.failFullTextForSpace === searchRequest.knowledgeSpaceId
              ) {
                throw (
                  options.fullTextError ??
                  createKnowledgeError({
                    code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
                    requestId: context.requestId,
                    traceId: context.traceId,
                    details: {},
                  })
                );
              }
              return [{ segmentId, sourceId, score: 0.8 }];
            },
          },
          hydrator: input.models.embedding.dimension === 1536 ? authorization : undefined,
        };
      },
    },
    citations: {
      async issueWithAudit(input) {
        citationAttempts += 1;
        if (options.citationDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.citationDelayMs));
        }
        if (
          input.signal?.aborted ||
          (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { dependency: 'citation_persistence' },
          });
        }
        const map = new Map<string, CitationApi>();
        for (const item of input.candidates) {
          map.set(
            `${item.knowledgeSpaceId}:${item.segmentId}`,
            citation({ candidate: item, searchId: input.searchId }),
          );
        }
        citationCommits += 1;
        return map;
      },
      async findCurrent() {
        return null;
      },
    },
    audits: {
      async appendSearch(input) {
        audits.push(input as unknown as Record<string, unknown>);
      },
    },
    now: () => new Date('2026-10-27T00:00:00Z'),
    searchIdFactory: () => 'search_00000000-0000-4000-8000-000000000001',
    ...(options.totalTimeoutMs
      ? {
          totalTimeoutMs: {
            single: options.totalTimeoutMs,
            multi: options.totalTimeoutMs,
          },
        }
      : {}),
  };
  return {
    application: new S7SearchApplication(dependencies),
    audits,
    counts: () => ({ pipelineCreations, modelResolutions }),
    citationState: () => ({ attempts: citationAttempts, commits: citationCommits }),
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeSpaceId: spaceId,
    query: 'refund',
    tokenBudget: 500,
    ...overrides,
  };
}

describe('S7 search application integration fixture', () => {
  it('TEST-SEARCH-001-BLOCK runs semantic recall through final ACL and citation', async () => {
    const { application } = fixture();
    const result = await application.searchSemantic(body(), context);
    expect(result.mode).toBe('semantic');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.citation.sourceId).toBe(sourceId);
    expect(result.partial).toBe(false);
  });

  it('short-circuits an empty source allowlist before model or vector work', async () => {
    const { application, counts } = fixture({ emptySources: true });
    const result = await application.searchSemantic(
      body({ filters: { logic: 'AND', conditions: [], sourceIds: [] } }),
      context,
    );
    expect(result.items).toEqual([]);
    expect(result.partial).toBe(false);
    expect(counts()).toEqual({ pipelineCreations: 0, modelResolutions: 0 });
  });

  it('TEST-SEARCH-002-BLOCK returns 207-compatible response for one failed hybrid channel', async () => {
    const { application } = fixture({
      fullTextError: createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {},
      }),
    });
    const result = await application.dispatch({
      operationId: 'API-SEARCH-HYBRID',
      params: {},
      query: {},
      body: body({ searchMode: 'hybrid' }),
      context,
    });
    expect(result.status).toBe(207);
    expect((result.data as { partial: boolean }).partial).toBe(true);
    expect((result.data as { degraded: string[] }).degraded).toContain('fulltext_recall_failed');
  });

  it('TEST-SEARCH-005-BLOCK trims text before returning and issuing citation', async () => {
    const longText = 'a'.repeat(2_000);
    const { application } = fixture({ text: longText });
    const result = await application.searchSemantic(body({ tokenBudget: 10 }), context);
    const content = result.items[0]?.segment.content ?? '';
    expect(content.length).toBeLessThan(longText.length);
    expect(result.items[0]?.citation.segmentRange.end).toBe([...content].length);
  });

  it('TEST-SEARCH-007-BLOCK preserves multi-space partial failure semantics', async () => {
    const built = fixture({ failVectorForSpace: spaceId });
    const result = await built.application.searchMultiSpace(
      body({
        searchMode: 'semantic',
        knowledgeSpaceIds: [spaceId, otherSpaceId],
      }),
      context,
    );
    expect(result.mode).toBe('multi_space');
    expect(result.partial).toBe(true);
    expect(result.degraded).toContain(`space_${spaceId}_failed`);
  });

  it('returns 207 when one Space loses only one hybrid channel', async () => {
    const built = fixture({ failFullTextForSpace: otherSpaceId });
    const result = await built.application.dispatch({
      operationId: 'API-SEARCH-MULTI',
      params: {},
      query: {},
      body: body({
        searchMode: 'hybrid',
        knowledgeSpaceIds: [spaceId, otherSpaceId],
      }),
      context,
    });
    expect(result.status).toBe(207);
    expect(result.data).toMatchObject({ partial: true });
    expect((result.data as { degraded: string[] }).degraded).toContain('fulltext_recall_failed');
  });

  it('uses the actual full-text channel for a failed full-text-only Space', async () => {
    const built = fixture({ failFullTextForSpace: otherSpaceId });
    const result = await built.application.searchMultiSpace(
      body({
        searchMode: 'fulltext',
        knowledgeSpaceIds: [spaceId, otherSpaceId],
      }),
      context,
    );
    expect(result.partial).toBe(true);
    expect(result.degraded).toContain(`space_${otherSpaceId}_failed`);
    expect(result.degraded).toContain('fulltext_recall_failed');
    expect(result.degraded).not.toContain('vector_recall_failed');
  });

  it('maps missing or unauthorized Space to 404 and records failure audit', async () => {
    const { application, audits } = fixture();
    await expect(
      application.searchSemantic(
        {
          ...body(),
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f0ffff',
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(audits.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('maps all-channel failure to a dependency problem', async () => {
    const error = createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {},
    });
    const { application } = fixture({ vectorError: error, fullTextError: error });
    await expect(
      application.searchHybrid(body({ searchMode: 'hybrid' }), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });

  it('TEST-SEARCH-004-BLOCK enforces the total deadline before citation issuance', async () => {
    const { application, audits } = fixture({
      vectorDelayMs: 100,
      totalTimeoutMs: 5,
    });
    await expect(application.searchSemantic(body(), context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
    expect(audits.at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('aborts citation persistence instead of committing after the total deadline', async () => {
    const { application, citationState } = fixture({
      citationDelayMs: 40,
      totalTimeoutMs: 5,
    });
    await expect(application.searchSemantic(body(), context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(citationState()).toEqual({ attempts: 1, commits: 0 });
  });
});
