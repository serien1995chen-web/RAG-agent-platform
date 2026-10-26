'use client';

import { Box, Checkbox, Flex } from '@chakra-ui/react';
import { useEffect, useState, type FormEvent } from 'react';
import { useKnowledgeI18n } from '../i18n';
import { Button, Field, SelectInput, TextInput } from './knowledge-primitives';

export interface ConnectorRecord {
  id: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  provider: 'custom_api' | 'feishu' | 'yuque' | 'dingtalk';
  name: string;
  status: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  nextSyncAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: Record<string, unknown> | null;
  cursorVersion: number;
  version: number;
  config: Record<string, unknown>;
  credentialMetadata: {
    provider: string;
    schemaVersion: number;
    keyVersion: number;
    configured: boolean;
    redactedFields: string[];
  };
}

export interface ConnectorFormInput {
  provider: ConnectorRecord['provider'];
  name: string;
  config: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  version?: number;
}

export const CONNECTOR_PROVIDERS = ['feishu', 'yuque', 'dingtalk', 'custom_api'] as const;

export const CONNECTOR_CREDENTIAL_FIELDS: Readonly<
  Record<ConnectorRecord['provider'], readonly string[]>
> = {
  custom_api: ['authorization'],
  feishu: ['appId', 'appSecret'],
  yuque: ['userId', 'token'],
  dingtalk: ['appKey', 'appSecret', 'userId'],
};

