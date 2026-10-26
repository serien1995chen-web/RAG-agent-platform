import {
  Button,
  CatalogBatchResult,
  CatalogMoveControl,
  EmptyState,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  SelectInput,
  Section,
  StatusTag,
  formatDate,
  knowledgeQueryKeys,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  useKnowledgeQuery,
  knowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useState } from 'react';
import type { Column } from '@kb/web';
import type { BatchActionResult, PageInfo, SpaceRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

type Response = { items: SpaceRecord[]; pageInfo: PageInfo };

export default function SpacesPage() {
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaces = useKnowledgeQuery<Response>(
    knowledgeQueryKeys.spaces.list({ limit: 200 }),
    '/v1/knowledge/spaces?limit=200',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [batchTarget, setBatchTarget] = useState('');
  const [batchResult, setBatchResult] = useState<BatchActionResult | null>(null);
  const [batchProblem, setBatchProblem] = useState<unknown>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const data = spaces.data;
  const folders = (data?.items ?? []).filter((space) => space.kind === 'folder');
  const names = new Map((data?.items ?? []).map((space) => [space.id, space.name]));
  const runBatch = async (action: 'move' | 'delete') => {
    if (selected.length === 0 || selected.length > 100) return;
    if (
      action === 'delete' &&
      !window.confirm(t('spaces.confirmBatchDelete', { count: selected.length }))
    ) {
      return;
    }
    setBatchBusy(true);
    setBatchProblem(null);
    try {
      const versions = Object.fromEntries(
        selected.map((id) => [
          id,
          (data?.items.find((space) => space.id === id)?.version ?? 0) as number,
        ]),
      );
      const result = await knowledgeRequest<BatchActionResult>(
        '/v1/knowledge/spaces/batch-actions',
        {
          method: 'POST',
          idempotencyKey: globalThis.crypto.randomUUID(),
          body: {
            action,
            ids: selected,
            versions,
            ...(action === 'move' ? { targetParentId: batchTarget || null } : {}),
          },
        },
      );
      setBatchResult(result);
      setSelected([]);
      await spaces.refetch();
    } catch (error) {
      setBatchProblem(error);
    } finally {
      setBatchBusy(false);
    }
  };
  const columns: Column<SpaceRecord>[] = [
    {
      key: 'select',
      label: t('spaces.select'),
      render: (space) => (
        <input
          type="checkbox"
          aria-label={`${t('spaces.select')} ${space.name}`}
          checked={selected.includes(space.id)}
          onChange={(event) =>
            setSelected((current) =>
              event.target.checked
                ? [...current, space.id]
                : current.filter((id) => id !== space.id),
            )
          }
        />
      ),
    },
    {
      key: 'name',
      label: t('spaces.columnName'),
      render: (space) => <a href={`/spaces/${space.id}/overview`}>{space.name}</a>,
    },
    { key: 'kind', label: t('spaces.columnType'), render: (space) => enumLabel(space.kind) },
    {
      key: 'status',
      label: t('spaces.columnStatus'),
      render: (space) => <StatusTag value={space.status} tone={statusTone(space.status)} />,
    },
    {
      key: 'access',
      label: t('spaces.columnAccess'),
      render: (space) => enumLabel(space.accessMode),
    },
    {
      key: 'revision',
      label: t('spaces.columnReferenceRevision'),
      render: (space) => space.referenceRevision,
    },
    {
      key: 'path',
      label: t('spaces.columnPath'),
      render: (space) =>
        space.parentPath?.length
          ? space.parentPath.map((id) => names.get(id) ?? id).join(' / ')
          : t('governance.root'),
    },
    {
      key: 'actions',
      label: t('sources.columnActions'),
      render: (space) => (
        <CatalogMoveControl
          resourceType="space"
          resourceId={space.id}
          endpoint={`/v1/knowledge/spaces/${space.id}/move`}
          version={space.version}
          currentParentId={space.parentSpaceId}
          targets={folders.map((folder) => ({ id: folder.id, label: folder.name }))}
          onMoved={async () => {
            await spaces.refetch();
          }}
        />
      ),
    },
    {
      key: 'updated',
      label: t('spaces.columnUpdated'),
      render: (space) => formatDate(space.updatedAt, locale),
    },
  ];

  return (
    <>
      <Head>
        <title>{t('spaces.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('spaces.eyebrow')}
        title={t('spaces.heading')}
        description={t('spaces.description')}
        actions={
          <Button href="/spaces/new" tone="primary">
            {t('spaces.new')}
          </Button>
        }
      />
      <ProblemNotice error={spaces.error ?? batchProblem} />
      {spaces.isLoading ? (
        <LoadingState />
      ) : (
        <Section
          title={t('spaces.register')}
          meta={data ? t('common.records', { count: data.items.length }) : undefined}
        >
          {data && data.items.length > 0 ? (
            <>
              <div className="inline-actions">
                <SelectInput
                  aria-label={t('governance.moveTarget')}
                  value={batchTarget}
                  onChange={(event) => setBatchTarget(event.target.value)}
                  maxW="220px"
                >
                  <option value="">{t('governance.root')}</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </SelectInput>
                <Button
                  size="sm"
                  busy={batchBusy}
                  isDisabled={selected.length === 0 || selected.length > 100}
                  onClick={() => void runBatch('move')}
                >
                  {t('spaces.batchMove')}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  busy={batchBusy}
                  isDisabled={selected.length === 0 || selected.length > 100}
                  onClick={() => void runBatch('delete')}
                >
                  {t('spaces.batchDelete')}
                </Button>
                <span>{t('common.records', { count: selected.length })}</span>
              </div>
              <CatalogBatchResult result={batchResult} />
              <KnowledgeDataTable
                rows={data.items}
                columns={columns}
                rowKey={(space) => space.id}
                empty={t('spaces.emptyDescription')}
                caption={t('spaces.register')}
              />
            </>
          ) : (
            <EmptyState
              title={t('spaces.emptyTitle')}
              description={t('spaces.emptyDescription')}
              action={
                <Button href="/spaces/new" tone="primary">
                  {t('spaces.create')}
                </Button>
              }
            />
          )}
        </Section>
      )}
    </>
  );
}
