'use client';

import { Box, Flex, SimpleGrid } from '@chakra-ui/react';
import { useState } from 'react';
import type { S10AuditList } from '../client/s10-ops-client';
import { useKnowledgeI18n } from '../i18n';
import { KnowledgeDataTable } from './data-table';
import {
  Button,
  EmptyState,
  Field,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
  TextInput,
} from './knowledge-primitives';

export interface S10AuditFilters {
  action: string;
  actor: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  from: string;
  to: string;
}

export function S10AuditPanel(props: {
  data?: S10AuditList;
  loading: boolean;
  error: unknown;
  filters: S10AuditFilters;
  onFilters: (filters: S10AuditFilters) => void;
  onRetry: () => void;
}) {
  const { t } = useKnowledgeI18n();
  const [draft, setDraft] = useState(props.filters);
  if (props.error) {
    return <ProblemNotice error={props.error as Error} onRetry={props.onRetry} />;
  }
  return (
    <>
      <Section title={t('audit.filters')} meta={t('audit.filtersMeta')}>
        <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} spacing={3}>
          <Field label={t('audit.action')}>
            <TextInput
              value={draft.action}
              onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            />
          </Field>
          <Field label={t('audit.actor')}>
            <TextInput
              value={draft.actor}
              onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            />
          </Field>
          <Field label={t('audit.resourceType')}>
            <TextInput
              value={draft.resourceType}
              onChange={(event) => setDraft({ ...draft, resourceType: event.target.value })}
            />
          </Field>
          <Field label={t('audit.resourceId')}>
            <TextInput
              value={draft.resourceId}
              onChange={(event) => setDraft({ ...draft, resourceId: event.target.value })}
            />
          </Field>
          <Field label={t('audit.outcome')}>
            <SelectInput
              value={draft.outcome}
              onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}
            >
              <option value="">{t('audit.allOutcomes')}</option>
              <option value="allowed">allowed</option>
              <option value="denied">denied</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
            </SelectInput>
          </Field>
          <Field label={t('audit.from')}>
            <TextInput
              type="datetime-local"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </Field>
          <Field label={t('audit.to')}>
            <TextInput
              type="datetime-local"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </Field>
          <Flex align="end" gap={2}>
            <Button tone="primary" onClick={() => props.onFilters(draft)}>
              {t('audit.apply')}
            </Button>
            <Button
              onClick={() => {
                const empty = {
                  action: '',
                  actor: '',
                  resourceType: '',
                  resourceId: '',
                  outcome: '',
                  from: '',
                  to: '',
                };
                setDraft(empty);
                props.onFilters(empty);
              }}
            >
              {t('audit.clear')}
            </Button>
          </Flex>
        </SimpleGrid>
      </Section>
      <Section title={t('audit.events')} meta={t('audit.eventsMeta')}>
        {props.loading ? (
          <Box className="loading-block">{t('common.loading')}</Box>
        ) : (props.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={t('audit.emptyTitle')} description={t('audit.emptyDescription')} />
        ) : (
          <KnowledgeDataTable
            rows={props.data?.items ?? []}
            rowKey={(row) => row.eventId}
            caption={t('audit.events')}
            empty={t('audit.emptyTitle')}
            columns={[
              {
                key: 'occurredAt',
                label: t('audit.occurredAt'),
                render: (row) => <span className="mono">{row.occurredAt}</span>,
              },
              { key: 'action', label: t('audit.action'), render: (row) => row.action },
              { key: 'actor', label: t('audit.actor'), render: (row) => row.actorMemberId },
              {
                key: 'resource',
                label: t('audit.resource'),
                render: (row) => `${row.resourceType}:${row.resourceId}`,
              },
              {
                key: 'outcome',
                label: t('audit.outcome'),
                render: (row) => (
                  <StatusTag
                    value={row.outcome}
                    tone={
                      row.outcome === 'failed' || row.outcome === 'denied'
                        ? 'danger'
                        : row.outcome === 'succeeded'
                          ? 'success'
                          : 'neutral'
                    }
                  />
                ),
              },
              {
                key: 'trace',
                label: t('audit.trace'),
                render: (row) => <span className="mono">{row.traceId.slice(0, 16)}</span>,
              },
            ]}
          />
        )}
      </Section>
    </>
  );
}
