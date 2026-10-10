import { ApiErrorException, createApiError } from '@kb/contracts';
import type { RequestContext } from '../../../ports/types';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { ProcessingJobSnapshot } from '../../../ports/types';

const PROCESSING_LEASE_TOKEN = Symbol('processingLeaseToken');

interface ProcessingLeaseToken {
  taskId: string;
  lockTime: string;
}

interface ProcessingLeaseAwareRepository {
  finishWithLease(
    input: {
      taskId: string;
      lockTime: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  resumeTask(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }>;
}

type ProcessingContext = RequestContext & {
  [PROCESSING_LEASE_TOKEN]?: ProcessingLeaseToken;
};

function hasLeaseCapabilities(
  repository: ProcessingJobRepository,
): repository is ProcessingJobRepository & ProcessingLeaseAwareRepository {
  const candidate = repository as Partial<ProcessingLeaseAwareRepository>;
  return (
    typeof candidate.finishWithLease === 'function' && typeof candidate.resumeTask === 'function'
  );
}

export interface ProcessingServiceDeps {
  repository: ProcessingJobRepository;
}

/** ProcessingJob 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class ProcessingApplicationService {
  constructor(private readonly deps: ProcessingServiceDeps) {}

  enqueueJob(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    return this.deps.repository.enqueue(input, context);
  }

  claimJob(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; lockTime: string }> {
    return this.deps.repository.claim(input, context).then((claimed) => {
      (context as ProcessingContext)[PROCESSING_LEASE_TOKEN] = {
        taskId: claimed.taskId,
        lockTime: claimed.lockTime,
      };
      return claimed;
    });
  }

  renewJob(
    input: { taskId: string; lockTime: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ lockTime: string }> {
    return this.deps.repository.renew(input, context).then((renewed) => {
      const processingContext = context as ProcessingContext;
      if (processingContext[PROCESSING_LEASE_TOKEN]?.taskId === input.taskId) {
        processingContext[PROCESSING_LEASE_TOKEN] = {
          taskId: input.taskId,
          lockTime: renewed.lockTime,
        };
      }
      return renewed;
    });
  }

  finishJob(
    input: {
      taskId: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    const processingContext = context as ProcessingContext;
    const token = processingContext[PROCESSING_LEASE_TOKEN];
    const repository = this.deps.repository;
    const finish =
      token?.taskId === input.taskId && hasLeaseCapabilities(repository)
        ? repository.finishWithLease(
            {
              taskId: input.taskId,
              lockTime: token.lockTime,
              state: input.state,
              ...(input.errorMsg !== undefined ? { errorMsg: input.errorMsg } : {}),
              options: input.options,
            },
            context,
          )
        : repository.finish(input, context);

    return finish.finally(() => {
      if (processingContext[PROCESSING_LEASE_TOKEN]?.taskId === input.taskId) {
        delete processingContext[PROCESSING_LEASE_TOKEN];
      }
    });
  }

  resumeJob(
    input: { taskId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }> {
    const repository = this.deps.repository;
    if (!hasLeaseCapabilities(repository)) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: input.taskId, from: 'final_error', to: 'resume' },
        }),
      );
    }
    return repository.resumeTask(input, context);
  }
}