export function ConnectorForm(props: {
  connector?: ConnectorRecord | null;
  busy?: boolean;
  onSubmit: (input: ConnectorFormInput) => Promise<boolean>;
}) {
  const { t } = useKnowledgeI18n();
  const [provider, setProvider] = useState<ConnectorRecord['provider']>(
    props.connector?.provider ?? 'feishu',
  );
  const [name, setName] = useState(props.connector?.name ?? '');
  const [syncEnabled, setSyncEnabled] = useState(props.connector?.syncEnabled ?? true);
  const [interval, setInterval] = useState(String(props.connector?.syncIntervalMinutes ?? 60));
  const [folderToken, setFolderToken] = useState('');
  const [basePath, setBasePath] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [rootNodeId, setRootNodeId] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [pageMode, setPageMode] = useState('cursor');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [userId, setUserId] = useState('');
  const [token, setToken] = useState('');
  const [appKey, setAppKey] = useState('');
  const [authMode, setAuthMode] = useState('none');
  const [authorization, setAuthorization] = useState('');
  const [credentialsTouched, setCredentialsTouched] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);

  useEffect(() => {
    if (!props.connector) return;
    setProvider(props.connector.provider);
    setName(props.connector.name);
    setSyncEnabled(props.connector.syncEnabled);
    setInterval(String(props.connector.syncIntervalMinutes));
    setFolderToken(String(props.connector.config.folderToken ?? ''));
    setBasePath(String(props.connector.config.basePath ?? ''));
    setOperatorId(String(props.connector.config.operatorId ?? ''));
    setRootNodeId(String(props.connector.config.rootNodeId ?? ''));
    setApiBaseUrl(String(props.connector.config.baseUrl ?? ''));
    setPageMode(String(props.connector.config.pageMode ?? 'cursor'));
  }, [props.connector]);

  const clearCredentials = () => {
    setAppSecret('');
    setToken('');
    setAuthorization('');
  };

  const credentials = (): Record<string, unknown> | undefined => {
    if (props.connector && !credentialsTouched) return undefined;
    if (provider === 'custom_api') {
      if (authMode !== 'none' && !authorization) return undefined;
      return {
        provider,
        authMode,
        ...(authorization ? { authorization } : {}),
      };
    }
    if (provider === 'feishu') {
      if (!appId || !appSecret) return undefined;
      return { provider, appId, appSecret };
    }
    if (provider === 'yuque') {
      if (!userId || !token) return undefined;
      return { provider, userId, token };
    }
    if (!appKey || !appSecret || !userId) return undefined;
    return { provider, appKey, appSecret, userId };
  };

  const config = (): Record<string, unknown> => {
    if (provider === 'custom_api') {
      return {
        provider,
        baseUrl: apiBaseUrl,
        catalogPath: '/v1/file/list',
        detailPath: '/v1/file/detail',
        contentPath: '/v1/file/content',
        previewPath: '/v1/file/read',
        pageMode,
        ...(basePath ? { basePath } : {}),
      };
    }
    if (provider === 'feishu') return { provider, folderToken };
    if (provider === 'yuque') {
      return { provider, ...(basePath ? { basePath } : {}) };
    }
    return {
      provider,
      ...(operatorId ? { operatorId } : {}),
      ...(rootNodeId ? { rootNodeId } : {}),
    };
  };

  const submit = async () => {
    const credentialValue = credentials();
    if (!props.connector && !credentialValue) return;
    setLocalBusy(true);
    const accepted = await props.onSubmit({
      provider,
      name,
      config: config(),
      ...(credentialValue ? { credentials: credentialValue } : {}),
      syncEnabled,
      syncIntervalMinutes: Number(interval),
      ...(props.connector ? { version: props.connector.version } : {}),
    });
    if (accepted) {
      clearCredentials();
      setCredentialsTouched(false);
    }
    setLocalBusy(false);
  };

  return (
    <Box
      as="form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}
      maxW="760px"
    >
      <Flex direction={{ base: 'column', md: 'row' }} gap={4}>
        <Field label={t('connectors.provider')}>
          <SelectInput
            value={provider}
            disabled={Boolean(props.connector)}
            onChange={(event) => setProvider(event.target.value as ConnectorRecord['provider'])}
          >
            {CONNECTOR_PROVIDERS.map((option) => (
              <option key={option} value={option}>
                {t(
                  option === 'custom_api'
                    ? 'enum.connector'
                    : option === 'feishu'
                      ? 'enum.feishu'
                      : option === 'yuque'
                        ? 'enum.yuque'
                        : 'enum.dingtalk',
                )}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label={t('connectors.name')}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
      </Flex>

      <Box mt={4} borderTopWidth="1px" borderColor="kn.line" pt={4}>
        {provider === 'custom_api' ? (
          <Flex direction="column" gap={3}>
            <Field label={t('connectors.apiBaseUrl')}>
              <TextInput
                type="url"
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
              />
            </Field>
            <Field label={t('connectors.basePath')}>
              <TextInput value={basePath} onChange={(event) => setBasePath(event.target.value)} />
            </Field>
            <Field label={t('connectors.pageMode')}>
              <SelectInput value={pageMode} onChange={(event) => setPageMode(event.target.value)}>
                <option value="none">none</option>
                <option value="cursor">cursor</option>
                <option value="offset">offset</option>
              </SelectInput>
            </Field>
          </Flex>
        ) : provider === 'feishu' ? (
          <Field label={t('connectors.folderToken')}>
            <TextInput
              value={folderToken}
              onChange={(event) => setFolderToken(event.target.value)}
            />
          </Field>
        ) : provider === 'yuque' ? (
          <Field label={t('connectors.basePath')}>
            <TextInput value={basePath} onChange={(event) => setBasePath(event.target.value)} />
          </Field>
        ) : (
          <Flex direction="column" gap={3}>
            <Field label={t('connectors.operatorId')}>
              <TextInput
                value={operatorId}
                onChange={(event) => setOperatorId(event.target.value)}
              />
            </Field>
            <Field label={t('connectors.rootNodeId')}>
              <TextInput
                value={rootNodeId}
                onChange={(event) => setRootNodeId(event.target.value)}
              />
            </Field>
          </Flex>
        )}
      </Box>

      <Box mt={4} borderTopWidth="1px" borderColor="kn.line" pt={4}>
        {provider === 'custom_api' ? (
          <>
            <Field label={t('connectors.authMode')}>
              <SelectInput
                value={authMode}
                onChange={(event) => {
                  setAuthMode(event.target.value);
                  setCredentialsTouched(true);
                }}
              >
                <option value="none">none</option>
                <option value="bearer">bearer</option>
                <option value="api_key">api_key</option>
              </SelectInput>
            </Field>
            <Field label={t('connectors.authorization')}>
              <TextInput
                type="password"
                autoComplete="off"
                value={authorization}
                onChange={(event) => {
                  setAuthorization(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
          </>
        ) : provider === 'feishu' ? (
          <Flex direction="column" gap={3}>
            <Field label={t('connectors.appId')}>
              <TextInput
                value={appId}
                onChange={(event) => {
                  setAppId(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
            <Field label={t('connectors.appSecret')}>
              <TextInput
                type="password"
                autoComplete="off"
                value={appSecret}
                onChange={(event) => {
                  setAppSecret(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
          </Flex>
        ) : provider === 'yuque' ? (
          <Flex direction="column" gap={3}>
            <Field label={t('connectors.userId')}>
              <TextInput
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
            <Field label={t('connectors.token')}>
              <TextInput
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
          </Flex>
        ) : (
          <Flex direction="column" gap={3}>
            <Field label={t('connectors.appKey')}>
              <TextInput
                value={appKey}
                onChange={(event) => {
                  setAppKey(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
            <Field label={t('connectors.appSecret')}>
              <TextInput
                type="password"
                autoComplete="off"
                value={appSecret}
                onChange={(event) => {
                  setAppSecret(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
            <Field label={t('connectors.userId')}>
              <TextInput
                value={userId}
                onChange={(event) => {
                  setUserId(event.target.value);
                  setCredentialsTouched(true);
                }}
              />
            </Field>
          </Flex>
        )}
      </Box>

      <Flex mt={4} gap={4} align="center" wrap="wrap">
        <Checkbox
          isChecked={syncEnabled}
          onChange={(event) => setSyncEnabled(event.target.checked)}
        >
          {t('connectors.syncEnabled')}
        </Checkbox>
        <Field label={t('connectors.interval')}>
          <TextInput
            type="number"
            min={15}
            max={1440}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
          />
        </Field>
      </Flex>

      <Flex mt={5}>
        <Button tone="primary" busy={props.busy || localBusy} onClick={() => void submit()}>
          {props.connector ? t('connectors.update') : t('connectors.connect')}
        </Button>
      </Flex>
    </Box>
  );
}
