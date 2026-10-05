import {
  DataTable,
  ErrorBanner,
  LoadingState,
  PageHeader,
  fetchApi,
  tokens,
  translate,
  useRequest,
} from '@kb/web';
import type { ErrorLike } from '@kb/web';
import Link from 'next/link';
import { useCallback, useState } from 'react';

interface DatasetSummary {
  datasetId: string;
  name: string;
  type: string;
  updateTime: string;
}

interface DatasetListData {
  total: number;
  list: DatasetSummary[];
}

const inputStyle = {
  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.font.sizeMd,
} as const;

const buttonStyle = {
  padding: `${tokens.spacing.sm} ${tokens.spacing.md}`,
  border: 'none',
  borderRadius: tokens.radius.md,
  background: tokens.color.primary,
  color: '#ffffff',
  fontSize: tokens.font.sizeMd,
  cursor: 'pointer',
} as const;

export default function DatasetListPage() {
  const load = useCallback(() => fetchApi<DatasetListData>('/api/core/dataset/list?limit=50'), []);
  const { data, loading, error, reload } = useRequest(load);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ErrorLike | null>(null);

  const createDataset = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await fetchApi<{ datasetId: string; state: string }>(
        '/api/core/dataset/create',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            type: 'dataset',
            models: { embeddingModel: 'bge-m3' },
          }),
        },
      );
      if (result.code !== 200) {
        setCreateError(result as ErrorLike);
      } else {
        setName('');
        await reload();
      }
    } finally {
      setCreating(false);
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
      <PageHeader
        title={translate('dataset.list.title')}
        actions={
          <div style={{ display: 'flex', gap: tokens.spacing.sm }}>
            <input
              aria-label={translate('dataset.list.name')}
              placeholder={translate('dataset.list.namePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={inputStyle}
            />
            <button
              type="button"
              onClick={() => void createDataset()}
              disabled={creating || name.trim().length === 0}
              style={buttonStyle}
            >
              {translate('common.create')}
            </button>
          </div>
        }
      />
      {error ? <ErrorBanner error={error} /> : null}
      {createError ? <ErrorBanner error={createError} /> : null}
      {loading ? (
        <LoadingState />
      ) : (
        <DataTable<DatasetSummary>
          rowKey={(row) => row.datasetId}
          rows={data?.list ?? []}
          columns={[
            { key: 'name', title: translate('common.name'), render: (row) => row.name },
            {
              key: 'type',
              title: translate('common.type'),
              render: (row) => translate(`dataset.type.${row.type}`),
            },
            {
              key: 'updateTime',
              title: translate('common.updateTime'),
              render: (row) => row.updateTime,
            },
            {
              key: 'actions',
              title: translate('common.actions'),
              render: (row) => (
                <Link href={`/dataset/detail/${row.datasetId}`}>{translate('common.detail')}</Link>
              ),
            },
          ]}
        />
      )}
    </main>
  );
}
