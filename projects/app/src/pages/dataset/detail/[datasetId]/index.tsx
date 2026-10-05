import {
  ErrorBanner,
  LoadingState,
  PageHeader,
  fetchApi,
  tokens,
  translate,
  useRequest,
} from '@kb/web';
import type { ErrorLike } from '@kb/web';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';

interface DatasetSummary {
  datasetId: string;
  name: string;
  type: string;
  vectorModel: string;
}

interface DatasetDetailData {
  dataset: DatasetSummary;
  permissionSnapshot: { permissionMask: number; version: number };
  stats: { collections: number; datas: number };
}

interface SearchResultData {
  searchRes: {
    citations: unknown[];
    stats: { degraded: { stage: string; reason: string }[] };
  };
  usingSimilarityFilter: boolean;
}

const panelStyle = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: tokens.spacing.md,
  marginBottom: tokens.spacing.md,
} as const;

export default function DatasetDetailPage() {
  const router = useRouter();
  const datasetId = typeof router.query.datasetId === 'string' ? router.query.datasetId : '';
  const load = useCallback(
    () =>
      fetchApi<DatasetDetailData>(
        `/api/core/dataset/detail?datasetId=${encodeURIComponent(datasetId)}`,
      ),
    [datasetId],
  );
  const { data, loading, error } = useRequest(load);

  const [query, setQuery] = useState('');
  const [searchData, setSearchData] = useState<SearchResultData | null>(null);
  const [searchError, setSearchError] = useState<ErrorLike | null>(null);
  const [searching, setSearching] = useState(false);

  const runSearch = async () => {
    if (!datasetId) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await fetchApi<SearchResultData>('/api/core/dataset/searchTest', {
        method: 'POST',
        body: JSON.stringify({ datasetId, text: query }),
      });
      if (result.code !== 200) {
        setSearchError(result as ErrorLike);
        setSearchData(null);
      } else {
        setSearchData(result.data);
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <main
      style={{
        maxWidth: '960px',
        margin: '0 auto',
        padding: tokens.spacing.lg,
        fontFamily: tokens.font.family,
      }}
    >
      <PageHeader title={translate('dataset.detail.title')} />
      {error ? <ErrorBanner error={error} /> : null}
      {loading ? (
        <LoadingState />
      ) : data ? (
        <>
          <section style={panelStyle}>
            <h2 style={{ marginTop: 0, fontSize: tokens.font.sizeLg }}>{data.dataset.name}</h2>
            <dl style={{ margin: 0, color: tokens.color.textMuted }}>
              <div>
                {translate('dataset.detail.collections')}: {data.stats.collections}
              </div>
              <div>
                {translate('dataset.detail.datas')}: {data.stats.datas}
              </div>
            </dl>
          </section>
          <section style={panelStyle}>
            <h3 style={{ marginTop: 0, fontSize: tokens.font.sizeLg }}>
              {translate('dataset.detail.searchTitle')}
            </h3>
            {searchError ? <ErrorBanner error={searchError} /> : null}
            <div style={{ display: 'flex', gap: tokens.spacing.sm }}>
              <input
                aria-label={translate('dataset.detail.searchTitle')}
                placeholder={translate('dataset.detail.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.font.sizeMd,
                }}
              />
              <button
                type="button"
                onClick={() => void runSearch()}
                disabled={searching}
                style={{
                  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  background: tokens.color.primary,
                  color: '#ffffff',
                  cursor: 'pointer',
                }}
              >
                {translate('common.search')}
              </button>
            </div>
            {searchData ? (
              <div style={{ marginTop: tokens.spacing.md, color: tokens.color.textMuted }}>
                <div>
                  {searchData.searchRes.citations.length} / {translate('dataset.detail.degraded')}:{' '}
                  {searchData.searchRes.stats.degraded
                    .map((item) => `${item.stage}:${item.reason}`)
                    .join(', ')}
                </div>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
