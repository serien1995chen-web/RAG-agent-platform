import type { RequestContext } from '../../../ports/types';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { DeleteJobSnapshot } from '../../../ports/types';

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
}
