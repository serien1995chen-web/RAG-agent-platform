'use client';

import { Text } from '@chakra-ui/react';
import { useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
import { Button } from './knowledge-primitives';

interface JobResult {
  jobId: string;
  status: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'dead_letter';
  result: { objectBlobRefId?: string; expiresAt?: string } | null;
}

export function ArchiveAction({ spaceId, sourceIds }: { spaceId: string; sourceIds: string[] }) {
  const { t } = useKnowledgeI18n();
  const [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'completed' | 'failed'>(
    'idle',
  );
  const [busy, setBusy] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const waitForArchive = async (jobId: string): Promise<JobResult> => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const job = await knowledgeRequest<JobResult>(`/v1/knowledge/jobs/${jobId}`);
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed' || job.status === 'dead_letter') {
        throw new DOMException('archive failed', 'OperationError');
      }
      setStatus('running');
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new DOMException('archive timed out', 'TimeoutError');
  };

  const archive = async () => {
    if (sourceIds.length === 0) return;
    setBusy(true);
    setStatus('queued');
    setDownloadUrl(null);
    try {
      const job = await knowledgeRequest<JobResult>(
        `/v1/knowledge/spaces/${spaceId}/source-archives`,
        { method: 'POST', body: { sourceIds } },
      );
      setStatus(job.status === 'queued' ? 'queued' : 'running');
      const completed = await waitForArchive(job.jobId);
      const blobId = completed.result?.objectBlobRefId;
      if (!blobId) throw new DOMException('archive artifact missing', 'NotFoundError');
      const ticket = await knowledgeRequest<{ url: string }>(
        `/v1/knowledge/files/${blobId}/download`,
        { method: 'POST', body: {} },
      );
      setDownloadUrl(ticket.url);
      setStatus('completed');
    } catch {
      setStatus('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        isDisabled={sourceIds.length === 0}
        busy={busy}
        onClick={() => void archive()}
      >
        {t('sources.archive')}
      </Button>
      {status !== 'idle' ? (
        <Text fontSize="xs" color={status === 'failed' ? 'kn.danger' : 'kn.inkMuted'}>
          {status === 'queued'
            ? t('files.archiveQueued')
            : status === 'running'
              ? t('files.archiveRunning')
              : status === 'completed'
                ? t('files.archiveCompleted')
                : t('files.archiveFailed')}
        </Text>
      ) : null}
      {downloadUrl ? (
        <Button
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          tone="primary"
        >
          {t('files.archiveDownload')}
        </Button>
      ) : null}
    </>
  );
}
