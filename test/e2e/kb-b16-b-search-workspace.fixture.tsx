import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import type { SearchResponse } from '../../packages/web/src/product/types';
import { SearchWorkspace } from '../../packages/web/src/product/search-workspace';
import { KnowledgeUiProvider } from '../../packages/web/src/theme/knowledge-ui-provider';

const datasetId = '65f1e5b2a1c9d4b7e8f09600';
const sourceId = '65f1e5b2a1c9d4b7e8f09601';
const segmentId = '65f1e5b2a1c9d4b7e8f09602';
const imageBlobRefId = '65f1e5b2a1c9d4b7e8f09603';

const result: SearchResponse = {
  searchId: 'search_kb_b16_b_ui',
  mode: 'hybrid',
  items: [
    {
      segment: {
        id: segmentId,
        workspaceId: 'ws-kb-b16-b-ui',
        knowledgeSpaceId: datasetId,
        sourceId,
        searchEnabled: true,
        order: 0,
        question: 'Where is the refund policy?',
        answer: 'Refunds take five business days.',
        content: 'Refunds take five business days.',
        metadata: {},
        indexes: [],
        indexStatus: 'indexed',
        indexErrorCode: null,
        imageBlobRefId: null,
        version: 3,
        sourceVersion: 1,
      },
      score: 0.82,
      citation: {
        citationId: 'cit_00000000-0000-4000-8000-000000000016',
        segmentId,
        sourceId,
        title: 'Refund policy',
        sourceUrl: null,
        segmentRange: { start: 0, end: 31 },
        score: 0.82,
        version: 3,
      },
    },
  ],
  partial: false,
  durationMs: 37,
  degraded: [],
  rerankApplied: false,
};

const imageResult: SearchResponse = {
  ...result,
  searchId: 'search_kb_b16_b_image',
  items: [
    {
      ...result.items[0]!,
      segment: {
        ...result.items[0]!.segment,
        id: '65f1e5b2a1c9d4b7e8f09604',
        question: '',
        answer: '',
        content: '',
        imageBlobRefId,
      },
      citation: {
        ...result.items[0]!.citation,
        citationId: 'cit_00000000-0000-4000-8000-000000000017',
        segmentId: '65f1e5b2a1c9d4b7e8f09604',
        title: 'Refund chart',
      },
    },
  ],
};

const emptyResult: SearchResponse = {
  ...result,
  searchId: 'search_kb_b16_b_empty',
  items: [],
  durationMs: 9,
};

function page(data: unknown) {
  return {
    items: data,
    pageInfo: { hasMore: false, nextCursor: null },
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, globalThis.location.origin).pathname;
  if (path === '/api/console/session') {
    return response({
      workspaceId: 'ws-kb-b16-b-ui',
      memberId: 'mem-kb-b16-b-ui',
      scopes: ['knowledge:read', 'knowledge:search'],
      isWorkspaceOwner: false,
      expiresIn: 3600,
    });
  }
  if (path.endsWith('/tags')) {
    return response({
      success: true,
      data: page([]),
      traceId: 'trace-kb-b16-b-ui',
      requestId: 'req-kb-b16-b-tags',
    });
  }
  if (path.endsWith('/models')) {
    return response({
      success: true,
      data: page([]),
      traceId: 'trace-kb-b16-b-ui',
      requestId: 'req-kb-b16-b-models',
    });
  }
  if (path.includes('/v1/knowledge/search/')) {
    const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string }) : {};
    const data =
      body.query === 'empty' ? emptyResult : body.query === 'image' ? imageResult : result;
    return response({
      success: true,
      data,
      traceId: 'trace-kb-b16-b-search',
      requestId: `req-kb-b16-b-${body.query ?? 'search'}`,
    });
  }
  return nativeFetch(input, init);
};

const now = new Date().toISOString();
const settings = {
  mode: 'hybrid',
  tokenBudget: 5_000,
  similarity: 0.2,
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
  rerankModelId: '',
  queryOptimizationEnabled: false,
  queryOptimizationModelId: '',
  queryOptimizationPrompt: '',
  tagId: '',
  tagValue: '',
};
const history = Array.from({ length: 51 }, (_, index) => ({
  id: `history-${index}`,
  query: `query-${index}`,
  imageLabel: null,
  createdAt: now,
  result,
  settings,
}));
globalThis.localStorage.setItem(`kb-product-search-history:${datasetId}`, JSON.stringify(history));
globalThis.localStorage.setItem(
  `kb-product-search-settings:${datasetId}`,
  JSON.stringify(settings),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <KnowledgeUiProvider>
      <SearchWorkspace datasetId={datasetId} datasetName="B16 Search Test" />
    </KnowledgeUiProvider>
  </QueryClientProvider>,
);
