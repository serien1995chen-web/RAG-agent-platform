import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startB12ImageDeepHarness,
  type B12ImageDeepHarness,
  type B12ImageDeepRequest,
} from './b12-image-deep-harness';

let fixture: B12ImageDeepHarness;

function deepBody(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeSpaceId: fixture.spaceId,
    knowledgeSpaceIds: [fixture.spaceId],
    query: 'Compare refund handling and escalation ownership.',
    tokenBudget: 12_000,
    roundTokenBudget: 5_000,
    maxRounds: 3,
    stopWhenNoNewEvidence: true,
    similarity: 0,
    embeddingWeight: 0.5,
    usingRerank: false,
    rerankWeight: 0.5,
    ...overrides,
  };
}

async function deep(input: B12ImageDeepRequest) {
  return fixture.request('/v1/knowledge/search/deep', {
    method: 'POST',
    ...input,
  });
}

beforeAll(async () => {
  fixture = await startB12ImageDeepHarness();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

describe('L1-B17-SEARCH-008 real runtime and infrastructure API closure', () => {
  it('L1-B17-SEARCH-008-P01 returns authorized citations, rounds, usage and duration through the real route', async () => {
    const result = await deep({
      idempotencyKey: `b17-p01-${randomUUID()}`,
      body: deepBody(),
    });
    expect(result.response.status, JSON.stringify(result.payload)).toBe(200);
    expect(result.payload.data).toMatchObject({
      mode: 'multi_space',
      partial: false,
      stopReason: 'sufficient',
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
      rounds: expect.arrayContaining([
        expect.objectContaining({
          round: 1,
          queries: expect.arrayContaining([expect.any(String)]),
          candidateCount: expect.any(Number),
          sufficient: expect.any(Boolean),
        }),
      ]),
      items: expect.arrayContaining([
        expect.objectContaining({
          citation: expect.objectContaining({
            citationId: expect.stringMatching(/^cit_/),
          }),
        }),
      ]),
    });
    expect(result.payload.data.durationMs).toBeGreaterThanOrEqual(0);
    for (const item of result.payload.data.items as Array<{
      segment: { knowledgeSpaceId: string };
      citation: { sourceId: string; segmentId: string };
    }>) {
      expect(item.segment.knowledgeSpaceId).toBe(fixture.spaceId);
      expect(item.citation.sourceId).toBeTruthy();
      expect(item.citation.segmentId).toBeTruthy();
    }
  }, 120_000);

  it('L1-B17-SEARCH-008-N01 rejects blank queries and invalid bounds through the stable Problem envelope', async () => {
    const blank = await deep({
      idempotencyKey: `b17-n01-blank-${randomUUID()}`,
      body: deepBody({ query: '   ' }),
    });
    expect(blank.response.status).toBe(400);
    expect(blank.payload).toMatchObject({
      error: {
        code: 'KNOWLEDGE_VALIDATION_FAILED',
      },
      requestId: expect.any(String),
    });

    const bounds = await deep({
      idempotencyKey: `b17-n01-bounds-${randomUUID()}`,
      body: deepBody({ maxRounds: 4, roundTokenBudget: 499, tokenBudget: 20_001 }),
    });
    expect(bounds.response.status).toBe(400);
    expect(bounds.payload).toMatchObject({
      error: {
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: 'maxRounds' }),
            expect.objectContaining({ path: 'roundTokenBudget' }),
            expect.objectContaining({ path: 'tokenBudget' }),
          ]),
        },
      },
    });
  }, 120_000);

  it('L1-B17-SEARCH-008-C04 replays the same key and body without another logical citation set', async () => {
    const idempotencyKey = `b17-c04-${randomUUID()}`;
    const body = deepBody();
    const first = await deep({ idempotencyKey, body });
    const second = await deep({ idempotencyKey, body });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(second.payload.data).toEqual(first.payload.data);
    expect((second.payload as unknown as { requestId: string }).requestId).toEqual(
      expect.any(String),
    );

    const searchId = String(first.payload.data.searchId);
    const citationCount = await fixture.connection.models.KnowledgeCitation.countDocuments({
      workspaceId: fixture.workspaceId,
      searchRequestId: searchId,
    });
    expect(citationCount).toBe(
      (first.payload.data.items as unknown[]).length,
      'replay must not issue a second citation set',
    );

    const conflict = await deep({
      idempotencyKey,
      body: deepBody({ query: 'A different Deep request body' }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.payload).toMatchObject({
      error: { code: 'KNOWLEDGE_CONFLICT' },
    });
  }, 240_000);

  it('L1-B17-SEARCH-008-Q03 keeps credentials and object keys out of the response', async () => {
    const result = await deep({
      idempotencyKey: `b17-q03-${randomUUID()}`,
      body: deepBody(),
    });
    const serialized = JSON.stringify(result.payload);
    for (const forbidden of [
      'authorization',
      'Authorization',
      'objectKey',
      'sk-',
      'minioadmin',
      'kb_dev_password',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  }, 120_000);

  it('L1-B17-SEARCH-008-Q02 enforces the 10 QPS workspace limit with a safe 429', async () => {
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        deep({
          idempotencyKey: `b17-q02-${index}-${randomUUID()}`,
          body: deepBody({ query: `rate limit query ${index}` }),
        }),
      ),
    );
    const statuses = responses.map((item) => item.response.status);
    expect(statuses).toContain(429);
    const limited = responses.find((item) => item.response.status === 429);
    expect(limited?.payload).toMatchObject({
      error: { code: 'KNOWLEDGE_RATE_LIMITED' },
    });
    expect(JSON.stringify(limited?.payload)).not.toContain('sk-');
  }, 240_000);
});
