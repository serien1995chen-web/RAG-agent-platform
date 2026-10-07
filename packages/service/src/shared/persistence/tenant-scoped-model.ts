import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Model } from 'mongoose';
import type { RequestContext } from '../../ports/types';
import { validateTenantContext } from '../../ports/types';

interface TenantScopedDoc {
  teamId?: Types.ObjectId | string | null;
}

export interface TenantScopedModel<TDoc> {
  model: Model<TDoc>;
  teamId: Types.ObjectId;
  /** 组合查询条件；调用方传入的 teamId 会被强制覆盖为当前租户。 */
  filter(extra?: Record<string, unknown>): Record<string, unknown>;
  /** 文档为空或不属于当前租户时抛 501070，不泄露资源是否存在。 */
  assertOwned(doc: TDoc | null | undefined, resourceType?: string): TDoc;
}

/**
 * 租户作用域助手（设计文档 7.6 / 13.2 / 18.7）：
 * Port 入口必须重新校验租户上下文，所有查询强制携带 teamId。
 */
export function tenantScopedModel<TDoc extends TenantScopedDoc>(
  model: Model<TDoc>,
  context: RequestContext,
): TenantScopedModel<TDoc> {
  const result = validateTenantContext(context.tenant, context.requestId);
  if (!result.ok) throw new ApiErrorException(result.error);

  const rawTeamId = context.tenant.teamId;
  if (!Types.ObjectId.isValid(rawTeamId)) {
    throw new ApiErrorException(
      createApiError({
        code: 501012,
        requestId: context.requestId,
        params: { missing: ['teamId'] },
      }),
    );
  }
  const teamId = new Types.ObjectId(rawTeamId);

  return {
    model,
    teamId,
    filter(extra: Record<string, unknown> = {}): Record<string, unknown> {
      return { ...extra, teamId };
    },
    assertOwned(doc: TDoc | null | undefined, resourceType = 'resource'): TDoc {
      if (
        doc === null ||
        doc === undefined ||
        doc.teamId === null ||
        doc.teamId === undefined ||
        String(doc.teamId) !== String(teamId)
      ) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType, resourceId: '' },
          }),
        );
      }
      return doc;
    },
  };
}
