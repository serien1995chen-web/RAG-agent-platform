import {
  Button,
  EmptyState,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  StatusTag,
  formatDate,
  knowledgeQueryKeys,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  useKnowledgeQuery,
} from '@kb/web';
import Head from 'next/head';
import type { Column } from '@kb/web';
import type { PageInfo, SpaceRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

type Response = { items: SpaceRecord[]; pageInfo: PageInfo };

export default function SpacesPage() {
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaces = useKnowledgeQuery<Response>(
    knowledgeQueryKeys.spaces.list({ limit: 200 }),
    '/v1/knowledge/spaces?limit=200',
  );
  const data = spaces.data;
  const columns: Column<SpaceRecord>[] = [
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
      <ProblemNotice error={spaces.error} />
      {spaces.isLoading ? (
        <LoadingState />
      ) : (
        <Section
          title={t('spaces.register')}
          meta={data ? t('common.records', { count: data.items.length }) : undefined}
        >
          {data && data.items.length > 0 ? (
            <KnowledgeDataTable
              rows={data.items}
              columns={columns}
              rowKey={(space) => space.id}
              empty={t('spaces.emptyDescription')}
              caption={t('spaces.register')}
            />
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
