'use client';

import { Box, Checkbox, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
import { knowledgeQueryKeys } from '../query/query-keys';
import { useKnowledgeQuery } from '../query/use-knowledge-query';
import {
  Button,
  Field,
  ProblemNotice,
  SelectInput,
  TextArea,
  TextInput,
} from './knowledge-primitives';
import { FileUploadPanel } from './file-upload';

export type ImportSourceKind =
  | 'files'
  | 'text'
  | 'url'
  | 'template'
  | 'backup'
  | 'api_library'
  | 'feishu'
  | 'yuque'
  | 'dingtalk';

export const IMPORT_SOURCE_KINDS: readonly ImportSourceKind[] = [
  'files',
  'text',
  'url',
  'template',
  'backup',
  'api_library',
  'feishu',
  'yuque',
  'dingtalk',
];

interface JobResult {
  jobId: string;
}

interface JobProgress {
  jobId: string;
  status: string;
  progress: Record<string, unknown>;
  error: { code?: string; message?: string } | null;
  updatedAt: string;
}

interface DirectoryOption {
  id: string;
  name: string;
}

export interface ImportWorkbenchProps {
  spaceId: string;
  initialKind?: ImportSourceKind;
  initialDirectoryId?: string;
  s5ParseConfig?: Record<string, unknown>;
  s5ChunkingSettings?: Record<string, unknown>;
}

export function splitIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toggleIdSelection(value: string, id: string, selected: boolean): string {
  const current = splitIds(value);
  const next = selected
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((entry) => entry !== id);
  return next.join(', ');
}

export function connectorProviderForKind(
  kind: ImportSourceKind,
): 'feishu' | 'yuque' | 'dingtalk' | null {
  return kind === 'feishu' || kind === 'yuque' || kind === 'dingtalk' ? kind : null;
}

export function ImportWorkbench(props: ImportWorkbenchProps) {
  const { t } = useKnowledgeI18n();
  const [kind, setKind] = useState<ImportSourceKind>(props.initialKind ?? 'files');
  const [directoryId, setDirectoryId] = useState(props.initialDirectoryId ?? '');
  const [uploadId, setUploadId] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  const [textName, setTextName] = useState('');
  const [textBody, setTextBody] = useState('');
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('body');
  const [dryRun, setDryRun] = useState(false);
  const [conflictStrategy, setConflictStrategy] = useState('fail');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiAuthMode, setApiAuthMode] = useState('none');
  const [apiAuthorization, setApiAuthorization] = useState('');
  const [apiParentId, setApiParentId] = useState('');
  const [apiFileIds, setApiFileIds] = useState('');
  const [apiCatalog, setApiCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [connectorRoot, setConnectorRoot] = useState('');
  const [connectorItems, setConnectorItems] = useState('');
  const [connectorCatalog, setConnectorCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState('');
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
  const [jobProblem, setJobProblem] = useState<unknown>(null);
  const directories = useKnowledgeQuery<{ items: DirectoryOption[] }>(
    knowledgeQueryKeys.directories.list(props.spaceId),
    `/v1/knowledge/spaces/${props.spaceId}/directories?limit=200`,
  );

  useEffect(() => {
    if (!jobId) {
      setJobProgress(null);
      setJobProblem(null);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const terminal = new Set(['succeeded', 'failed', 'cancelled', 'dead_letter']);
    const poll = async () => {
      try {
        const latest = await knowledgeRequest<JobProgress>(`/v1/knowledge/jobs/${jobId}`);
        if (!active) return;
        setJobProgress(latest);
        setJobProblem(null);
        if (!terminal.has(latest.status)) {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (caught) {
        if (active) setJobProblem(caught);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = new URL(window.location.href);
    next.searchParams.set('kind', kind);
    if (directoryId) next.searchParams.set('directoryId', directoryId);
    else next.searchParams.delete('directoryId');
    window.history.replaceState(window.history.state, '', next);
  }, [directoryId, kind]);

  const chunking = props.s5ChunkingSettings ?? {
    trainingType: 'chunk',
    chunkSettingMode: 'auto',
  };
  const apiConfig = {
    provider: 'custom_api',
    baseUrl: apiBaseUrl,
    catalogPath: '/v1/file/list',
    detailPath: '/v1/file/detail',
    contentPath: '/v1/file/content',
    previewPath: '/v1/file/read',
    pageMode: 'cursor',
  };
  const apiCredentials = {
    provider: 'custom_api',
    authMode: apiAuthMode,
    ...(apiAuthorization ? { authorization: apiAuthorization } : {}),
  };
  const activeConnectorProvider = connectorProviderForKind(kind) ?? 'feishu';

  const submit = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    setJobId('');
    try {
      const job = await knowledgeRequest<JobResult>(path, {
        method: 'POST',
        body,
      });
      setJobId(job.jobId);
      if (kind === 'api_library') setApiAuthorization('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const submitCurrent = async () => {
    const base = `/v1/knowledge/spaces/${props.spaceId}/imports`;
    if (kind === 'files') {
      if (!uploadId) return;
      await submit(`${base}/files`, {
        directoryId: directoryId || null,
        uploadIds: [uploadId],
        parseProvider:
          typeof props.s5ParseConfig?.provider === 'string'
            ? props.s5ParseConfig.provider
            : 'liteparse',
        parseConfig: props.s5ParseConfig ?? {},
        chunking,
      });
      return;
    }
    if (kind === 'text') {
      await submit(`${base}/text`, {
        knowledgeSpaceId: props.spaceId,
        name: textName,
        directoryId: directoryId || null,
        text: textBody,
        chunking,
      });
      return;
    }
    if (kind === 'url') {
      await submit(`${base}/url`, {
        url,
        selector,
        directoryId: directoryId || null,
      });
      return;
    }
    if (kind === 'template' || kind === 'backup') {
      await submit(`${base}/${kind}`, {
        uploadId,
        directoryId: directoryId || null,
        ...(kind === 'backup' ? { dryRun, conflictStrategy } : {}),
      });
      return;
    }
    if (kind === 'api_library') {
      await submit(`${base}/api-library`, {
        config: apiConfig,
        credentials: apiCredentials,
        fileIds: splitIds(apiFileIds),
        directoryId: directoryId || null,
      });
      return;
    }
    await submit(`/v1/knowledge/spaces/${props.spaceId}/connectors/${kind}/import`, {
      externalIds: splitIds(connectorItems),
      directoryId: directoryId || null,
    });
  };

  const browseApi = async (parentId = apiParentId) => {
    setBusy(true);
    setError(null);
    try {
      const catalog = await knowledgeRequest<{ items: Array<Record<string, unknown>> }>(
        `/v1/knowledge/spaces/${props.spaceId}/imports/api-library/catalog`,
        {
          method: 'POST',
          body: {
            config: apiConfig,
            credentials: apiCredentials,
            parentId,
          },
        },
      );
      setApiCatalog(catalog.items);
      setApiParentId(parentId);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const browseConnector = async () => {
    setBusy(true);
    setError(null);
    try {
      const catalog = await knowledgeRequest<{ items: Array<Record<string, unknown>> }>(
        `/v1/knowledge/spaces/${props.spaceId}/connectors/${activeConnectorProvider}/catalog`,
        {
          method: 'POST',
          body: { rootId: connectorRoot },
        },
      );
      setConnectorCatalog(catalog.items);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box className="import-workbench" minW={0} maxW="840px" overflowWrap="anywhere">
      <Box className="import-kind-tabs" role="tablist" aria-label={t('import.kind')} mb={5}>
        {IMPORT_SOURCE_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={kind === option}
            className="import-kind-tab"
            onClick={() => {
              setKind(option);
              setApiFileIds('');
              setApiCatalog([]);
              setApiParentId('');
              setConnectorItems('');
              setConnectorCatalog([]);
              setConnectorRoot('');
              setJobId('');
              setError(null);
            }}
          >
            {t(
              option === 'api_library'
                ? 'enum.apiLibrary'
                : option === 'files'
                  ? 'enum.file'
                  : option === 'backup'
                    ? 'enum.backup'
                    : option === 'feishu'
                      ? 'enum.feishu'
                      : option === 'yuque'
                        ? 'enum.yuque'
                        : option === 'dingtalk'
                          ? 'enum.dingtalk'
                          : option === 'template'
                            ? 'enum.template'
                            : option === 'text'
                              ? 'enum.text'
                              : 'enum.url',
            )}
          </button>
        ))}
      </Box>
      <Box maxW="420px" mb={5}>
        <Field label={t('import.directory')}>
          <SelectInput value={directoryId} onChange={(event) => setDirectoryId(event.target.value)}>
            <option value="">{t('sources.noDirectory')}</option>
            {(directories.data?.items ?? []).map((directory) => (
              <option key={directory.id} value={directory.id}>
                {directory.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </Box>

      {kind === 'files' ? (
        <Box>
          <FileUploadPanel
            knowledgeSpaceId={props.spaceId}
            onComplete={(blobId) => {
              setUploadId(blobId);
              setUploadMessage(t('import.fileQueued'));
            }}
          />
          {uploadMessage ? <Text mt={3}>{uploadMessage}</Text> : null}
        </Box>
      ) : null}

      {kind === 'text' ? (
        <Flex direction="column" gap={4}>
          <Field label={t('import.textName')}>
            <TextInput value={textName} onChange={(event) => setTextName(event.target.value)} />
          </Field>
          <Field label={t('import.textBody')}>
            <TextArea
              minH="180px"
              value={textBody}
              onChange={(event) => setTextBody(event.target.value)}
            />
          </Field>
        </Flex>
      ) : null}

      {kind === 'url' ? (
        <Flex direction="column" gap={4}>
          <Field label={t('import.url')}>
            <TextInput type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <Field label={t('import.selector')}>
            <TextInput value={selector} onChange={(event) => setSelector(event.target.value)} />
          </Field>
        </Flex>
      ) : null}

      {kind === 'template' || kind === 'backup' ? (
        <Flex direction="column" gap={4}>
          <FileUploadPanel
            knowledgeSpaceId={props.spaceId}
            onComplete={(blobId) => {
              setUploadId(blobId);
              setUploadMessage(t('import.fileQueued'));
            }}
          />
          {kind === 'backup' ? (
            <>
              <Checkbox isChecked={dryRun} onChange={(event) => setDryRun(event.target.checked)}>
                {t('import.dryRun')}
              </Checkbox>
              <Field label={t('import.conflictStrategy')}>
                <SelectInput
                  value={conflictStrategy}
                  onChange={(event) => setConflictStrategy(event.target.value)}
                >
                  <option value="fail">fail</option>
                  <option value="skip">skip</option>
                  <option value="overwrite">overwrite</option>
                </SelectInput>
              </Field>
            </>
          ) : null}
        </Flex>
      ) : null}

      {kind === 'api_library' ? (
        <Flex direction="column" gap={4}>
          <Field label={t('import.apiBaseUrl')}>
            <TextInput
              type="url"
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
            />
          </Field>
          <Field label={t('import.apiAuthMode')}>
            <SelectInput
              value={apiAuthMode}
              onChange={(event) => setApiAuthMode(event.target.value)}
            >
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="api_key">api_key</option>
            </SelectInput>
          </Field>
          <Field label={t('import.apiAuthorization')}>
            <TextInput
              type="password"
              autoComplete="off"
              value={apiAuthorization}
              onChange={(event) => setApiAuthorization(event.target.value)}
            />
          </Field>
          <Field label="Parent ID">
            <TextInput
              value={apiParentId}
              onChange={(event) => setApiParentId(event.target.value)}
            />
          </Field>
          <Field label={t('import.apiFileIds')}>
            <TextInput value={apiFileIds} onChange={(event) => setApiFileIds(event.target.value)} />
          </Field>
          <Flex gap={2} wrap="wrap">
            <Button busy={busy} onClick={() => void browseApi()}>
              {t('import.apiBrowse')}
            </Button>
          </Flex>
          {apiCatalog.map((item) => {
            const itemId = String(item.id);
            if (item.type === 'directory') {
              return (
                <Flex key={itemId} align="center" gap={2} wrap="wrap">
                  <Text fontSize="sm">{String(item.name)} · directory</Text>
                  <Button size="sm" onClick={() => void browseApi(itemId)}>
                    {t('import.apiBrowse')}
                  </Button>
                </Flex>
              );
            }
            return (
              <Checkbox
                key={itemId}
                isChecked={splitIds(apiFileIds).includes(itemId)}
                onChange={(event) =>
                  setApiFileIds(toggleIdSelection(apiFileIds, itemId, event.target.checked))
                }
              >
                {String(item.name)} · document
              </Checkbox>
            );
          })}
        </Flex>
      ) : null}

      {kind === 'feishu' || kind === 'yuque' || kind === 'dingtalk' ? (
        <Flex direction="column" gap={4}>
          <Field label={t('import.connectorProvider')}>
            <SelectInput value={activeConnectorProvider} disabled>
              <option value={activeConnectorProvider}>
                {activeConnectorProvider === 'feishu'
                  ? t('enum.feishu')
                  : activeConnectorProvider === 'yuque'
                    ? t('enum.yuque')
                    : t('enum.dingtalk')}
              </option>
            </SelectInput>
          </Field>
          <Field label={t('import.connectorRoot')}>
            <TextInput
              value={connectorRoot}
              onChange={(event) => setConnectorRoot(event.target.value)}
            />
          </Field>
          <Flex gap={2} wrap="wrap">
            <Button busy={busy} onClick={() => void browseConnector()}>
              {t('import.apiBrowse')}
            </Button>
          </Flex>
          <Field label={t('import.connectorItems')}>
            <TextInput
              value={connectorItems}
              onChange={(event) => setConnectorItems(event.target.value)}
            />
          </Field>
          {connectorCatalog.map((item) => {
            const itemId = String(item.externalId ?? item.id);
            if (item.type === 'directory') {
              return (
                <Text key={itemId} fontSize="sm">
                  {String(item.title ?? item.name)} · directory
                </Text>
              );
            }
            return (
              <Checkbox
                key={itemId}
                isChecked={splitIds(connectorItems).includes(itemId)}
                onChange={(event) =>
                  setConnectorItems(toggleIdSelection(connectorItems, itemId, event.target.checked))
                }
              >
                {String(item.title ?? item.name)} · document
              </Checkbox>
            );
          })}
        </Flex>
      ) : null}

      <Flex mt={6} gap={3} align="center" wrap="wrap">
        <Button
          tone="primary"
          busy={busy}
          isDisabled={kind === 'files' && !uploadId}
          onClick={() => void submitCurrent()}
        >
          {t('import.submit')}
        </Button>
        {jobId ? <Text role="status">{t('import.queued', { jobId })}</Text> : null}
      </Flex>
      {error ? <ProblemNotice error={error} onRetry={() => void submitCurrent()} /> : null}
      {jobProgress ? (
        <Box className="job-progress-card" mt={5}>
          <Flex align="center" justify="space-between" gap={3} wrap="wrap">
            <Box>
              <Text className="subtle-label" display="block">
                {t('import.jobLive')}
              </Text>
              <Text as="strong" display="block" mt={1}>
                {jobProgress.jobId}
              </Text>
            </Box>
            <Text as="strong" color="kn.primary">
              {jobProgress.status}
            </Text>
          </Flex>
          <Box className="job-progress-track" mt={4} aria-hidden>
            <Box
              className="job-progress-fill"
              width={`${Math.max(0, Math.min(100, Number(jobProgress.progress.percent ?? 0)))}%`}
            />
          </Box>
          <Text mt={2} mb={0} color="kn.inkMuted" fontSize="xs">
            {String(jobProgress.progress.percent ?? 0)}% · {jobProgress.updatedAt}
          </Text>
          {jobProgress.error?.code ? (
            <Text mt={2} mb={0} color="kn.danger" fontSize="sm">
              {jobProgress.error.code}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {jobProblem ? <ProblemNotice error={jobProblem} /> : null}
    </Box>
  );
}
