import {
  Button,
  Field,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  S6JobsPanel,
  Section,
  SelectInput,
  StatusTag,
  ensureConsoleSession,
  formatDate,
  knowledgeQueryKeys,
  knowledgeRequest,
  useKnowledgeEnumLabel,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type S6JobAction,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { JobRecord, PageInfo, SpaceRecord } from '../../../lib/knowledge-types';
import { statusTone } from '../../../lib/knowledge-types';

type JobResponse = { items: JobRecord[]; pageInfo: PageInfo };

export default function JobsPage() {
  const router = useRouter();
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const [kind, setKind] = useState(typeof router.query.kind === 'string' ? router.query.kind : '');
  const [status, setStatus] = useState(
    typeof router.query.status === 'string' ? router.query.status : '',
  );
  const [selectedJobId, setSelectedJobId] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const deferredKind = useDeferredValue(kind);
  const deferredStatus = useDeferredValue(status);
  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '200', sort: '-updatedAt' });
    return `/v1/knowledge/jobs?${query.toString()}`;
  }, []);
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const jobs = useKnowledgeQuery<JobResponse>(knowledgeQueryKeys.jobs.list({ limit: 200 }), path, {
    refetchInterval: selectedJobId ? 3_000 : 10_000,
  });
  const mutate = useKnowledgeMutation<JobRecord, { action: S6JobAction; job: JobRecord }>({
    mutationFn: ({ action, job }) =>
      knowledgeRequest<JobRecord>(`/v1/knowledge/jobs/${job.jobId}/${action}`, {
        method: 'POST',
        body: { version: job.version },
      }),
    invalidateKeys: [knowledgeQueryKeys.jobs.list()],
  });
  const allJobs = jobs.data?.items ?? [];
  const filteredJobs = allJobs.filter(
    (job) =>
      (!deferredKind || job.kind === deferredKind) &&
      (!deferredStatus || job.status === deferredStatus),
  );
  const selected = allJobs.find((job) => job.jobId === selectedJobId);

  useEffect(() => {
    void ensureConsoleSession()
      .then((session) =>
        setIsAdmin(session.isWorkspaceOwner || session.scopes.includes('knowledge:admin')),
      )
      .catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    if (!spaceId) return;
    const next = new URLSearchParams();
    if (kind) next.set('kind', kind);
    if (status) next.set('status', status);
    void router.replace(
      `/spaces/${spaceId}/jobs${next.size ? `?${next.toString()}` : ''}`,
      undefined,
      { shallow: true },
    );
  }, [kind, router, spaceId, status]);

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
      <ProblemNotice
        error={space.error ?? jobs.error ?? mutate.error}
        onRetry={() => void jobs.refetch()}
      />
      <div className="selector-row">
        <Field label={t('jobs.filterKind')}>
          <SelectInput value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">{t('jobs.allKinds')}</option>
            {['parse', 'segment', 'qa', 'embed', 'index', 'fulltext', 'rebuild'].map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t('jobs.filterStatus')}>
          <SelectInput value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t('jobs.allStatuses')}</option>
            {[
              'queued',
              'leased',
              'running',
              'retry_wait',
              'paused',
              'cancelling',
              'cancelled',
              'failed',
              'dead_letter',
              'succeeded',
            ].map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>
      <Section
        title={t('jobs.register')}
        meta={jobs.data ? t('common.records', { count: filteredJobs.length }) : undefined}
      >
        {jobs.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={filteredJobs}
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
                render: (job) => `${String(job.progress.percent ?? 0)}%`,
              },
              {
                key: 'updated',
                label: t('jobs.columnUpdated'),
                render: (job) => formatDate(job.updatedAt, locale),
              },
              {
                key: 'actions',
                label: t('common.actions'),
                render: (job) => (
                  <Button size="sm" onClick={() => setSelectedJobId(job.jobId)}>
                    {t('jobs.open')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Section>
      {selected ? (
        <S6JobsPanel
          job={selected}
          isAdmin={isAdmin}
          busy={mutate.isLoading}
          onAction={(action) => void mutate.mutateAsync({ action, job: selected })}
        />
      ) : null}
    </>
  );
}
