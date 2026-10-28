import { describe, expect, it, vi } from 'vitest';
import { S7SearchOperationApplication } from '../../src/modules/knowledge/application/s7-search-operation.application';
import type { S7CitationApplication } from '../../src/modules/knowledge/application/s7-citation.application';
import type { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-operation',
  memberId: 'mem-operation',
  requestId: 'req-operation',
  traceId: 'trace-operation',
  scopes: ['knowledge:search'],
};

function fixture() {
  const dispatch = vi.fn(async (input: { operationId: string }) => ({
    status: input.operationId === 'API-SEARCH-HYBRID' ? 207 : 200,
    data: { operationId: input.operationId, partial: input.operationId === 'API-SEARCH-HYBRID' },
  }));
  const get = vi.fn(async (citationId: string) => ({
    citationId,
    segmentId: '65f1e5b2a1c9d4b7e8f20001',
    sourceId: '65f1e5b2a1c9d4b7e8f10001',
    title: 'Source',
    sourceUrl: null,
    segmentRange: { start: 0, end: 4 },
    score: 0.8,
    version: 1,
  }));
  return {
    application: new S7SearchOperationApplication(
      { dispatch } as unknown as S7SearchApplication,
      { get } as unknown as S7CitationApplication,
    ),
    dispatch,
    get,
  };
}

describe('S7 five-operation handler surface', () => {
  it.each(['API-SEARCH-SEMANTIC', 'API-SEARCH-FULLTEXT', 'API-SEARCH-HYBRID', 'API-SEARCH-MULTI'])(
    'delegates %s',
    async (operationId) => {
      const { application, dispatch } = fixture();
      const result = await application.dispatch({
        operationId,
        params: {},
        query: {},
        body: {},
        context,
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(result.status).toBe(operationId === 'API-SEARCH-HYBRID' ? 207 : 200);
    },
  );

  it('delegates API-CITATION-GET without writing search audit', async () => {
    const { application, get } = fixture();
    const result = await application.dispatch({
      operationId: 'API-CITATION-GET',
      params: { citationId: 'cit_test' },
      query: {},
      body: {},
      context,
    });
    expect(result.status).toBe(200);
    expect(get).toHaveBeenCalledWith('cit_test', context);
  });
});
