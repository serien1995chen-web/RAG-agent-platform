import { describe, expect, it } from 'vitest';
import {
  assertJobTransition,
  canTransitionJob,
  JOB_STATES,
  type JobState,
} from '../../src/modules/knowledge/domain/job-state';
import { projectFullText } from '../../src/modules/knowledge/adapter/s06-jieba.tokenizer';

const context = { requestId: 'req-s6', traceId: 'trace-s6' };

describe('S6 Job state and full-text projection', () => {
  it('L1-B13-A-TRAIN-001-S02 applies the complete job transition matrix and blocks terminal regression', () => {
    const allowed: Record<JobState, readonly JobState[]> = {
      queued: ['leased', 'paused', 'cancelling', 'cancelled'],
      leased: ['running', 'retry_wait', 'cancelling'],
      running: ['succeeded', 'retry_wait', 'failed', 'paused', 'cancelling'],
      retry_wait: ['queued', 'cancelling', 'failed'],
      paused: ['queued', 'cancelling'],
      cancelling: ['cancelled', 'failed'],
      cancelled: [],
      failed: ['dead_letter', 'queued'],
      dead_letter: ['queued'],
      succeeded: [],
    };
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        expect(canTransitionJob(from, to), `${from} -> ${to}`).toBe(allowed[from].includes(to));
      }
    }
    for (const terminal of ['cancelled', 'succeeded'] as const) {
      for (const to of JOB_STATES) {
        expect(canTransitionJob(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
    expect(() => assertJobTransition('leased', 'succeeded', context)).toThrow();
    expect(() => assertJobTransition('failed', 'dead_letter', context)).not.toThrow();
    expect(() => assertJobTransition('dead_letter', 'queued', context)).not.toThrow();
    expect(() => assertJobTransition('cancelling', 'cancelled', context)).not.toThrow();
  });

  it('supports control, retry, replay and rejects terminal regression', () => {
    expect(canTransitionJob('queued', 'leased')).toBe(true);
    expect(canTransitionJob('leased', 'running')).toBe(true);
    expect(canTransitionJob('running', 'paused')).toBe(true);
    expect(canTransitionJob('paused', 'queued')).toBe(true);
    expect(canTransitionJob('retry_wait', 'paused')).toBe(false);
    expect(canTransitionJob('failed', 'queued')).toBe(true);
    expect(canTransitionJob('dead_letter', 'queued')).toBe(true);
    expect(canTransitionJob('succeeded', 'queued')).toBe(false);
    expect(() => assertJobTransition('succeeded', 'running', context)).toThrow();
  });

  it('projects deterministic jieba tokens and versions', () => {
    const input = {
      segmentId: '65f1e5b2a1c9d4b7e8f01234',
      sourceVersion: 2,
      indexVersion: 5,
      question: '退款多久到账？',
      answer: 'Refund processing takes five days.',
      content: '退款退款 Refund processing',
      title: '支付',
      searchEnabled: true,
    };
    const first = projectFullText(input);
    const second = projectFullText(input);
    expect(first.fullTextTokens.length).toBeGreaterThan(0);
    expect(first.fullTextVersion).toBe(5);
    expect(second).toEqual(first);
    expect(first.tokenizerVersion).toContain('2.0.1');
  });

  it('L1-B13-B-TRAIN-005-N02 rejects regression from every terminal state', () => {
    for (const terminal of ['succeeded', 'cancelled', 'failed', 'dead_letter'] as const) {
      expect(canTransitionJob(terminal, 'running'), terminal).toBe(false);
      expect(canTransitionJob(terminal, 'queued'), terminal).toBe(
        terminal === 'failed' || terminal === 'dead_letter',
      );
    }
  });

  it('L1-B13-B-TRAIN-007-N01 permits pause only from queued or running', () => {
    expect(canTransitionJob('queued', 'paused')).toBe(true);
    expect(canTransitionJob('running', 'paused')).toBe(true);
    expect(canTransitionJob('paused', 'paused')).toBe(false);
    expect(canTransitionJob('retry_wait', 'paused')).toBe(false);
    expect(canTransitionJob('succeeded', 'paused')).toBe(false);
    expect(canTransitionJob('dead_letter', 'paused')).toBe(false);
  });
});
