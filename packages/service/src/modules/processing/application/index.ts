import type { RequestContext } from '../../../ports/types';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { ProcessingJobSnapshot } from '../../../ports/types';

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
}
