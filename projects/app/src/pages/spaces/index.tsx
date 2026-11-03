import {
  AddIcon,
  Button,
  CatalogBatchResult,
  CatalogMoveControl,
  ConfirmDialog,
  EmptyState,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  PageToolbar,
  ProblemNotice,
  Section,
  SelectInput,
  SearchIcon,
  StatusTag,
  formatDate,
  knowledgeQueryKeys,
  knowledgeRequest,
  useCursorKnowledgeQuery,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  type Column,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import type { BatchActionResult, SpaceRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

export default function SpacesPage() {
  const router = useRouter();
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const [sort, setSort] = useState(
    typeof router.query.sort === 'string' && router.query.sort ? router.query.sort : '-updatedAt',
  );
  const [query, setQuery] = useState(typeof router.query.q === 'string' ? router.query.q : '');
  const [kind, setKind] = useState(typeof router.query.kind === 'string' ? router.query.kind : '');
  const [selected, setSelected] = useState<string[]>([]);
  const [batchTarget, setBatchTarget] = useState('');
  const [batchResult, setBatchResult] = useState<BatchActionResult | null>(null);
  const [batchProblem, setBatchProblem] = useState<unknown>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const spaces = useCursorKnowledgeQuery<SpaceRecord>({
    key: knowledgeQueryKeys.spaces.list({ sort }),
    path: '/v1/knowledge/spaces',
    limit: 50,
    sort,
  });
  const items = useMemo(
    () => spaces.data?.pages.flatMap((page) => page.items) ?? [],
    [spaces.data],
  );
  const folders = items.filter((space) => space.kind === 'folder');
  const names = new Map(items.map((space) => [space.id, space.name]));
  const loadedItems = items.filter((space) => {
    if (kind && space.kind !== kind) return false;
    if (query.trim() && !space.name.toLowerCase().includes(query.trim().toLowerCase())) {
      return false;
    }
    return true;
  });
  const visibleIds = new Set(loadedItems.map((space) => space.id));
  const selectedVisible = selected.filter((id) => visibleIds.has(id));

  useEffect(() => {
    const next = new URLSearchParams();
    if (sort !== '-updatedAt') next.set('sort', sort);
    if (query.trim()) next.set('q', query.trim());
    if (kind) next.set('kind', kind);
    const current = new URLSearchParams(router.asPath.split('?')[1] ?? '');
    if (current.toString() === next.toString()) return;
    void router.replace(
      { pathname: router.pathname, query: next.size ? Object.fromEntries(next) : {} },
      undefined,
      { shallow: true },
    );
  }, [kind, query, router, sort]);

  const runBatch = async (action: 'move' | 'delete') => {
    if (selectedVisible.length === 0 || selectedVisible.length > 100) return;
    setBatchBusy(true);
    setBatchProblem(null);
    try {
      const versions = Object.fromEntries(
        selectedVisible.map((id) => [id, items.find((space) => space.id === id)?.version ?? 0]),
      );
      const result = await knowledgeRequest<BatchActionResult>(
        '/v1/knowledge/spaces/batch-actions',
        {
          method: 'POST',
          idempotencyKey: globalThis.crypto.randomUUID(),
          body: {
            action,
            ids: selectedVisible,
            versions,
            ...(action === 'move' ? { targetParentId: batchTarget || null } : {}),
          },
        },
      );
      setBatchResult(result);
      setSelected([]);
      setDeleteOpen(false);
      setPendingDelete(false);
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
                ? [...new Set([...current, space.id])]
                : current.filter((id) => id !== space.id),
            )
          }
        />
      ),
    },
    {
      key: 'name',
      label: t('spaces.columnName'),
      render: (space) => (
        <div>
          <a
            href={`/spaces/${space.id}/overview`}
            onClick={(event) => {
              event.preventDefault();
              void router.push(`/spaces/${space.id}/overview`);
            }}
          >
            {space.name}
          </a>
          <small className="mono cell-subtitle">{space.id}</small>
        </div>
      ),
    },
    {
      key: 'kind',
      label: t('spaces.columnType'),
      render: (space) => (
        <StatusTag value={space.kind} tone={space.kind === 'folder' ? 'warning' : 'neutral'} />
      ),
    },
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
      render: (space) => <span className="mono">{space.referenceRevision}</span>,
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
          targets={folders
            .filter((folder) => folder.id !== space.id)
            .map((folder) => ({ id: folder.id, label: folder.name }))}
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
          <Button href="/spaces/new" tone="primary" onClick={() => void router.push('/spaces/new')}>
            <AddIcon boxSize={3.5} mr={2} />
            {t('spaces.new')}
          </Button>
        }
      />
      <ProblemNotice error={spaces.error ?? batchProblem} />

      <div className="metric-strip">
        <div className="metric">
          <span>{t('spaces.metricLoaded')}</span>
          <strong>{items.length}</strong>
        </div>
        <div className="metric">
          <span>{t('spaces.metricSpaces')}</span>
          <strong>{loadedItems.filter((space) => space.kind === 'space').length}</strong>
        </div>
        <div className="metric">
          <span>{t('spaces.metricFolders')}</span>
          <strong>{folders.length}</strong>
        </div>
        <div className="metric">
          <span>{t('spaces.selectedCount')}</span>
          <strong>{selectedVisible.length}</strong>
        </div>
      </div>

      <Section
        title={t('spaces.register')}
        meta={t('spaces.loadedScope', { count: loadedItems.length })}
        actions={
          <Button size="sm" onClick={() => void spaces.refetch()} busy={spaces.isFetching}>
            {t('jobs.refresh')}
          </Button>
        }
      >
        <PageToolbar summary={<p className="subtle-label">{t('spaces.filterScope')}</p>}>
          <label className="search-field">
            <SearchIcon boxSize={4} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('spaces.searchPlaceholder')}
              aria-label={t('spaces.searchPlaceholder')}
            />
          </label>
          <SelectInput
            aria-label={t('spaces.columnType')}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            maxW="150px"
          >
            <option value="">{t('jobs.allKinds')}</option>
            <option value="space">{t('enum.space')}</option>
            <option value="folder">{t('enum.folder')}</option>
          </SelectInput>
          <SelectInput
            aria-label={t('spaces.sortLabel')}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            maxW="180px"
          >
            <option value="-updatedAt">{t('spaces.sortUpdated')}</option>
            <option value="updatedAt">{t('spaces.sortOldest')}</option>
            <option value="name">{t('spaces.sortName')}</option>
          </SelectInput>
        </PageToolbar>

        {loadedItems.length > 0 ? (
          <div className="inline-actions batch-toolbar">
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
              isDisabled={selectedVisible.length === 0 || selectedVisible.length > 100}
              onClick={() => void runBatch('move')}
            >
              {t('spaces.batchMove')}
            </Button>
            <Button
              size="sm"
              tone="danger"
              busy={batchBusy}
              isDisabled={selectedVisible.length === 0 || selectedVisible.length > 100}
              onClick={() => {
                setPendingDelete(true);
                setDeleteOpen(true);
              }}
            >
              {t('spaces.batchDelete')}
            </Button>
            <span className="subtle-label">
              {t('spaces.selectedCountWithCount', { count: selectedVisible.length })}
            </span>
          </div>
        ) : null}
        <CatalogBatchResult result={batchResult} />

        {spaces.isLoading ? (
          <LoadingState />
        ) : loadedItems.length > 0 ? (
          <>
            <KnowledgeDataTable
              rows={loadedItems}
              columns={columns}
              rowKey={(space) => space.id}
              empty={t('spaces.emptyDescription')}
              caption={t('spaces.register')}
            />
            <div className="load-more-row">
              <Button
                size="sm"
                busy={spaces.isFetchingNextPage}
                disabled={!spaces.hasNextPage}
                onClick={() => void spaces.fetchNextPage()}
              >
                {spaces.hasNextPage ? t('common.loadMore') : t('common.allLoaded')}
              </Button>
            </div>
          </>
        ) : (
          <EmptyState
            title={t('spaces.emptyTitle')}
            description={t('spaces.emptyDescription')}
            action={
              <Button
                href="/spaces/new"
                tone="primary"
                onClick={() => void router.push('/spaces/new')}
              >
                {t('spaces.create')}
              </Button>
            }
          />
        )}
      </Section>

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => runBatch('delete')}
        title={t('spaces.batchDeleteTitle')}
        description={t('spaces.confirmBatchDelete', { count: selectedVisible.length })}
        confirmLabel={t('spaces.batchDelete')}
        busy={batchBusy}
        destructive={pendingDelete}
      />
    </>
  );
}
