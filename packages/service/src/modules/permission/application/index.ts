import type { RequestContext } from '../../../ports/types';
import type { DatasetPermissionPort } from '../../../ports/capabilities';
import type { PortCallOptions } from '../../../ports/types';
import type { PermissionSnapshotValue } from '../../../ports/capabilities';

export interface PermissionServiceDeps {
  repository: DatasetPermissionPort;
}

/** DatasetAcl 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class PermissionApplicationService {
  constructor(private readonly deps: PermissionServiceDeps) {}

  getPermission(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    return this.deps.repository.getPermission(input, context);
  }

  resumeInherit(
    input: { datasetId: string; version: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    return this.deps.repository.resumeInherit(input, context);
  }

  updateCollaborators(
    input: {
      datasetId: string;
      expectedVersion: number;
      collaborators: Parameters<DatasetPermissionPort['updateCollaborators']>[0]['collaborators'];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    return this.deps.repository.updateCollaborators(input, context);
  }
}
