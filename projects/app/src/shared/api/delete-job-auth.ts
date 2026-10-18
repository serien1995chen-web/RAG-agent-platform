import type { DeleteJobSnapshot, RequestContext } from '@kb/service';

/**
 * 删除任务读取/重试的鉴权（DEMO-001 修复）。
 *
 * 不能复用 `datasetPermission.getPermission`：Dataset 一旦软删除，
 * ACL 仓库按 `deleteTime: null` 过滤即查不到，导致删除任务永远 404。
 * 这里改为按任务自身记录的归属判断（提交者 / Owner），并对 Root 放行。
 */
export function isDeleteJobVisibleTo(
  job: Pick<DeleteJobSnapshot, 'actorTmbId' | 'ownerTmbId'>,
  context: RequestContext,
): boolean {
  if (context.tenant.isRoot) return true;
  return job.actorTmbId === context.tenant.tmbId || job.ownerTmbId === context.tenant.tmbId;
}
