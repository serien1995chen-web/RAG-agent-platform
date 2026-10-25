import {
  Button,
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
import { useRouter } from 'next/router';
import type { JobRecord, PageInfo, SpaceRecord } from '../../../lib/knowledge-types';
import { statusTone } from '../../../lib/knowledge-types';

type JobResponse = { items: JobRecord[]; pageInfo: PageInfo };

export default function JobsPage() {
  const router = useRouter();
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const jobs = useKnowledgeQuery<JobResponse>(
    knowledgeQueryKeys.jobs.list({ limit: 200 }),
    '/v1/knowledge/jobs?limit=200',
  );

  return (
    <>
      <Head>
        <title>
          {space.data ? t('jobs.title', { name: space.data.name }) : t('jobs.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('jobs.eyebrow')}
        title={t('jobs.heading')}
        description={t('jobs.description')}
        actions={
          <Button onClick={() => void jobs.refetch()} busy={jobs.isFetching}>
            {t('jobs.refresh')}
          </Button>
        }
      />
      <ProblemNotice error={space.error ?? jobs.error} onRetry={() => void jobs.refetch()} />
      <Section
        title={t('jobs.register')}
        meta={jobs.data ? t('common.records', { count: jobs.data.items.length }) : undefined}
      >
        {jobs.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={jobs.data?.items ?? []}
            rowKey={(job) => job.jobId}
            empty={t('jobs.empty')}
            caption={t('jobs.register')}
            columns={[
              {
                key: 'job',
                label: t('jobs.columnJob'),
                render: (job) => <span className="mono">{job.jobId}</span>,
              },
              {
                key: 'kind',
                label: t('jobs.columnKind'),
                render: (job) => enumLabel(job.kind),
              },
              {
                key: 'status',
                label: t('jobs.columnStatus'),
                render: (job) => <StatusTag value={job.status} tone={statusTone(job.status)} />,
              },
              {
                key: 'attempts',
                label: t('jobs.columnAttempts'),
                render: (job) => `${job.attempts} / ${job.maxAttempts}`,
              },
              {
                key: 'progress',
                label: t('jobs.columnProgress'),
                render: (job) => String(job.progress.percent ?? 0) + '%',
              },
              {
                key: 'updated',
                label: t('jobs.columnUpdated'),
                render: (job) => formatDate(job.updatedAt, locale),
              },
            ]}
          />
        )}
      </Section>
    </>
  );
}
