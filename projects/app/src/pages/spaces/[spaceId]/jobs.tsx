import {
  Button,
  DataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  StatusTag,
  formatDate,
  useKnowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { JobRecord, PageInfo, SpaceRecord } from '../../../lib/knowledge-types';
import { statusTone } from '../../../lib/knowledge-types';

type JobResponse = { items: JobRecord[]; pageInfo: PageInfo };

export default function JobsPage() {
  const router = useRouter();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const jobs = useKnowledgeRequest<JobResponse>('/v1/knowledge/jobs?limit=200', []);

  return (
    <>
      <Head>
        <title>{space.data ? `${space.data.name} jobs` : 'Jobs'}</title>
      </Head>
      <PageHeader
        eyebrow="Operations"
        title="Jobs"
        description="Mongo-backed job facts. Queue delivery and deferred processors are tracked separately."
        actions={
          <Button onClick={() => void jobs.reload()} busy={jobs.loading}>
            Refresh jobs
          </Button>
        }
      />
      <ProblemNotice error={space.error ?? jobs.error} />
      <Section
        title="Job register"
        meta={jobs.data ? `${jobs.data.items.length} records` : undefined}
      >
        {jobs.loading ? (
          <LoadingState />
        ) : (
          <DataTable
            rows={jobs.data?.items ?? []}
            rowKey={(job) => job.jobId}
            empty="No jobs have been created."
            columns={[
              {
                key: 'job',
                label: 'Job',
                render: (job) => <span className="mono">{job.jobId}</span>,
              },
              { key: 'kind', label: 'Kind', render: (job) => job.kind },
              {
                key: 'status',
                label: 'Status',
                render: (job) => <StatusTag value={job.status} tone={statusTone(job.status)} />,
              },
              {
                key: 'attempts',
                label: 'Attempts',
                render: (job) => `${job.attempts} / ${job.maxAttempts}`,
              },
              {
                key: 'progress',
                label: 'Progress',
                render: (job) => String(job.progress.percent ?? 0) + '%',
              },
              { key: 'updated', label: 'Updated', render: (job) => formatDate(job.updatedAt) },
            ]}
          />
        )}
      </Section>
    </>
  );
}
