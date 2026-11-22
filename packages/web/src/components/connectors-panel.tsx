'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
import { Button, ProblemNotice, Section, StatusTag } from './knowledge-primitives';
import { ConfirmDialog } from './knowledge-overlays';
import { ConnectorForm, type ConnectorFormInput, type ConnectorRecord } from './connector-form';

interface JobResult {
  jobId: string;
}

export interface ConnectorsPanelProps {
  spaceId: string;
  initialProvider?: string;
  initialConnectorId?: string;
}

function updateQuery(connector: ConnectorRecord) {
  if (typeof window === 'undefined') return;
  const next = new URL(window.location.href);
  next.searchParams.set('connectorId', connector.id);
  next.searchParams.set('provider', connector.provider);
  window.history.replaceState(window.history.state, '', next);
}

function displayTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString('zh-CN');
}

function connectorStale(connector: ConnectorRecord): boolean {
  if (connector.status !== 'active' || !connector.syncEnabled || !connector.nextSyncAt)
    return false;
  return Date.parse(connector.nextSyncAt) + 5 * 60_000 < Date.now();
}

function lastErrorView(error: Record<string, unknown> | null): string {
  if (!error) return '—';
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return [code, message].filter(Boolean).join(' · ') || '—';
}

export function ConnectorsPanel(props: ConnectorsPanelProps) {
  const { t } = useKnowledgeI18n();
  const [connector, setConnector] = useState<ConnectorRecord | null>(null);
  const [connectorId, setConnectorId] = useState(props.initialConnectorId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!connectorId) return;
    let active = true;
    setBusy(true);
    knowledgeRequest<ConnectorRecord>(`/v1/knowledge/connectors/${connectorId}`)
      .then((value) => {
        if (active) {
          setConnector(value);
          setError(null);
        }
      })
      .catch((caught) => {
        if (active) setError(caught);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [connectorId]);

  const submit = async (input: ConnectorFormInput): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const saved = connector
        ? await knowledgeRequest<ConnectorRecord>(`/v1/knowledge/connectors/${connector.id}`, {
            method: 'PATCH',
            body: {
              version: input.version,
              name: input.name,
              config: input.config,
              ...(input.credentials ? { credentials: input.credentials } : {}),
              syncEnabled: input.syncEnabled,
              syncIntervalMinutes: input.syncIntervalMinutes,
            },
          })
        : await knowledgeRequest<ConnectorRecord>(
            `/v1/knowledge/spaces/${props.spaceId}/connectors/${input.provider}/connect`,
            {
              method: 'POST',
              body: {
                provider: input.provider,
                name: input.name,
                config: input.config,
                credentials: input.credentials,
                syncEnabled: input.syncEnabled,
                syncIntervalMinutes: input.syncIntervalMinutes,
              },
            },
          );
      setConnector(saved);
      setConnectorId(saved.id);
      updateQuery(saved);
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    if (!connector) return;
    setBusy(true);
    setError(null);
    try {
      const job = await knowledgeRequest<JobResult>(
        `/v1/knowledge/connectors/${connector.id}/sync`,
        {
          method: 'POST',
          body: { full: false },
        },
      );
      setMessage(t('connectors.syncQueued', { jobId: job.jobId }));
      const latest = await knowledgeRequest<ConnectorRecord>(
        `/v1/knowledge/connectors/${connector.id}`,
      );
      setConnector(latest);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!connector) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/connectors/${connector.id}`, {
        method: 'DELETE',
        body: {},
      });
      setMessage(t('connectors.deleted'));
      setConnector(null);
      setConnectorId('');
      setDeleteOpen(false);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const stale = connector ? connectorStale(connector) : false;
  const syncDisabledReason = connector
    ? !connector.syncEnabled
      ? t('connectors.syncDisabledPaused')
      : ['paused', 'failed', 'syncing', 'deleting', 'deleted'].includes(connector.status)
        ? t('connectors.syncDisabledStatus', { status: connector.status })
        : ''
    : '';
  const syncDisabled = busy || syncDisabledReason.length > 0;

  return (
    <Box minW={0}>
      <Section title={t('connectors.formTitle')} meta={t('connectors.description')}>
        <ConnectorForm
          key={connector?.id ?? `new-${props.initialProvider ?? 'feishu'}`}
          connector={connector}
          initialProvider={props.initialProvider}
          busy={busy}
          onSubmit={submit}
        />
      </Section>

      <Section title={t('connectors.metadata')}>
        {connector ? (
          <Box maxW="760px">
            <Flex gap={3} wrap="wrap" align="center" mb={4}>
              <Text fontWeight="700">{connector.name}</Text>
              <StatusTag value={connector.provider} />
              <StatusTag value={connector.status} />
              <Text fontSize="sm">
                {t('connectors.version')} {connector.version}
              </Text>
            </Flex>
            <Text fontSize="sm">
              credentialMetadata: {String(connector.credentialMetadata.configured)} · keyVersion{' '}
              {connector.credentialMetadata.keyVersion} ·{' '}
              {connector.credentialMetadata.redactedFields.join(', ')}
            </Text>
            <Box mt={2} fontSize="sm" aria-live="polite" aria-atomic="true" display="grid" gap={1}>
              <Text>
                {t('connectors.lastAttemptAt')}: {displayTime(connector.lastAttemptAt)}
              </Text>
              <Text>
                {t('connectors.lastSuccessAt')}: {displayTime(connector.lastSuccessAt)}
              </Text>
              <Text>
                {t('connectors.nextSyncAt')}: {displayTime(connector.nextSyncAt)}
              </Text>
              <Text>
                {t('connectors.lastError')}: {lastErrorView(connector.lastError)}
              </Text>
              {stale ? (
                <Text color="kn.danger" fontWeight="700">
                  {t('connectors.stale')}
                </Text>
              ) : null}
            </Box>
            <Flex mt={5} gap={2} wrap="wrap">
              <Button
                busy={busy}
                disabled={syncDisabled}
                aria-describedby={syncDisabledReason ? 'connector-sync-disabled-reason' : undefined}
                title={syncDisabledReason || undefined}
                onClick={() => void sync()}
              >
                {t('connectors.sync')}
              </Button>
              <Button tone="danger" busy={busy} onClick={() => setDeleteOpen(true)}>
                {t('connectors.delete')}
              </Button>
            </Flex>
            {syncDisabledReason ? (
              <Text id="connector-sync-disabled-reason" mt={2} fontSize="sm" color="kn.muted">
                {syncDisabledReason}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Text>{t('connectors.noConnector')}</Text>
        )}
      </Section>

      {message ? <Text role="status">{message}</Text> : null}
      {error ? <ProblemNotice error={error} onRetry={() => setError(null)} /> : null}
      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove()}
        title={t('connectors.delete')}
        description={t('connectors.deleteConfirm')}
        confirmLabel={t('connectors.delete')}
        busy={busy}
        destructive
      />
    </Box>
  );
}
