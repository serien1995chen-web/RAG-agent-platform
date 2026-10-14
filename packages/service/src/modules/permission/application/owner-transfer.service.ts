import { ApiErrorException, createApiError } from '@kb/contracts';
import type { IdempotencyStore } from '@kb/dal';
import { createHash } from 'node:crypto';
import type {
  AuditPort,
  DatasetNotificationPort,
  PermissionSnapshotValue,
  TransferDatasetOwnerPort,
} from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

export interface OwnerTransferStore {
  transfer(
    input: { datasetId: string; targetTmbId: string; transferId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ before: PermissionSnapshotValue; after: PermissionSnapshotValue }>;
}

export interface OwnerTransferServiceDeps {
  store: OwnerTransferStore;
  idempotency: IdempotencyStore;
  audit?: AuditPort;
  notifications?: DatasetNotificationPort;
  resolveMemberTeamId?: (tmbId: string) => Promise<string | null>;
}

/**
 * 设计 13.4：Owner 转移编排。
 * transferId 幂等（24h，存储 before/after 供重放）、跨团队目标校验（拒绝写 Audit）、
 * 存储层委托 OwnerTransferStore（事务由 D7-A 适配器承担）；审计/通知 best-effort。
 */
export class OwnerTransferService implements TransferDatasetOwnerPort {
  constructor(private readonly deps: OwnerTransferServiceDeps) {}

  private async afterChange(
    datasetId: string,
    targetTmbId: string,
    transferId: string,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.deps.audit?.append(
        {
          eventId: `dataset.acl.owner_changed:${datasetId}:${transferId}`,
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
      // best-effort
    }
    try {
      await this.deps.notifications?.onDatasetChange(
        {
          notificationId: `permission.changed:${datasetId}:${transferId}`,
          teamId: context.tenant.teamId,
          kind: 'permission.changed',
          payload: { datasetId, targetTmbId },
        },
        context,
      );
    } catch {
      // best-effort
    }
  }

  async transfer(
    input: { datasetId: string; targetTmbId: string; transferId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ before: PermissionSnapshotValue; after: PermissionSnapshotValue }> {
    if (this.deps.resolveMemberTeamId) {
      const targetTeam = await this.deps.resolveMemberTeamId(input.targetTmbId);
      if (targetTeam !== null && targetTeam !== context.tenant.teamId) {
        try {
          await this.deps.audit?.append(
            {
              eventId: `dataset.acl.owner_transfer_rejected:${input.datasetId}:${input.transferId}`,
              teamId: context.tenant.teamId,
              actorTmbId: context.tenant.tmbId,
              resourceType: 'dataset',
              resourceId: input.datasetId,
              operation: 'dataset.acl.owner_transfer_rejected',
              requestId: context.requestId,
              payload: { targetTmbId: input.targetTmbId },
            },
            context,
          );
        } catch {
          // best-effort
        }
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'tmbId', resourceId: input.targetTmbId },
          }),
        );
      }
    }

    const scope = `kb:owner-transfer:${context.tenant.teamId}:${input.datasetId}:${input.transferId}`;
    const requestHash = createHash('sha256')
      .update(`${input.datasetId}|${input.targetTmbId}|${input.transferId}`)
      .digest('hex');
    const begun = await this.deps.idempotency.begin(scope, requestHash);
    if (begun.kind === 'replay') {
      return begun.record.response as {
        before: PermissionSnapshotValue;
        after: PermissionSnapshotValue;
      };
    }
    if (begun.kind === 'conflict') {
      throw new ApiErrorException(
        createApiError({
          code: 501047,
          requestId: context.requestId,
          params: { datasetId: input.datasetId, expectedVersion: -1 },
        }),
      );
    }

    try {
      const result = await this.deps.store.transfer(input, context);
      await this.deps.idempotency.complete(scope, result);
      await this.afterChange(input.datasetId, input.targetTmbId, input.transferId, context);
      return result;
    } catch (error) {
      try {
        await this.deps.idempotency.fail(scope);
      } catch {
        // 清理失败忽略，原样抛出 store 错误。
      }
      throw error;
    }
  }
}

export function createOwnerTransferService(deps: OwnerTransferServiceDeps): OwnerTransferService {
  return new OwnerTransferService(deps);
}
