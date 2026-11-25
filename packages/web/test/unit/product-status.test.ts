import { describe, expect, it } from 'vitest';
import {
  jobStageLabel,
  jobStatusView,
  sourceStatusView,
} from '../../src/product/dataset-detail-state';

describe('product status localization', () => {
  it('maps source and job states to business labels', () => {
    expect(sourceStatusView('ready').label).toBe('已就绪');
    expect(sourceStatusView('succeeded').label).not.toBe('succeeded');
    expect(jobStatusView('succeeded')).toEqual({ label: '已完成', tone: 'success' });
    expect(jobStatusView('retry_wait').label).toBe('等待重试');
    expect(jobStatusView('cancelling').label).toBe('取消中');
    expect(sourceStatusView('completed').label).toBe('已完成');
    expect(jobStatusView('unexpected-raw-value').label).toBe('未知状态');
    expect(jobStageLabel('unexpected-step')).toBe('处理中');
    expect(jobStageLabel('persist-segments')).toBe('保存分块');
  });
});
