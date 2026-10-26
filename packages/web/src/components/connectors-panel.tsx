'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
import { Button, ProblemNotice, Section, StatusTag } from './knowledge-primitives';
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

export function ConnectorsPanel(props: ConnectorsPanelProps) {
  const { t } = useKnowledgeI18n();
  const [connector, setConnector] = useState<ConnectorRecord | null>(null);
  const [connectorId, setConnectorId] = useState(props.initialConnectorId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');

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
    if (!connector || !window.confirm(t('connectors.deleteConfirm'))) return;
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
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box minW={0}>
      <Section title={t('connectors.formTitle')} meta={t('connectors.description')}>
        <ConnectorForm
          key={connector?.id ?? `new-${props.initialProvider ?? 'feishu'}`}
          connector={connector}
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
            <Text fontSize="sm" mt={2}>
              cursorVersion {connector.cursorVersion} · nextSyncAt {connector.nextSyncAt ?? 'null'}
            </Text>
            <Flex mt={5} gap={2} wrap="wrap">
              <Button busy={busy} onClick={() => void sync()}>
                {t('connectors.sync')}
              </Button>
              <Button tone="danger" busy={busy} onClick={() => void remove()}>
                {t('connectors.delete')}
              </Button>
            </Flex>
          </Box>
        ) : (
          <Text>{t('connectors.noConnector')}</Text>
        )}
      </Section>

      {message ? <Text role="status">{message}</Text> : null}
      {error ? <ProblemNotice error={error} onRetry={() => setError(null)} /> : null}
    </Box>
  );
}
