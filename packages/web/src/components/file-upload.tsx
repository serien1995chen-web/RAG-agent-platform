'use client';

import { Box, Progress, Text } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import {
  knowledgeMultipartUpload,
  restoreKnowledgeUpload,
  type KnowledgeFileUploadState,
} from '../client/file-upload';
import { KnowledgeRequestError } from '../client/knowledge-client';
import { toProblemView, useKnowledgeI18n } from '../i18n';
import { Button } from './knowledge-primitives';

export interface FileUploadPanelProps {
  knowledgeSpaceId: string;
  onComplete?: (blobId: string) => void;
}

export function FileUploadPanel({ knowledgeSpaceId, onComplete }: FileUploadPanelProps) {
  const { t } = useKnowledgeI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<KnowledgeFileUploadState | null>(null);

  const upload = async () => {
    if (!file || !knowledgeSpaceId) return;
    abortRef.current = new AbortController();
    try {
      const result = await knowledgeMultipartUpload(file, {
        knowledgeSpaceId,
        signal: abortRef.current.signal,
        onState: setState,
      });
      onComplete?.(result.blobId);
    } catch {
      // State carries a localized messageKey from the request layer.
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <Box width="100%" maxW="720px" minW="0" overflowWrap="anywhere">
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-label={t('files.choose')}
        onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          setFile(selected);
          setState(null);
          if (selected && knowledgeSpaceId) {
            void restoreKnowledgeUpload(knowledgeSpaceId, selected.name, selected.size).then(
              (session) => {
                if (!session) return;
                setState({
                  phase: 'uploading',
                  uploadId: session.uploadId,
                  progress: 0,
                  completedParts: 0,
                  totalParts: session.partCount,
                  result: null,
                  error: null,
                });
              },
            );
          }
        }}
      />
      <Box className="inline-actions">
        <Button size="sm" onClick={() => inputRef.current?.click()}>
          {t('files.choose')}
        </Button>
        <Button
          size="sm"
          tone="primary"
          isDisabled={!file || !knowledgeSpaceId}
          busy={state?.phase === 'uploading' || state?.phase === 'completing'}
          onClick={() => void upload()}
        >
          {t('files.upload')}
        </Button>
        {abortRef.current ? (
          <Button size="sm" tone="danger" onClick={() => abortRef.current?.abort()}>
            {t('files.cancelled')}
          </Button>
        ) : null}
      </Box>
      <Text mt={2} fontSize="sm" color="kn.inkMuted">
        {file?.name ?? t('files.noFile')}
      </Text>
      {state && state.phase !== 'idle' ? (
        <Box mt={3}>
          <Progress
            value={state.progress}
            size="sm"
            aria-label={t('files.progress', {
              percent: state.progress,
              completed: state.completedParts,
              total: state.totalParts,
            })}
          />
          <Text mt={1} fontSize="xs">
            {state.phase === 'completed'
              ? t('files.completed')
              : state.phase === 'aborted'
                ? t('files.aborted')
                : t('files.progress', {
                    percent: state.progress,
                    completed: state.completedParts,
                    total: state.totalParts,
                  })}
          </Text>
        </Box>
      ) : null}
      {state?.error ? (
        <Text role="alert" mt={2} fontSize="sm" color="kn.danger">
          {t(
            state.error instanceof KnowledgeRequestError
              ? toProblemView(state.error.problem).messageKey
              : 'errors.unknown',
          )}
        </Text>
      ) : null}
    </Box>
  );
}
