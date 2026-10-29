'use client';

import { Box, Checkbox, CheckboxGroup, Flex, SimpleGrid, Text } from '@chakra-ui/react';
import { useState } from 'react';
import type { S10ApiKey, S10ApiKeyScope, S10ApiKeySecret } from '../client/s10-ops-client';
import { useKnowledgeI18n } from '../i18n';
import { KnowledgeDataTable } from './data-table';
import {
  Button,
  EmptyState,
  Field,
  ProblemNotice,
  Section,
  StatusTag,
  TextInput,
} from './knowledge-primitives';

const SCOPES: S10ApiKeyScope[] = [
  'knowledge:read',
  'knowledge:search',
  'knowledge:write',
  'knowledge:manage',
  'knowledge:admin',
];

export function S10ApiKeyManager(props: {
  items: S10ApiKey[];
  loading: boolean;
  error: unknown;
  secret: S10ApiKeySecret | null;
  busy: boolean;
  onCreate: (input: {
    name: string;
    scopes: S10ApiKeyScope[];
    spaceIds: string[];
    expiresAt: string | null;
  }) => void;
  onRotate: (key: S10ApiKey) => void;
  onRevoke: (key: S10ApiKey) => void;
  onClearSecret: () => void;
  onRetry: () => void;
}) {
  const { t } = useKnowledgeI18n();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<S10ApiKeyScope[]>(['knowledge:read', 'knowledge:search']);
  const [spaceIds, setSpaceIds] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  if (props.error) {
    return <ProblemNotice error={props.error as Error} onRetry={props.onRetry} />;
  }
  return (
    <>
      {props.secret ? (
        <Box
          role="status"
          aria-live="polite"
          mb={6}
          p={4}
          borderWidth="2px"
          borderColor="kn.warning"
          borderRadius="sm"
          bg="kn.surface"
        >
          <Flex justify="space-between" align="start" gap={4}>
            <Box minW={0}>
              <Text fontWeight="700" m={0}>
                {t('apiKeys.secretOnce')}
              </Text>
              <Text mt={1} mb={3} color="kn.inkMuted" fontSize="sm">
                {t('apiKeys.secretHint')}
              </Text>
              <Text as="code" className="mono" display="block" overflowWrap="anywhere">
                {props.secret.secret}
              </Text>
            </Box>
            <Button onClick={props.onClearSecret}>{t('apiKeys.secretClose')}</Button>
          </Flex>
        </Box>
      ) : null}
      <Section title={t('apiKeys.createTitle')} meta={t('apiKeys.createMeta')}>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
          <Field label={t('apiKeys.name')}>
            <TextInput
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('apiKeys.expiresAt')} hint={t('apiKeys.expiresHint')}>
            <TextInput
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
          <Field label={t('apiKeys.spaceScope')} hint={t('apiKeys.spaceHint')}>
            <TextInput
              value={spaceIds}
              placeholder="65f1..., 65f2..."
              onChange={(event) => setSpaceIds(event.target.value)}
            />
          </Field>
          <Field label={t('apiKeys.scopes')}>
            <CheckboxGroup
              value={scopes}
              onChange={(value) => setScopes(value as S10ApiKeyScope[])}
            >
              <Flex gap={3} wrap="wrap" pt={2}>
                {SCOPES.map((scope) => (
                  <Checkbox key={scope} value={scope} size="sm">
                    {scope}
                  </Checkbox>
                ))}
              </Flex>
            </CheckboxGroup>
          </Field>
        </SimpleGrid>
        <Button
          mt={4}
          tone="primary"
          busy={props.busy}
          disabled={!name.trim() || scopes.length === 0}
          onClick={() => {
            props.onCreate({
              name: name.trim(),
              scopes,
              spaceIds: spaceIds
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            });
            setName('');
            setSpaceIds('');
            setExpiresAt('');
          }}
        >
          {t('apiKeys.create')}
        </Button>
      </Section>
      <Section title={t('apiKeys.list')} meta={t('apiKeys.listMeta')}>
        {props.loading ? (
          <Box className="loading-block">{t('common.loading')}</Box>
        ) : props.items.length === 0 ? (
          <EmptyState title={t('apiKeys.emptyTitle')} description={t('apiKeys.emptyDescription')} />
        ) : (
          <KnowledgeDataTable
            rows={props.items}
            rowKey={(row) => row.id}
            caption={t('apiKeys.list')}
            empty={t('apiKeys.emptyTitle')}
            columns={[
              { key: 'name', label: t('apiKeys.name'), render: (row) => row.name },
              {
                key: 'prefix',
                label: t('apiKeys.prefix'),
                render: (row) => <span className="mono">{row.keyPrefix}…</span>,
              },
              { key: 'scopes', label: t('apiKeys.scopes'), render: (row) => row.scopes.join(', ') },
              {
                key: 'spaces',
                label: t('apiKeys.spaceScope'),
                render: (row) =>
                  row.spaceIds.length === 0 ? t('apiKeys.workspaceWide') : row.spaceIds.join(', '),
              },
              {
                key: 'status',
                label: t('apiKeys.status'),
                render: (row) => (
                  <StatusTag
                    value={row.status}
                    tone={
                      row.status === 'active'
                        ? 'success'
                        : row.status === 'rotated'
                          ? 'warning'
                          : 'danger'
                    }
                  />
                ),
              },
              {
                key: 'expiry',
                label: t('apiKeys.expiresAt'),
                render: (row) => row.expiresAt?.slice(0, 10) ?? t('apiKeys.noExpiry'),
              },
              {
                key: 'actions',
                label: t('common.actions'),
                render: (row) => (
                  <Flex gap={2}>
                    <Button
                      size="xs"
                      disabled={row.status !== 'active' || props.busy}
                      onClick={() => props.onRotate(row)}
                    >
                      {t('apiKeys.rotate')}
                    </Button>
                    <Button
                      size="xs"
                      tone="danger"
                      disabled={row.status === 'revoked' || props.busy}
                      onClick={() => props.onRevoke(row)}
                    >
                      {t('apiKeys.revoke')}
                    </Button>
                  </Flex>
                ),
              },
            ]}
          />
        )}
      </Section>
    </>
  );
}
