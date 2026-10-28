import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { SearchApiResponse, SearchFilterApi } from '../../packages/contracts/src/index';
import { KnowledgeUiProvider } from '../../packages/web/src/theme/knowledge-ui-provider';
import {
  S7SearchWorkbench,
  type S7SearchWorkbenchLabels,
} from '../../packages/web/src/components/s7-search-workbench';
import type { S7SearchUiState } from '../../packages/web/src/components/s7-search-state';
import type {
  S7SearchFormValue,
  S7SpaceChoice,
  S7TagChoice,
} from '../../packages/web/src/components/s7-search-filters';

const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';
const sourceId = '65f1e5b2a1c9d4b7e8f10001';
const segmentId = '65f1e5b2a1c9d4b7e8f20001';
const tagId = '65f1e5b2a1c9d4b7e8f00001';

const content =
  'Refunds are processed within five business days. Escalations are reviewed by the support lead.';

const result: SearchApiResponse = {
  searchId: 'search_fixture',
  mode: 'hybrid',
  items: [
    {
      segment: {
        id: segmentId,
        workspaceId: 'ws_fixture',
        knowledgeSpaceId: spaceA,
        sourceId,
        searchEnabled: true,
        order: 0,
        question: 'How long does a refund take?',
        answer: 'Five business days.',
        content,
        metadata: { section: 'payments' },
        indexes: [],
        indexStatus: 'indexed',
        indexErrorCode: null,
        imageBlobRefId: null,
        version: 3,
      },
      score: 0.87,
      citation: {
        citationId: 'cit_00000000-0000-4000-8000-000000000001',
        segmentId,
        sourceId,
        title: 'Support playbook',
        sourceUrl: 'https://example.invalid/support',
        segmentRange: { start: 0, end: [...content].length },
        score: 0.87,
        version: 3,
      },
    },
  ],
  partial: false,
  durationMs: 42,
  degraded: [],
  rerankApplied: false,
};

const partialResult: SearchApiResponse = {
  ...result,
  partial: true,
  degraded: ['fulltext_recall_failed'],
};

const emptyResult: SearchApiResponse = {
  ...result,
  items: [],
};

const labels: S7SearchWorkbenchLabels = {
  title: 'Search',
  description: 'Search authorized knowledge and inspect citations.',
  results: 'Results',
  loading: 'Loading results',
  idle: 'Enter a query to search knowledge.',
  empty: 'No matching knowledge was found.',
  partial: 'Some retrieval channels were unavailable.',
  degraded: 'Results are available with a degraded component.',
  permission: 'Knowledge is not available.',
  timeout: 'Search timed out.',
  rateLimited: 'Search is rate limited.',
  error: 'Search failed.',
  retry: 'Retry',
  trace: 'Trace',
  code: 'Code',
  duration: 'Duration',
  resultCount: 'Results',
  rerankApplied: 'Rerank',
  query: 'Query',
  queryPlaceholder: 'Describe the knowledge you need',
  mode: 'Search mode',
  semantic: 'Semantic',
  fulltext: 'Full text',
  hybrid: 'Hybrid',
  multiSpace: 'Multiple spaces',
  tokenBudget: 'Token budget',
  similarity: 'Similarity',
  embeddingWeight: 'Embedding weight',
  rerankWeight: 'Rerank weight',
  usingRerank: 'Use rerank',
  filters: 'Filters',
  logic: 'Tag logic',
  and: 'All',
  or: 'Any',
  sourceIds: 'Source IDs',
  directoryIds: 'Directory IDs',
  createdAtGte: 'Created after',
  createdAtLte: 'Created before',
  tags: 'Tag conditions',
  addTag: 'Add tag',
  removeTag: 'Remove tag',
  tag: 'Tag',
  operator: 'Operator',
  value: 'Value',
  spaces: 'Knowledge spaces',
  run: 'Run search',
  running: 'Searching',
  similarityDisabled: 'Not applicable',
  citation: {
    source: 'Source',
    range: 'Range',
    version: 'Version',
    citation: 'Citation',
  },
};

const tags: S7TagChoice[] = [
  { id: tagId, label: 'Department', tagType: 'string' },
  {
    id: '65f1e5b2a1c9d4b7e8f00002',
    label: 'Priority',
    tagType: 'number',
  },
];

const spaces: S7SpaceChoice[] = [
  { id: spaceA, name: 'Support' },
  { id: spaceB, name: 'Operations' },
];

function initialForm(): S7SearchFormValue {
  return {
    query: 'How long does a refund take?',
    mode: 'hybrid',
    tokenBudget: 5_000,
    similarity: 0.2,
    embeddingWeight: 0.5,
    rerankWeight: 0.5,
    usingRerank: false,
    knowledgeSpaceIds: [spaceA, spaceB],
  };
}

function fixtureState(name: string): S7SearchUiState {
  if (name === 'loading') return { kind: 'loading' };
  if (name === 'ready') return { kind: 'ready', result };
  if (name === 'empty') return { kind: 'empty', result: emptyResult };
  if (name === 'degraded') {
    return { kind: 'degraded', result: { ...result, degraded: ['rerank_failed'] } };
  }
  if (name === 'permission') {
    return { kind: 'permission', code: 'KNOWLEDGE_FORBIDDEN', retryable: false };
  }
  if (name === 'timeout') {
    return { kind: 'timeout', code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT', retryable: true };
  }
  if (name === 'rate_limited') {
    return { kind: 'rate_limited', code: 'KNOWLEDGE_RATE_LIMITED', retryable: true };
  }
  if (name === 'error') {
    return {
      kind: 'error',
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      traceId: 'trace-fixture',
      retryable: true,
    };
  }
  return { kind: 'partial', result: partialResult };
}

function Harness() {
  const stateName = new URLSearchParams(globalThis.location.search).get('state') ?? 'partial';
  const [form, setForm] = useState(initialForm);
  const [filters, setFilters] = useState<SearchFilterApi>({
    logic: 'AND',
    conditions: [],
  });
  const [state, setState] = useState<S7SearchUiState>(() => fixtureState(stateName));
  return (
    <KnowledgeUiProvider>
      <S7SearchWorkbench
        mode={form.mode}
        value={form}
        filters={filters}
        tags={tags}
        spaces={spaces}
        result={result}
        state={state}
        labels={labels}
        onModeChange={(mode) => setForm((current) => ({ ...current, mode }))}
        onValueChange={setForm}
        onFiltersChange={setFilters}
        onSubmit={() => {
          setState({ kind: 'loading' });
          globalThis.setTimeout(() => setState({ kind: 'ready', result }), 120);
        }}
        onRetry={() => {
          setState({ kind: 'loading' });
          globalThis.setTimeout(() => setState({ kind: 'ready', result }), 120);
        }}
      />
    </KnowledgeUiProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
