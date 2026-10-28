import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const JOB_STATES = [
  'queued',
  'leased',
  'running',
  'retry_wait',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
  'dead_letter',
  'succeeded',
] as const;

export type JobState = (typeof JOB_STATES)[number];

const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['leased', 'paused', 'cancelling', 'cancelled'],
  leased: ['running', 'retry_wait', 'cancelling'],
  running: ['succeeded', 'retry_wait', 'failed', 'paused', 'cancelling'],
  retry_wait: ['queued', 'paused', 'cancelling', 'failed'],
  paused: ['queued', 'cancelling'],
  cancelling: ['cancelled', 'failed'],
  cancelled: [],
  failed: ['dead_letter', 'queued'],
  dead_letter: ['queued'],
  succeeded: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertJobTransition(
  from: JobState,
  to: JobState,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): void {
  if (!canTransitionJob(from, to)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_JOB_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { from, to, stateMachine: 'job' },
    });
  }
}
