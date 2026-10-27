'use client';

import { Box, Code, Flex, Heading, Stack, Text } from '@chakra-ui/react';
import { Button, StatusTag } from './knowledge-primitives';
import { useKnowledgeI18n } from '../i18n';

export type S6JobAction = 'retry' | 'cancel' | 'pause' | 'resume' | 'replay';

export interface S6JobView {
  jobId: string;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  attemptEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  progress: Record<string, unknown>;
  steps: Array<{
    stepKey: string;
    status: string;
    attempts: number;
    externalEvidence: Record<string, unknown> | null;
  }>;
  error: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  version: number;
}

export function jobActionsFor(status: string, isAdmin: boolean): S6JobAction[] {
  const actions: S6JobAction[] = [];
  if (status === 'failed' || status === 'dead_letter') actions.push('retry');
  if (['queued', 'leased', 'running', 'paused', 'retry_wait'].includes(status))
    actions.push('cancel');
  if (status === 'queued' || status === 'running') actions.push('pause');
  if (status === 'paused') actions.push('resume');
  if (status === 'dead_letter' && isAdmin) actions.push('replay');
  return actions;
}

export function S6JobsPanel(props: {
  job: S6JobView;
  isAdmin: boolean;
  busy?: boolean;
  onAction: (action: S6JobAction) => void;
}) {
  const { t } = useKnowledgeI18n();
  const actions = jobActionsFor(props.job.status, props.isAdmin);
  return (
    <Box className="s6-job-panel" borderTopWidth="1px" borderColor="kn.line" pt={5} mt={4}>
      <Flex justify="space-between" align="flex-start" gap={4} wrap="wrap">
        <Box minW={0}>
          <Heading as="h3" m={0} fontSize="md">
            {t('s6.jobs.detailTitle', { id: props.job.jobId })}
          </Heading>
          <Text m={0} mt={1} color="kn.inkMuted" fontSize="sm">
            {t('s6.jobs.lease', {
              owner: props.job.leaseOwner ?? t('s6.jobs.none'),
              epoch: props.job.attemptEpoch,
            })}
          </Text>
        </Box>
        <Flex gap={2} wrap="wrap">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              tone={action === 'cancel' ? 'danger' : 'secondary'}
              busy={props.busy}
              onClick={() => props.onAction(action)}
            >
              {t(`s6.jobs.action.${action}` as `s6.jobs.action.${S6JobAction}`)}
            </Button>
          ))}
        </Flex>
      </Flex>
      <Stack spacing={2} mt={4}>
        {props.job.steps.length === 0 ? (
          <Text m={0} color="kn.inkMuted" fontSize="sm">
            {t('s6.jobs.noSteps')}
          </Text>
        ) : (
          props.job.steps.map((step) => (
            <Flex key={step.stepKey} gap={3} align="center" wrap="wrap">
              <Code>{step.stepKey}</Code>
              <StatusTag value={step.status} />
              <Text m={0} fontSize="xs" color="kn.inkMuted">
                {t('s6.jobs.attemptCount', { count: step.attempts })}
              </Text>
            </Flex>
          ))
        )}
      </Stack>
      {props.job.error ? (
        <Code display="block" mt={3} p={2} whiteSpace="pre-wrap" overflowWrap="anywhere">
          {JSON.stringify(props.job.error, null, 2)}
        </Code>
      ) : null}
    </Box>
  );
}
