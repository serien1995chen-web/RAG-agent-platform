import {
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
import type { OpsStatusRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

export default function SystemStatusPage() {
  const status = useKnowledgeRequest<OpsStatusRecord>('/v1/knowledge/operations/status');
  const queueRows = Object.entries(status.data?.queueDepth ?? {}).map(([name, depth]) => ({
    name,
    depth,
  }));

  return (
    <>
      <Head>
        <title>System status</title>
      </Head>
      <PageHeader
        eyebrow="Runtime"
        title="System status"
        description="Live dependency probes, queue depth and vector profile registry."
      />
      <ProblemNotice error={status.error} />
      {status.loading || !status.data ? (
        <LoadingState />
      ) : (
        <>
          <div className="metric-strip">
            <div className="metric">
              <span>Runtime</span>
              <strong>
                <StatusTag value={status.data.status} tone={statusTone(status.data.status)} />
              </strong>
            </div>
            <div className="metric">
              <span>Storage</span>
              <strong>{status.data.storage.provider}</strong>
            </div>
            <div className="metric">
              <span>Vector profiles</span>
              <strong>{status.data.vector.profiles.join(' / ')}</strong>
            </div>
            <div className="metric">
              <span>Queue families</span>
              <strong>{queueRows.length}</strong>
            </div>
          </div>

          <Section title="Queue depth" meta="waiting + active + delayed + failed">
            <DataTable
              rows={queueRows}
              rowKey={(row) => row.name}
              empty="No queue metrics are available."
              columns={[
                {
                  key: 'name',
                  label: 'Queue',
                  render: (row) => <span className="mono">{row.name}</span>,
                },
                { key: 'depth', label: 'Depth', render: (row) => row.depth },
              ]}
            />
          </Section>

          <Section title="Reconciliation snapshot">
            <div className="detail-grid">
              <div className="detail-cell">
                <span>Measured at</span>
                <strong>{formatDate(status.data.reconciliation.lastRunAt)}</strong>
              </div>
              <div className="detail-cell">
                <span>Orphan objects</span>
                <strong>{status.data.reconciliation.orphanObjects}</strong>
              </div>
              <div className="detail-cell">
                <span>Cleanable vectors</span>
                <strong>{status.data.reconciliation.orphanVectors}</strong>
              </div>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
