import {
  type DeepSearchApiResponse,
  SearchFilterApiSchema,
  type MultiSpaceSearchApiRequest,
  type SearchApiRequest,
  type SearchApiResponse,
  type SearchFilterApi,
} from '@kb/contracts';
import {
  S7_SEARCH_MODES,
  IdempotencyKeyBuffer,
  Button,
  S8DeepSearchPanel,
  S8SearchFormSchema,
  S7SearchFormSchema,
  S7SearchWorkbench,
  buildS7SearchRequest,
  buildS8DeepRequest,
  classifyS7SearchState,
  defaultS7SearchForm,
  defaultS8SearchForm,
  knowledgeQueryKeys,
  knowledgeRequest,
  useKnowledgeQuery,
  useKnowledgeI18n,
  type S7SearchFormValues,
  type S7SearchMode,
  type S7SearchUiState,
  type S7SearchWorkbenchLabels,
  type S7SpaceChoice,
  type S7TagChoice,
  type S8DeepSearchPanelLabels,
  type S8SearchFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageInfo, SpaceRecord, TagRecord } from '../../../lib/knowledge-types';

interface SpaceListResponse {
  items: SpaceRecord[];
  pageInfo: PageInfo;
}

interface TagListResponse {
  items: TagRecord[];
}

interface ModelBindingResponse {
  items: Array<{
    modelType: string;
    modelId: string;
    status: string;
  }>;
}

function queryString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMode(value: string | undefined): S7SearchMode {
  return S7_SEARCH_MODES.includes(value as S7SearchMode) ? (value as S7SearchMode) : 'hybrid';
}

type SearchPageMode = S7SearchMode | 'deep';

function parsePageMode(value: string | undefined): SearchPageMode {
  return value === 'deep' ? 'deep' : parseMode(value);
}

