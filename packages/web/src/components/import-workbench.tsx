'use client';

import { Box, Checkbox, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { knowledgeRequest } from '../client/knowledge-client';
import { useKnowledgeI18n } from '../i18n';
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

export interface ImportWorkbenchProps {
  spaceId: string;
  initialKind?: ImportSourceKind;
  initialDirectoryId?: string;
}

export function splitIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ImportWorkbench(props: ImportWorkbenchProps) {
  const { t } = useKnowledgeI18n();
  const [kind, setKind] = useState<ImportSourceKind>(props.initialKind ?? 'files');
  const [directoryId, setDirectoryId] = useState(props.initialDirectoryId ?? '');
  const [parseProvider, setParseProvider] = useState('liteparse');
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
  const [connectorProvider, setConnectorProvider] = useState('feishu');
  const [connectorRoot, setConnectorRoot] = useState('');
  const [connectorItems, setConnectorItems] = useState('');
  const [connectorCatalog, setConnectorCatalog] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jobId, setJobId] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = new URL(window.location.href);
    next.searchParams.set('kind', kind);
    if (directoryId) next.searchParams.set('directoryId', directoryId);
    else next.searchParams.delete('directoryId');
    window.history.replaceState(window.history.state, '', next);
  }, [directoryId, kind]);

  const chunking = { trainingType: 'chunk', chunkSettingMode: 'auto' };
  const apiConfig = {
    provider: 'custom_api',
    baseUrl: apiBaseUrl,
    catalogPath: '/v1/file/list',
    detailPath: '/v1/file/detail',
    contentPath: '/v1/file/content',
    previewPath: '/v1/file/read',
    pageMode: 'cursor',
    ...(apiParentId ? { basePath: apiParentId } : {}),
  };
  const apiCredentials = {
    provider: 'custom_api',
    authMode: apiAuthMode,
    ...(apiAuthorization ? { authorization: apiAuthorization } : {}),
  };

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
        parseProvider,
        parseConfig: {},
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

  const browseApi = async () => {
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
            parentId: apiParentId,
          },
        },
      );
      setApiCatalog(catalog.items);
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
        `/v1/knowledge/spaces/${props.spaceId}/connectors/${connectorProvider}/catalog`,
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
      <Flex direction={{ base: 'column', md: 'row' }} gap={4} mb={5}>
        <Field label={t('import.kind')}>
          <SelectInput
            value={kind}
            onChange={(event) => setKind(event.target.value as ImportSourceKind)}
          >
            {IMPORT_SOURCE_KINDS.map((option) => (
              <option key={option} value={option}>
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
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t('import.directory')}>
          <TextInput
            value={directoryId}
            onChange={(event) => setDirectoryId(event.target.value)}
            placeholder="24-hex"
          />
        </Field>
      </Flex>

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
          <Field label={t('import.parseProvider')}>
            <SelectInput
              value={parseProvider}
              onChange={(event) => setParseProvider(event.target.value)}
            >
              {['liteparse', 'sangfor', 'somark', 'textin', 'doc2x'].map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </SelectInput>
          </Field>
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
          {apiCatalog.map((item) => (
            <Text key={String(item.id)} fontSize="sm">
              {String(item.name)} · {String(item.type)}
            </Text>
          ))}
        </Flex>
      ) : null}

      {kind === 'feishu' || kind === 'yuque' || kind === 'dingtalk' ? (
        <Flex direction="column" gap={4}>
          <Field label={t('import.connectorProvider')}>
            <SelectInput
              value={connectorProvider}
              onChange={(event) => setConnectorProvider(event.target.value)}
            >
              <option value="feishu">{t('enum.feishu')}</option>
              <option value="yuque">{t('enum.yuque')}</option>
              <option value="dingtalk">{t('enum.dingtalk')}</option>
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
          {connectorCatalog.map((item) => (
            <Text key={String(item.externalId ?? item.id)} fontSize="sm">
              {String(item.title ?? item.name)} · {String(item.type)}
            </Text>
          ))}
        </Flex>
      ) : null}

      <Flex mt={6} gap={3} align="center" wrap="wrap">
        <Button tone="primary" busy={busy} onClick={() => void submitCurrent()}>
          {t('import.submit')}
        </Button>
        {jobId ? <Text role="status">{t('import.queued', { jobId })}</Text> : null}
      </Flex>
      {error ? <ProblemNotice error={error} onRetry={() => void submitCurrent()} /> : null}
    </Box>
  );
}
