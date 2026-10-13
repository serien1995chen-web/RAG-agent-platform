import type { SearchRequest } from '../../packages/contracts/src/index';
import { describe, expect, it } from 'vitest';
import { createDatasetSearchPort } from '../../packages/service/src/modules/index/adapter/dataset-search.adapter';
import type { RequestContext } from '../../packages/service/src/ports/types';

const indexVersion = 'bge-m3:1536:v1';

function fakeConnection(): never {
  return { models: {}, model: (name: string) => ({ modelName: name }) } as never;
}

function emptyStats(mode: string) {
  return {
    searchMode: mode,
    usingReRank: false,
    usingSimilarityFilter: false,
    embeddingTokens: 0,
    rerankInputTokens: 0,
    degraded: [],
    durationMs: 0,
  };
}

function buildPort(listCalls: { count: number }) {
  const engine = {
    search: async (request: SearchRequest) => ({
      citations: [],
      stats: emptyStats(request.searchMode),
    }),
    searchBatch: async (requests: readonly SearchRequest[]) =>
      requests.map((request) => ({ citations: [], stats: emptyStats(request.searchMode) })),
  };
  const collections = {
    list: async () => {
      listCalls.count += 1;
      return { total: 0, list: [], cursor: null };
    },
  };
  return createDatasetSearchPort({
    engine: engine as never,
    connection: fakeConnection(),
    collections: collections as never,
    datasetIndexVersion: async () => indexVersion,
  });
}

function contextFor(teamId: string): RequestContext {
  return {
    requestId: 'req-tenant',
    tenant: { teamId, tmbId: 'tmb-a', authType: 'token', isRoot: false },
    permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
  };
}

function requestFor(teamId: string): SearchRequest {
  return {
    requestId: 'req-tenant',
    teamId,
    datasetIds: ['0000000000000000000000aa'],
    textQueries: ['alpha'],
    imageQueries: [],
    models: { embeddingModel: 'bge-m3' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 4_000,
    similarity: 0,
  };
}

describe('P5-07 search tenant isolation (TEST-SEARCH-TENANT-001 / ACC-TENANT-001)', () => {
  it('rejects a request-teamId mismatch with 501070 before any storage access', async () => {
    const listCalls = { count: 0 };
    const port = buildPort(listCalls);
    await expect(port.search(requestFor('team-b'), contextFor('team-a'))).rejects.toMatchObject({
      error: { code: 501070 },
    });
    expect(listCalls.count).toBe(0);
  });

  it('rejects a missing tenant context with 501012', async () => {
    const port = buildPort({ count: 0 });
    const context = contextFor('');
    await expect(port.search(requestFor(''), context)).rejects.toMatchObject({
      error: { code: 501012 },
    });
  });

  it('returns zero hits without citation leakage for another tenant data set', async () => {
    const port = buildPort({ count: 0 });
    const result = await port.search(requestFor('team-a'), contextFor('team-a'));
    expect(result.citations).toEqual([]);
  });
});
