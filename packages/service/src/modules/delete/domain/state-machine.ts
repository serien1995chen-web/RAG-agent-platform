import { ApiErrorException, createApiError } from '@kb/contracts';
import type { DeleteJobState } from '../../../ports/types';

/** 删除清理阶段固定顺序（设计文档 7.9 / 14.6）。 */
export const DELETE_STAGES = ['mongo', 'vector', 's3', 'verify'] as const;

/** 终态判定：completed 与 failed 均不再处于清理推进中。 */
export function isTerminalState(state: DeleteJobState): boolean {
  return state === 'completed' || state === 'failed';
}

/**
 * 阶段守卫：只允许按 DELETE_STAGES 顺序前进；回退或未知阶段抛 501005，
 * params 固定为 {taskId, from, to}。
 */
export function assertStageOrder(from: string, to: string, taskId = ''): void {
  const fromIndex = DELETE_STAGES.indexOf(from as (typeof DELETE_STAGES)[number]);
  const toIndex = DELETE_STAGES.indexOf(to as (typeof DELETE_STAGES)[number]);
  if (fromIndex < 0 || toIndex < 0 || toIndex <= fromIndex) {
    throw new ApiErrorException(
      createApiError({
        code: 501005,
        requestId: taskId === '' ? 'delete-stage' : taskId,
        params: { taskId, from, to },
      }),
    );
  }
}

/** 人工重试仅允许 failed → queued（设计文档 8.12 / 14.6）。 */
export function canRetryDeleteJob(state: DeleteJobState): boolean {
  return state === 'failed';
}
