import { describe, expect, it } from 'vitest';
import { jobActionsFor } from '../../src/components/s6-jobs-panel';
import { sourceStatusView } from '../../src/product/dataset-detail-state';

describe('B13B Job control UI state', () => {
  it('L1-B13-B-TRAIN-007-UI01 exposes only legal pause resume cancel and replay actions', () => {
    expect(jobActionsFor('queued', false)).toEqual(['cancel', 'pause']);
    expect(jobActionsFor('running', false)).toEqual(['cancel', 'pause']);
    expect(jobActionsFor('paused', false)).toEqual(['cancel', 'resume']);
    expect(jobActionsFor('retry_wait', false)).toEqual(['cancel']);
    expect(jobActionsFor('failed', false)).toEqual(['retry']);
    expect(jobActionsFor('dead_letter', false)).toEqual(['retry']);
    expect(jobActionsFor('dead_letter', true)).toEqual(['retry', 'replay']);
  });

  it('L1-B13-B-TRAIN-005-UI01 terminal Jobs expose no mutation action', () => {
    for (const status of ['succeeded', 'cancelled', 'cancelling']) {
      expect(jobActionsFor(status, true), status).toEqual([]);
    }
  });

  it('L1-B13-B-TRAIN-007-N01 retry_wait and blocked work are never displayed as ready', () => {
    expect(sourceStatusView('retry_wait')).toEqual({ label: '等待重试', tone: 'warning' });
    expect(sourceStatusView('blocked')).toEqual({ label: '系统阻塞', tone: 'warning' });
    expect(sourceStatusView('paused')).not.toMatchObject({ label: '已就绪' });
    expect(sourceStatusView('failed')).toEqual({ label: '训练异常', tone: 'danger' });
  });
});