function parseFilters(value: string | undefined): SearchFilterApi | undefined {
  if (!value) return undefined;
  try {
    const parsed = SearchFilterApiSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function searchPath(mode: S7SearchMode): string {
  if (mode === 'semantic') return '/v1/knowledge/search/semantic';
  if (mode === 'fulltext') return '/v1/knowledge/search/full-text';
  if (mode === 'multi_space') return '/v1/knowledge/search/multi-space';
  return '/v1/knowledge/search/hybrid';
}

function parseSpaceIds(value: string | undefined, base: string): string[] {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set([base, ...ids])];
}

function labelsFor(t: ReturnType<typeof useKnowledgeI18n>['t']): S7SearchWorkbenchLabels {
  return {
    title: t('search.title'),
    description: t('search.description'),
    results: t('search.results'),
    loading: t('search.loading'),
    idle: t('search.idle'),
    empty: t('search.empty'),
    partial: t('search.partial'),
    degraded: t('search.degraded'),
    permission: t('search.permission'),
    timeout: t('search.timeout'),
    rateLimited: t('search.rateLimited'),
    error: t('search.error'),
    retry: t('search.retry'),
    trace: t('search.trace'),
    code: t('search.code'),
    duration: t('search.duration'),
    resultCount: t('search.resultCount'),
    rerankApplied: t('search.rerankApplied'),
    query: t('search.query'),
    queryPlaceholder: t('search.queryPlaceholder'),
    mode: t('search.mode'),
    semantic: t('search.semantic'),
    fulltext: t('search.fulltext'),
    hybrid: t('search.hybrid'),
    multiSpace: t('search.multiSpace'),
    tokenBudget: t('search.tokenBudget'),
    similarity: t('search.similarity'),
    embeddingWeight: t('search.embeddingWeight'),
    rerankWeight: t('search.rerankWeight'),
    usingRerank: t('search.usingRerank'),
    filters: t('search.filters'),
    logic: t('search.logic'),
    and: t('search.and'),
    or: t('search.or'),
    sourceIds: t('search.sourceIds'),
    directoryIds: t('search.directoryIds'),
    createdAtGte: t('search.createdAtGte'),
    createdAtLte: t('search.createdAtLte'),
    tags: t('search.tags'),
    addTag: t('search.addTag'),
    removeTag: t('search.removeTag'),
    tag: t('search.tag'),
    operator: t('search.operator'),
    value: t('search.value'),
    spaces: t('search.spaces'),
    run: t('search.run'),
    running: t('search.running'),
    similarityDisabled: t('search.similarityDisabled'),
    citation: {
      citation: t('search.citation'),
      source: t('search.citationSource'),
      range: t('search.citationRange'),
      version: t('search.citationVersion'),
    },
  };
}

export default function SearchPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = queryString(router.query.spaceId) ?? '';
  const [value, setValue] = useState<S7SearchFormValues>(() => defaultS7SearchForm(spaceId));
  const [filters, setFilters] = useState<SearchFilterApi>({
    logic: 'AND',
    conditions: [],
  });
  const [state, setState] = useState<S7SearchUiState>({ kind: 'idle' });
  const [pageMode, setPageMode] = useState<SearchPageMode>('hybrid');
  const [deepValue, setDeepValue] = useState<S8SearchFormValues>(() =>
    defaultS8SearchForm(spaceId),
  );
  const [deepState, setDeepState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [deepResult, setDeepResult] = useState<DeepSearchApiResponse>();
  const [deepError, setDeepError] = useState<unknown>();
  const deepKeys = useRef(new IdempotencyKeyBuffer());
  const initialized = useRef(false);

  const spaces = useKnowledgeQuery<SpaceListResponse>(
    knowledgeQueryKeys.spaces.list({ limit: 200 }),
    '/v1/knowledge/spaces?limit=200',
  );
  const tags = useKnowledgeQuery<TagListResponse>(
    knowledgeQueryKeys.tags.list(spaceId, { limit: 200 }),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/tags?limit=200` : null,
  );
  const bindings = useKnowledgeQuery<ModelBindingResponse>(
    knowledgeQueryKeys.modelBindings.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/model-bindings?limit=200` : null,
  );

  useEffect(() => {
    if (!router.isReady || !spaceId || initialized.current) return;
    initialized.current = true;
    const rawFilters = parseFilters(queryString(router.query.filters));
    const nextMode = parsePageMode(queryString(router.query.mode));
    const defaults = defaultS7SearchForm(spaceId);
    const next = S7SearchFormSchema.parse({
      ...defaults,
      query: queryString(router.query.query) ?? '',
      mode: nextMode === 'deep' ? 'hybrid' : nextMode,
      tokenBudget: finiteNumber(queryString(router.query.budget), defaults.tokenBudget),
      similarity: finiteNumber(queryString(router.query.similarity), defaults.similarity),
      embeddingWeight: finiteNumber(
        queryString(router.query.embeddingWeight),
        defaults.embeddingWeight,
      ),
      rerankWeight: finiteNumber(queryString(router.query.rerankWeight), defaults.rerankWeight),
      usingRerank: queryString(router.query.rerank) === 'true',
      knowledgeSpaceIds: parseSpaceIds(queryString(router.query.spaces), spaceId),
      filters: rawFilters ?? defaults.filters,
    });
    setValue(next);
    setPageMode(nextMode);
    setDeepValue((current) => ({
      ...current,
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [...new Set([spaceId, ...current.knowledgeSpaceIds])],
      query: queryString(router.query.query) ?? current.query,
    }));
    setFilters(next.filters);
  }, [router.isReady, router.query, spaceId]);

  const rerankAvailable =
    bindings.data?.items.some(
      (binding) => binding.modelType === 'rerank' && binding.status === 'active',
    ) ?? false;

  useEffect(() => {
    if (!rerankAvailable && value.usingRerank) {
      setValue((current) => ({ ...current, usingRerank: false }));
    }
  }, [rerankAvailable, value.usingRerank]);

  useEffect(() => {
    if (!router.isReady || !spaceId || !initialized.current) return;
    const query: Record<string, string> = {
      mode: pageMode,
      budget: String(value.tokenBudget),
      similarity: String(value.similarity),
      embeddingWeight: String(value.embeddingWeight),
      rerankWeight: String(value.rerankWeight),
      rerank: String(value.usingRerank),
      spaces: [...new Set([spaceId, ...value.knowledgeSpaceIds])].join(','),
      filters: JSON.stringify(filters),
    };
    if (value.query) query.query = value.query;
    const timer = setTimeout(() => {
      void router.replace({ pathname: router.pathname, query: { spaceId, ...query } }, undefined, {
        shallow: true,
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [filters, pageMode, router, spaceId, value]);

  const label = useMemo(() => labelsFor(t), [t]);
  const spaceChoices: S7SpaceChoice[] = (spaces.data?.items ?? []).map((space) => ({
    id: space.id,
    name: space.name,
  }));
  const tagChoices: S7TagChoice[] = (tags.data?.items ?? []).map((tag) => ({
    id: tag.id,
    label: tag.label,
    tagType: tag.tagType,
  }));

  const run = async () => {
    setState({ kind: 'loading' });
    const parsed = S7SearchFormSchema.safeParse({ ...value, filters });
    if (!parsed.success) {
      setState({
        kind: 'error',
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        retryable: false,
      });
      return;
    }
    try {
      const request: SearchApiRequest | MultiSpaceSearchApiRequest = buildS7SearchRequest(
        parsed.data,
      );
      const result = await knowledgeRequest<SearchApiResponse>(searchPath(parsed.data.mode), {
        method: 'POST',
        body: request,
      });
      setState(classifyS7SearchState({ result }));
    } catch (error) {
      setState(classifyS7SearchState({ error }));
    }
  };

  const runDeep = async () => {
    const parsed = S8SearchFormSchema.safeParse(deepValue);
    if (!parsed.success) {
      setDeepState('error');
      return;
    }
    setDeepState('loading');
    setDeepError(undefined);
    try {
      const request = buildS8DeepRequest(parsed.data);
      const result = await knowledgeRequest<DeepSearchApiResponse>('/v1/knowledge/search/deep', {
        method: 'POST',
        body: request,
        idempotencyKey: deepKeys.current.keyFor(request),
      });
      setDeepResult(result);
      setDeepState('ready');
    } catch (error) {
      setDeepError(error);
      setDeepState('error');
    }
  };

  const deepLabels: S8DeepSearchPanelLabels = {
    title: t('s8.deep.title'),
    description: t('s8.deep.description'),
    query: t('s8.deep.query'),
    queryPlaceholder: t('s8.deep.queryPlaceholder'),
    maxRounds: t('s8.deep.maxRounds'),
    roundTokenBudget: t('s8.deep.roundTokenBudget'),
    tokenBudget: t('s8.deep.tokenBudget'),
    stopWhenNoNewEvidence: t('s8.deep.stopWhenNoNewEvidence'),
    run: t('s8.deep.run'),
    running: t('s8.deep.running'),
    idle: t('s8.deep.idle'),
    partial: t('s8.deep.partial'),
    rounds: t('s8.deep.rounds'),
    round: t('s8.deep.round'),
    candidateCount: t('s8.deep.candidateCount'),
    sufficient: t('s8.deep.sufficient'),
    stopReason: t('s8.deep.stopReason'),
    usage: t('s8.deep.usage'),
    error: t('s8.deep.error'),
    retry: t('s8.deep.retry'),
    citation: {
      citation: t('search.citation'),
      source: t('search.citationSource'),
      range: t('search.citationRange'),
      version: t('search.citationVersion'),
    },
  };

  return (
    <>
      <Head>
        <title>{t('search.title')}</title>
      </Head>
      <div
        role="group"
        aria-label={t('search.mode')}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}
      >
        {S7_SEARCH_MODES.map((mode) => (
          <Button
            key={mode}
            size="sm"
            tone={pageMode === mode ? 'primary' : 'secondary'}
            onClick={() => {
              setPageMode(mode);
              setValue((current) => ({ ...current, mode }));
            }}
          >
            {t(
              mode === 'semantic'
                ? 'search.semantic'
                : mode === 'fulltext'
                  ? 'search.fulltext'
                  : mode === 'multi_space'
                    ? 'search.multiSpace'
                    : 'search.hybrid',
            )}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void router.push(`/spaces/${spaceId}/images`)}
        >
          {t('search.image')}
        </Button>
        <Button
          size="sm"
          tone={pageMode === 'deep' ? 'primary' : 'secondary'}
          onClick={() => setPageMode('deep')}
        >
          {t('search.deep')}
        </Button>
      </div>
      {pageMode === 'deep' ? (
        <S8DeepSearchPanel
          value={deepValue}
          labels={deepLabels}
          result={deepResult}
          error={deepError}
          state={deepState}
          onChange={(next) => setDeepValue((current) => ({ ...current, ...next }))}
          onSubmit={() => void runDeep()}
          onRetry={() => void runDeep()}
        />
      ) : (
        <S7SearchWorkbench
          mode={value.mode}
          value={value}
          filters={filters}
          tags={tagChoices}
          spaces={spaceChoices}
          result={'result' in state ? state.result : undefined}
          state={state}
          labels={label}
          rerankAvailable={rerankAvailable}
          onValueChange={(next) => setValue((current) => ({ ...current, ...next, filters }))}
          onModeChange={(mode) => {
            setValue((current) => ({ ...current, mode }));
            setPageMode(mode);
          }}
          onFiltersChange={setFilters}
          onSubmit={() => void run()}
          onRetry={() => void run()}
        />
      )}
    </>
  );
}
