'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { knowledgeQueryKeys } from '../query/query-keys';
import { useKnowledgeQuery } from '../query/use-knowledge-query';
import { useKnowledgeI18n } from '../i18n';
import { Button, ProblemNotice, SelectInput, StatusTag } from './knowledge-primitives';

export interface MoveTargetOption {
  id: string;
  label: string;
}

export function CatalogMoveControl(props: {
  resourceType: 'space' | 'directory' | 'source';
  resourceId: string;
  version: number;
  currentParentId: string | null;
  endpoint: string;
  targets: MoveTargetOption[];
  onMoved: () => void | Promise<void>;
}) {
  const { t } = useKnowledgeI18n();
  const [target, setTarget] = useState(props.currentParentId ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const key = useRef<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    key.current ??= globalThis.crypto.randomUUID();
    try {
      await knowledgeRequest(props.endpoint, {
        method: 'POST',
        body: { targetParentId: target || null, version: props.version },
        idempotencyKey: key.current,
      });
      key.current = null;
      await props.onMoved();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box className="move-control" minW="150px">
      <Flex gap={2} align="center" wrap="wrap">
        <SelectInput
          size="sm"
          aria-label={t('governance.moveTarget')}
          value={target}
          maxW="160px"
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">{t('governance.root')}</option>
          {props.targets
            .filter((option) => option.id !== props.resourceId)
            .map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
        </SelectInput>
        <Button size="sm" busy={busy} onClick={() => void submit()}>
          {t('governance.applyMove')}
        </Button>
      </Flex>
      {problem ? <ProblemNotice error={problem} /> : null}
    </Box>
  );
}

export interface BatchResultView {
  code?: 'KNOWLEDGE_PARTIAL_SUCCESS';
  requested: number;
  succeeded: number;
  failed: number;
  items: Array<{ id: string; success: boolean; code?: string }>;
}

export function CatalogBatchResult(props: { result: BatchResultView | null }) {
  const { t } = useKnowledgeI18n();
  if (!props.result) return null;
  return (
    <Box
      role={props.result.failed > 0 ? 'alert' : 'status'}
      mt={3}
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="kn.line"
      py={3}
    >
      <Text fontWeight="700">
        {props.result.failed > 0
          ? t('governance.batchPartial', {
              succeeded: props.result.succeeded,
              failed: props.result.failed,
            })
          : t('governance.batchSucceeded', { count: props.result.succeeded })}
      </Text>
      {props.result.failed > 0 ? (
        <Box as="ul" mt={2} mb={0} pl={5}>
          {props.result.items
            .filter((item) => !item.success)
            .map((item) => (
              <li key={item.id}>
                <span className="mono">{item.id}</span> {item.code ?? 'KNOWLEDGE_INTERNAL_ERROR'}
              </li>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}

interface ExportJob {
  jobId: string;
  status: 'queued' | 'leased' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'dead_letter';
  result?: { objectBlobRefId?: string; expiresAt?: string; sourceCount?: number } | null;
  error?: { code?: string } | null;
}

export function SpaceExportAction(props: { spaceId: string }) {
  const { t } = useKnowledgeI18n();
  const [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'succeeded' | 'failed'>(
    'idle',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  const exportSpace = async () => {
    setBusy(true);
    setStatus('queued');
    setProblem(null);
    setDownloadUrl(null);
    key.current ??= globalThis.crypto.randomUUID();
    try {
      const job = await knowledgeRequest<ExportJob>(
        `/v1/knowledge/spaces/${props.spaceId}/exports`,
        {
          method: 'POST',
          body: { format: 'zip' },
          idempotencyKey: key.current,
        },
      );
      key.current = null;
      setStatus(job.status === 'queued' ? 'queued' : 'running');
      let current = job;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (current.status === 'succeeded') break;
        if (current.status === 'failed' || current.status === 'dead_letter') {
          setStatus('failed');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        current = await knowledgeRequest<ExportJob>(`/v1/knowledge/jobs/${job.jobId}`);
        setStatus(current.status === 'queued' ? 'queued' : 'running');
      }
      if (current.status !== 'succeeded' || !current.result?.objectBlobRefId) {
        setStatus('failed');
        return;
      }
      const ticket = await knowledgeRequest<{ url: string }>(
        `/v1/knowledge/files/${current.result.objectBlobRefId}/download`,
        {
          method: 'POST',
          body: {},
          idempotencyKey: globalThis.crypto.randomUUID(),
        },
      );
      setDownloadUrl(ticket.url);
      setStatus('succeeded');
    } catch (error) {
      setStatus('failed');
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Flex gap={2} align="center" wrap="wrap">
        <Button size="sm" tone="primary" busy={busy} onClick={() => void exportSpace()}>
          {t('governance.exportSpace')}
        </Button>
        {status !== 'idle' ? (
          <StatusTag
            value={status}
            tone={status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : 'warning'}
          />
        ) : null}
        {downloadUrl ? (
          <Button href={downloadUrl} target="_blank" rel="noopener noreferrer" size="sm">
            {t('governance.downloadExport')}
          </Button>
        ) : null}
      </Flex>
      {problem ? <ProblemNotice error={problem} /> : null}
    </Box>
  );
}

interface ReferenceRecord {
  referrerType: 'app' | 'workflow';
  referrerId: string;
  referrerVersion: string;
  referrerName: string;
  status: 'active' | 'stale' | 'removed';
  lastSeenAt: string;
}

export function SpaceReferencesPanel(props: { spaceId: string }) {
  const { t } = useKnowledgeI18n();
  const query = useKnowledgeQuery<{
    referenceRevision: number;
    count: number;
    items: ReferenceRecord[];
  }>(
    knowledgeQueryKeys.spaces.references(props.spaceId),
    `/v1/knowledge/spaces/${props.spaceId}/references`,
  );
  return (
    <Box>
      <ProblemNotice error={query.error} onRetry={() => void query.refetch()} />
      {query.isLoading ? (
        <Text>{t('common.loading')}</Text>
      ) : query.data?.items.length ? (
        <Box overflowX="auto">
          <table className="knowledge-table">
            <caption>{t('governance.references')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('governance.referrer')}</th>
                <th scope="col">{t('governance.version')}</th>
                <th scope="col">{t('governance.status')}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((item) => (
                <tr key={`${item.referrerType}:${item.referrerId}:${item.referrerVersion}`}>
                  <td>
                    {item.referrerName}
                    <Text as="span" display="block" color="kn.inkMuted" fontSize="xs">
                      {item.referrerType} / {item.referrerId}
                    </Text>
                  </td>
                  <td className="mono">{item.referrerVersion}</td>
                  <td>
                    <StatusTag
                      value={item.status}
                      tone={
                        item.status === 'active'
                          ? 'warning'
                          : item.status === 'removed'
                            ? 'danger'
                            : 'neutral'
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      ) : (
        <Text color="kn.inkMuted">{t('governance.noReferences')}</Text>
      )}
    </Box>
  );
}
