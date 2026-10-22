import {
  DataTable,
  EmptyState,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  StatusTag,
  formatDate,
  useKnowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import type { Column } from '@kb/web';
import type { PageInfo, SpaceRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

type Response = { items: SpaceRecord[]; pageInfo: PageInfo };

export default function SpacesPage() {
  const { data, error, loading } = useKnowledgeRequest<Response>('/v1/knowledge/spaces?limit=200');
  const columns: Column<SpaceRecord>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (space) => <a href={`/spaces/${space.id}/overview`}>{space.name}</a>,
    },
    { key: 'kind', label: 'Type', render: (space) => space.kind },
    {
      key: 'status',
      label: 'Status',
      render: (space) => <StatusTag value={space.status} tone={statusTone(space.status)} />,
    },
    { key: 'access', label: 'Access', render: (space) => space.accessMode },
    { key: 'revision', label: 'Reference revision', render: (space) => space.referenceRevision },
    { key: 'updated', label: 'Updated', render: (space) => formatDate(space.updatedAt) },
  ];

  return (
    <>
      <Head>
        <title>Knowledge spaces</title>
      </Head>
      <PageHeader
        eyebrow="Knowledge catalog"
        title="Spaces"
        description="Spaces and organization folders visible to the active workspace."
        actions={
          <a className="button button-primary" href="/spaces/new">
            New space
          </a>
        }
      />
      <ProblemNotice error={error} />
      {loading ? (
        <LoadingState />
      ) : (
        <Section title="Space register" meta={data ? `${data.items.length} records` : undefined}>
          {data && data.items.length > 0 ? (
            <DataTable
              rows={data.items}
              columns={columns}
              rowKey={(space) => space.id}
              empty="No spaces are visible."
            />
          ) : (
            <EmptyState
              title="No knowledge spaces"
              description="Create the first space to start the architecture baseline."
              action={
                <a className="button button-primary" href="/spaces/new">
                  Create space
                </a>
              }
            />
          )}
        </Section>
      )}
    </>
  );
}
