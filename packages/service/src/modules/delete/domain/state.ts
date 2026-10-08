import { ApiErrorException, createApiError } from '@kb/contracts';
import type { DeleteJobState } from '../../../ports/types';

const TRANSITIONS: Readonly<Record<DeleteJobState, readonly DeleteJobState[]>> = {
  marked: ['queued'],
  queued: ['deleting', 'failed'],
  deleting: ['completed', 'failed'],
  completed: [],
  failed: ['queued'],
};

export function canTransition(from: DeleteJobState, to: DeleteJobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: DeleteJobState,
  to: DeleteJobState,
  requestId = 'delete-job',
): void {
  if (!canTransition(from, to)) {
    throw new ApiErrorException(
      createApiError({
        code: 501005,
        requestId,
        params: { taskId: '', from, to },
      }),
    );
  }
}
