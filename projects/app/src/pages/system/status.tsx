import {
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  StatusTag,
  formatDate,
  knowledgeQueryKeys,
  useKnowledgeI18n,
  useKnowledgeQuery,
} from '@kb/web';
import Head from 'next/head';
import type { OpsStatusRecord } from '../../lib/knowledge-types';
import { statusTone } from '../../lib/knowledge-types';

export default function SystemStatusPage() {
  const { locale, t } = useKnowledgeI18n();
  const status = useKnowledgeQuery<OpsStatusRecord>(
    knowledgeQueryKeys.operations.status,
    '/v1/knowledge/operations/status',
  );
  const queueRows = Object.entries(status.data?.queueDepth ?? {}).map(([name, depth]) => ({
    name,
    depth,
  }));

  return (
    <>
      <Head>
        <title>{t('status.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('status.eyebrow')}
        title={t('status.heading')}
        description={t('status.description')}
      />
      <ProblemNotice error={status.error} onRetry={() => void status.refetch()} />
      {status.isLoading || !status.data ? (
        <LoadingState />
      ) : (
        <>
          <div className="metric-strip">
            <div className="metric">
              <span>{t('status.runtime')}</span>
              <strong>
                <StatusTag value={status.data.status} tone={statusTone(status.data.status)} />
              </strong>
            </div>
            <div className="metric">
              <span>{t('status.storage')}</span>
              <strong>{status.data.storage.provider}</strong>
            </div>
            <div className="metric">
              <span>{t('status.vectorProfiles')}</span>
              <strong>{status.data.vector.profiles.join(' / ')}</strong>
            </div>
            <div className="metric">
              <span>{t('status.queueFamilies')}</span>
              <strong>{queueRows.length}</strong>
            </div>
          </div>

          <Section title={t('status.queueDepth')} meta={t('status.queueDepthMeta')}>
            <KnowledgeDataTable
              rows={queueRows}
              rowKey={(row) => row.name}
              empty={t('status.noQueues')}
              caption={t('status.queueDepth')}
              columns={[
                {
                  key: 'name',
                  label: t('status.columnQueue'),
                  render: (row) => <span className="mono">{row.name}</span>,
                },
                { key: 'depth', label: t('status.columnDepth'), render: (row) => row.depth },
              ]}
            />
          </Section>

          <Section title={t('status.reconciliation')}>
            <div className="detail-grid">
              <div className="detail-cell">
                <span>{t('status.measuredAt')}</span>
                <strong>{formatDate(status.data.reconciliation.lastRunAt, locale)}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('status.orphanObjects')}</span>
                <strong>{status.data.reconciliation.orphanObjects}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('status.orphanVectors')}</span>
                <strong>{status.data.reconciliation.orphanVectors}</strong>
              </div>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
