import { describe, expect, it } from 'vitest';
import { mergeMultiSpaceCitations } from '../../packages/search/src';
import { S7DownstreamKnowledgeClient } from '../../packages/web/src/client/s7-downstream-knowledge-client';

const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';

describe('B18-B downstream concurrency isolation', () => {
  it('keeps request IDs and trace context local to concurrent client requests', async () => {
    const seen: Array<{ requestId: string; authorization: string; workspaceId: string }> = [];
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: 'https://knowledge.example.invalid',
      workspaceId: 'ws_b18b_race',
      credential: 'kn_live_fixture_not_a_real_secret',
      requestIdFactory: () => 'unused',
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({
          requestId: headers['x-request-id'],
          authorization: headers.authorization,
          workspaceId: headers['x-workspace-id'],
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.random() * 20));
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              searchId: `search_${headers['x-request-id']}`,
              mode: 'semantic',
              items: [],
              partial: false,
              durationMs: 1,
              degraded: [],
              rerankApplied: false,
            },
            traceId: headers['x-request-id'],
            requestId: headers['x-request-id'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const requestIds = Array.from({ length: 24 }, (_, index) => `b18b-race-${index}`);
    const results = await Promise.all(
      requestIds.map((requestId) =>
        client.searchSemantic(
          {
            knowledgeSpaceId: spaceA,
            query: `refund-${requestId}`,
            tokenBudget: 5_000,
            searchMode: 'semantic',
          },
          { requestId },
        ),
      ),
    );
    expect(results.map((result) => result.requestId)).toEqual(requestIds);
    expect(new Set(seen.map((entry) => entry.requestId)).size).toBe(requestIds.length);
    expect(new Set(seen.map((entry) => entry.workspaceId))).toEqual(new Set(['ws_b18b_race']));
    expect(new Set(seen.map((entry) => entry.authorization))).toEqual(
      new Set(['Bearer kn_live_fixture_not_a_real_secret']),
    );
  });

  it('does not share merge maps between concurrent multi-Space calls', async () => {
    const calls = Array.from({ length: 30 }, (_, index) =>
      Promise.resolve().then(() =>
        mergeMultiSpaceCitations([
          {
            knowledgeSpaceId: spaceA,
            candidates: [
              {
                docId: `a-${index}`,
                segmentId: `segment-a-${index}`,
                sourceId: `source-a-${index}`,
                knowledgeSpaceId: spaceA,
                score: 1,
                scores: [{ type: 'rrf', value: 1, index: 0 }],
                text: `a-${index}`,
              },
            ],
          },
          {
            knowledgeSpaceId: spaceB,
            candidates: [
              {
                docId: `b-${index}`,
                segmentId: `segment-b-${index}`,
                sourceId: `source-b-${index}`,
                knowledgeSpaceId: spaceB,
                score: 0.9,
                scores: [{ type: 'rrf', value: 0.9, index: 0 }],
                text: `b-${index}`,
              },
            ],
          },
        ]),
      ),
    );
    const results = await Promise.all(calls);
    for (let index = 0; index < results.length; index += 1) {
      const ids = results[index]!.candidates.map((candidate) => candidate.docId).sort();
      expect(ids).toEqual([`a-${index}`, `b-${index}`]);
      expect(results[index]!.partial).toBe(false);
      expect(results[index]!.failedSpaces).toEqual([]);
    }
  });

  it('keeps a duplicate Space failure local to its own merge inputs', () => {
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [] },
      {
        knowledgeSpaceId: spaceB,
        failure: {
          channel: 'fullText',
          kind: 'timeout',
          degradedCode: 'fulltext_recall_failed',
          status: 504,
        },
      },
    ]);
    expect(merged.partial).toBe(true);
    expect(merged.candidates).toEqual([]);
    expect(merged.failedSpaces).toHaveLength(1);
    const separate = mergeMultiSpaceCitations([
      { knowledgeSpaceId: spaceA, candidates: [] },
      { knowledgeSpaceId: spaceB, candidates: [] },
    ]);
    expect(separate.partial).toBe(false);
    expect(separate.failedSpaces).toEqual([]);
  });
});
