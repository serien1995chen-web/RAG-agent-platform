import { describe, expect, it } from 'vitest';
import {
  assertJobTransition,
  canTransitionJob,
} from '../../src/modules/knowledge/domain/job-state';
import { projectFullText } from '../../src/modules/knowledge/adapter/s06-jieba.tokenizer';

const context = { requestId: 'req-s6', traceId: 'trace-s6' };

describe('S6 Job state and full-text projection', () => {
  it('supports control, retry, replay and rejects terminal regression', () => {
    expect(canTransitionJob('queued', 'leased')).toBe(true);
    expect(canTransitionJob('leased', 'running')).toBe(true);
    expect(canTransitionJob('running', 'paused')).toBe(true);
    expect(canTransitionJob('paused', 'queued')).toBe(true);
    expect(canTransitionJob('retry_wait', 'paused')).toBe(true);
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
});
