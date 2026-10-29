'use client';

import { Box, Flex, SimpleGrid, Text } from '@chakra-ui/react';
import { useState } from 'react';
import type { S10OpsJob, S10Status } from '../client/s10-ops-client';
import { useKnowledgeI18n } from '../i18n';
import { KnowledgeDataTable } from './data-table';
import {
  Button,
  Field,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
} from './knowledge-primitives';

function tone(value: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (value === 'ok' || value === 'REAL_VERIFIED') return 'success';
  if (value === 'degraded' || value === 'FIXTURE_VERIFIED' || value === 'EXTERNAL_UNVERIFIED') {
    return 'warning';
  }
  if (value === 'down' || value === 'timeout' || value === 'failed') return 'danger';
  return 'neutral';
}

export function S10SystemStatus(props: {
  status?: S10Status;
  loading: boolean;
  error: unknown;
  busy: boolean;
  onRetry: () => void;
  onCleanup: (scope: string) => Promise<S10OpsJob>;
  onReconcile: (scope: string, repair: boolean) => Promise<S10OpsJob>;
}) {
  const { t } = useKnowledgeI18n();
  const [cleanupScope, setCleanupScope] = useState('all');
  const [reconcileScope, setReconcileScope] = useState('all');
  const [repair, setRepair] = useState(false);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  if (props.error) {
    return <ProblemNotice error={props.error as Error} onRetry={props.onRetry} />;
  }
  if (props.loading || !props.status) {
    return <Box className="loading-block">{t('common.loading')}</Box>;
  }
  const status = props.status;
  return (
    <>
      <div className="metric-strip">
        <div className="metric">
          <span>{t('status.runtime')}</span>
          <strong>
            <StatusTag value={status.status} tone={tone(status.status)} />
          </strong>
        </div>
        <div className="metric">
          <span>{t('status.storage')}</span>
          <strong>{status.storage.provider}</strong>
        </div>
        <div className="metric">
          <span>{t('status.vectorProfiles')}</span>
          <strong>{status.vector.profiles.join(' / ')}</strong>
        </div>
        <div className="metric">
          <span>{t('status.queueFamilies')}</span>
          <strong>{Object.keys(status.queueLag).length}</strong>
        </div>
      </div>
      <Section title={t('status.dependencies')}>
        <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} spacing={3}>
          {Object.entries(status.dependencies).map(([name, dependency]) => (
            <Box key={name} borderWidth="1px" borderColor="kn.line" p={3} borderRadius="sm">
              <Flex justify="space-between" gap={2} align="center">
                <Text m={0} fontWeight="700">
                  {name}
                </Text>
                <StatusTag value={dependency.status} tone={tone(dependency.status)} />
              </Flex>
              <Text m={0} mt={2} color="kn.inkMuted" fontSize="xs">
                {dependency.latencyMs} ms · {dependency.verificationStatus}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
      </Section>
      <Section title={t('status.queueLag')} meta={t('status.queueLagMeta')}>
        <KnowledgeDataTable
          rows={Object.entries(status.queueLag).map(([name, counts]) => ({ name, ...counts }))}
          rowKey={(row) => row.name}
          empty={t('status.noQueues')}
          caption={t('status.queueLag')}
          columns={[
            {
              key: 'name',
              label: t('status.columnQueue'),
              render: (row) => <span className="mono">{row.name}</span>,
            },
            { key: 'waiting', label: 'waiting', render: (row) => row.waiting },
            { key: 'delayed', label: 'delayed', render: (row) => row.delayed },
            { key: 'active', label: 'active', render: (row) => row.active },
            { key: 'failed', label: 'failed', render: (row) => row.failed },
            { key: 'lag', label: 'lag', render: (row) => row.lag },
          ]}
        />
      </Section>
      <Section title={t('status.probes')}>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
          <Box borderWidth="1px" borderColor="kn.line" p={4} borderRadius="sm">
            <StatusTag value={status.modelProbe.status} tone={tone(status.modelProbe.status)} />
            <Text mt={2} mb={0} fontSize="sm">
              {status.modelProbe.verificationStatus} · {status.modelProbe.latencyMs} ms
            </Text>
          </Box>
          <Box borderWidth="1px" borderColor="kn.line" p={4} borderRadius="sm">
            <Text fontWeight="700" m={0}>
              {t('status.queueLag')}
            </Text>
            <Flex mt={2} gap={2}>
              <StatusTag value={status.queueProbe.status} tone={tone(status.queueProbe.status)} />
              <Text m={0} fontSize="sm">
                {status.queueProbe.verificationStatus} · {status.queueProbe.latencyMs} ms
              </Text>
            </Flex>
          </Box>
          <Box borderWidth="1px" borderColor="kn.line" p={4} borderRadius="sm">
            <Text fontWeight="700" m={0}>
              {t('status.connectors')}
            </Text>
            <Flex mt={2} gap={2}>
              <StatusTag
                value={status.connectorProbe.status}
                tone={tone(status.connectorProbe.status)}
              />
              <Text m={0} fontSize="sm">
                {status.connectorProbe.verificationStatus} · {status.connectorProbe.latencyMs} ms
              </Text>
            </Flex>
          </Box>
          <Box borderWidth="1px" borderColor="kn.line" p={4} borderRadius="sm">
            <Text fontWeight="700" m={0}>
              {t('status.connectors')}
            </Text>
            {status.connectorProbes.length === 0 ? (
              <Text mt={2} mb={0} color="kn.inkMuted" fontSize="sm">
                {t('status.noConnectors')}
              </Text>
            ) : (
              status.connectorProbes.map((connector) => (
                <Flex key={connector.connectorId ?? connector.provider} mt={2} gap={2}>
                  <Text m={0}>{connector.provider}</Text>
                  <StatusTag value={connector.verificationStatus} tone="warning" />
                </Flex>
              ))
            )}
          </Box>
        </SimpleGrid>
      </Section>
      <Section title={t('status.security')}>
        <SimpleGrid columns={{ base: 1, sm: 2, xl: 5 }} spacing={2}>
          {Object.entries(status.securityChecks).map(([key, value]) => (
            <Flex
              key={key}
              justify="space-between"
              borderBottomWidth="1px"
              borderColor="kn.line"
              py={2}
            >
              <Text m={0} fontSize="sm">
                {key}
              </Text>
              <StatusTag
                value={value ? 'enabled' : 'disabled'}
                tone={value ? 'success' : 'danger'}
              />
            </Flex>
          ))}
        </SimpleGrid>
      </Section>
      <Section title={t('status.reconciliation')}>
        <div className="detail-grid">
          <div className="detail-cell">
            <span>{t('status.measuredAt')}</span>
            <strong>
              {status.reconciliation.lastRunAt?.slice(0, 19) ?? t('status.noReconciliation')}
            </strong>
          </div>
          <div className="detail-cell">
            <span>{t('status.state')}</span>
            <strong>{status.reconciliation.state}</strong>
          </div>
          <div className="detail-cell">
            <span>{t('status.diffCount')}</span>
            <strong>{status.reconciliation.diffCount}</strong>
          </div>
          <div className="detail-cell">
            <span>{t('status.repairedCount')}</span>
            <strong>{status.reconciliation.repairedCount}</strong>
          </div>
        </div>
      </Section>
      <Section title={t('status.operations')} meta={t('status.operationsMeta')}>
        <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={4}>
          <Flex gap={2} align="end" wrap="wrap">
            <Field label={t('status.cleanupScope')}>
              <SelectInput
                value={cleanupScope}
                onChange={(event) => setCleanupScope(event.target.value)}
              >
                <option value="all">all</option>
                <option value="ttl_objects">ttl_objects</option>
                <option value="orphan_objects">orphan_objects</option>
                <option value="orphan_vectors">orphan_vectors</option>
                <option value="stale_jobs">stale_jobs</option>
              </SelectInput>
            </Field>
            <Button
              tone="primary"
              busy={props.busy}
              onClick={() => {
                void props
                  .onCleanup(cleanupScope)
                  .then((job) => setSubmittedJobId(job.jobId))
                  .catch(() => undefined);
              }}
            >
              {t('status.cleanup')}
            </Button>
          </Flex>
          <Flex gap={2} align="end" wrap="wrap">
            <Field label={t('status.reconcileScope')}>
              <SelectInput
                value={reconcileScope}
                onChange={(event) => setReconcileScope(event.target.value)}
              >
                <option value="all">all</option>
                <option value="objects">objects</option>
                <option value="vectors">vectors</option>
                <option value="fulltext">fulltext</option>
                <option value="outbox">outbox</option>
              </SelectInput>
            </Field>
            <Field label={t('status.repair')}>
              <SelectInput
                value={repair ? 'true' : 'false'}
                onChange={(event) => setRepair(event.target.value === 'true')}
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </SelectInput>
            </Field>
            <Button
              tone="primary"
              busy={props.busy}
              onClick={() => {
                void props
                  .onReconcile(reconcileScope, repair)
                  .then((job) => setSubmittedJobId(job.jobId))
                  .catch(() => undefined);
              }}
            >
              {t('status.reconcile')}
            </Button>
          </Flex>
        </SimpleGrid>
        {submittedJobId ? (
          <Text mt={4} mb={0} role="status" fontSize="sm">
            {t('status.submittedJob')}: <span className="mono">{submittedJobId}</span>
          </Text>
        ) : null}
      </Section>
    </>
  );
}
