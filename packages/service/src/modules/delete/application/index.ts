import type { RequestContext } from '../../../ports/types';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type { DeleteJobSnapshot, PageResult, PortCallOptions } from '../../../ports/types';

export interface DeleteServiceDeps {
  repository: DeleteJobRepository;
}

/** DeleteJob 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class DeleteApplicationService {
  constructor(private readonly deps: DeleteServiceDeps) {}

  getDeleteJob(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot> {
    return this.deps.repository.get(input, context);
  }

  listFailures(
    input: { jobId: string; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<{ resourceType: string; resourceId: string; reason: string }>> {
    return this.deps.repository.listFailures(input, context);
  }

  retryJob(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }> {
    return this.deps.repository.retry(input, context);
  }
}
