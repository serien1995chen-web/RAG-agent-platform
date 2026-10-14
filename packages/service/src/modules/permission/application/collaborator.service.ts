import { ApiErrorException, createApiError } from '@kb/contracts';
import type {
  AuditPort,
  CollaboratorPermission,
  DatasetNotificationPort,
  DatasetPermissionPort,
  PermissionSnapshotValue,
  UpdateDatasetCollaboratorsPort,
} from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

export interface CollaboratorServiceDeps {
  repository: DatasetPermissionPort;
  audit?: AuditPort;
  notifications?: DatasetNotificationPort;
}

/**
 * 设计 13.4 / 13.5：协作者更新编排。
 * 版本 CAS 冲突（501067）读取最新版本重算，最多 3 次；超限返回 501047（retryable）；
 * 最后 Owner 保护（501008）原样抛出；审计/通知在成功后 best-effort，失败不回滚。
 */
export class CollaboratorService implements UpdateDatasetCollaboratorsPort {
  constructor(private readonly deps: CollaboratorServiceDeps) {}

  async list(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ list: CollaboratorPermission[] }> {
    const snapshot = await this.deps.repository.getPermission(
      { datasetId: input.datasetId, options: input.options },
      context,
    );
    return { list: snapshot.collaboratorSummary ?? [] };
  }

  private async afterChange(
    datasetId: string,
    result: PermissionSnapshotValue,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.deps.audit?.append(
        {
          eventId: `dataset.acl.collaborators_changed:${datasetId}:${result.version}`,
          teamId: context.tenant.teamId,
          actorTmbId: context.tenant.tmbId,
          resourceType: 'dataset',
          resourceId: datasetId,
          operation: 'permission.changed',
          requestId: context.requestId,
        },
        context,
      );
    } catch {
      // best-effort：审计失败不回滚已提交的 ACL 变更。
    }
    try {
      await this.deps.notifications?.onDatasetChange(
        {
          notificationId: `permission.changed:${datasetId}:${result.version}`,
          teamId: context.tenant.teamId,
          kind: 'permission.changed',
          payload: { datasetId },
        },
        context,
      );
    } catch {
      // best-effort：通知失败不回滚、不改变响应成功。
    }
  }

  async update(
    input: {
      datasetId: string;
      expectedVersion: number;
      collaborators: CollaboratorPermission[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PermissionSnapshotValue> {
    let attempt = 0;
    let expectedVersion = input.expectedVersion;
    while (attempt < 3) {
      attempt += 1;
      try {
        const result = await this.deps.repository.updateCollaborators(
          {
            datasetId: input.datasetId,
            expectedVersion,
            collaborators: input.collaborators,
            options: input.options,
          },
          context,
        );
        await this.afterChange(input.datasetId, result, context);
        return result;
      } catch (error) {
        const isConflict = error instanceof ApiErrorException && error.error.code === 501067;
        if (isConflict && attempt < 3) {
          const latest = await this.deps.repository.getPermission(
            { datasetId: input.datasetId, options: input.options },
            context,
          );
          expectedVersion = latest.version;
          continue;
        }
        if (isConflict) {
          throw new ApiErrorException(
            createApiError({
              code: 501047,
              requestId: context.requestId,
              params: { datasetId: input.datasetId, expectedVersion },
            }),
          );
        }
        throw error;
      }
    }
    throw new ApiErrorException(
      createApiError({
        code: 501047,
        requestId: context.requestId,
        params: { datasetId: input.datasetId, expectedVersion },
      }),
    );
  }
}

export function createCollaboratorService(deps: CollaboratorServiceDeps): CollaboratorService {
  return new CollaboratorService(deps);
}
